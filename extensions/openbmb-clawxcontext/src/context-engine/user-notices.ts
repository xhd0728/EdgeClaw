import { getMessageRole, getMessageText } from "./transcript-index.js";
import type {
  ContextMessage,
  PendingUserNotice,
  RuleMatchSource,
  UserNoticeLanguage,
  UserNoticeSource,
} from "./types.js";

const DIAGNOSTICS_TOOL_PATTERN = /\bcontext_(inspect|suggest)\b/i;

const USER_NOTICE_PRIORITY: Record<UserNoticeSource, PendingUserNotice["priority"]> = {
  "overflow-recovery": 1,
  compaction: 2,
  "stale-read": 3,
  "path-rule": 4,
};

function isChineseLike(text: string): boolean {
  return /[\u3400-\u9fff]/u.test(text);
}

export function buildPendingUserNotice(params: {
  key: string;
  source: UserNoticeSource;
  createdAt?: string;
}): PendingUserNotice {
  return {
    key: params.key,
    source: params.source,
    priority: USER_NOTICE_PRIORITY[params.source],
    createdAt: params.createdAt ?? new Date().toISOString(),
  };
}

export function detectUserNoticeLanguage(messages: readonly ContextMessage[]): UserNoticeLanguage {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || getMessageRole(message) !== "user") continue;
    const text = getMessageText(message).trim();
    if (!text) continue;
    return isChineseLike(text) ? "zh" : "en";
  }
  return "en";
}

export function isDiagnosticsOnlyTurn(messages: readonly ContextMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || getMessageRole(message) !== "user") continue;
    const text = getMessageText(message).trim();
    if (!text) return false;
    return DIAGNOSTICS_TOOL_PATTERN.test(text);
  }
  return false;
}

export function buildUserNoticeMessage(
  source: UserNoticeSource,
  language: UserNoticeLanguage,
): string {
  if (language === "zh") {
    switch (source) {
      case "overflow-recovery":
        return "我已切换到更激进的上下文恢复模式，会尽量保持当前任务连续。";
      case "compaction":
        return "我刚完成一次上下文压缩，会继续按当前任务线处理。";
      case "stale-read":
        return "我已将相关文件的旧读取结果视为过期，后续以最新内容为准。";
      case "path-rule":
        return "我已应用当前文件范围内的项目规则，下面按这些规则继续。";
    }
  }

  switch (source) {
    case "overflow-recovery":
      return "I switched into a more aggressive context recovery mode and will keep the current task line intact as much as possible.";
    case "compaction":
      return "I just completed a context compaction and will continue along the current task line.";
    case "stale-read":
      return "I marked the earlier file read as outdated and will use the latest content from here.";
    case "path-rule":
      return "I applied the project rules for the current file scope and will continue under them.";
  }
}

export function buildUserNoticeInstruction(message: string): string {
  return [
    "ClawXContext required one-time user notice for this run:",
    `The first sentence of your next normal text reply MUST be exactly: "${message}"`,
    "If you emit only tool calls first, wait and use that exact sentence before the first user-facing text reply instead.",
    "After that first sentence, continue normally and do not repeat the notice again.",
  ].join("\n");
}

export function buildPathRuleNoticeKey(ruleMatches: RuleMatchSource[]): string | undefined {
  if (ruleMatches.length === 0) return undefined;
  const fingerprint = ruleMatches
    .map((rule) =>
      [
        rule.origin,
        rule.scope,
        rule.specificity,
        [...rule.matchedBy].sort().join("+"),
      ].join(":"),
    )
    .sort((left, right) => left.localeCompare(right))
    .join("|");
  return fingerprint ? `path-rule:${fingerprint}` : undefined;
}

export function hasDeliverableAssistantText(texts: string[]): boolean {
  return texts.some((text) => {
    const trimmed = text.trim();
    return Boolean(trimmed) && trimmed !== "NO_REPLY";
  });
}

function normalizeNoticeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s"'`“”‘’.,!?;:()[\]{}<>/\\|-]+/g, "")
    .replace(/^(我|已|会|将)+/u, "")
    .replace(/一次/gu, "")
    .trim();
}

function extractFirstDeliverableLine(texts: string[]): string | undefined {
  for (const text of texts) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === "NO_REPLY") continue;
    const [firstLine] = trimmed.split(/\r?\n/, 1);
    return firstLine?.trim() || undefined;
  }
  return undefined;
}

function matchesBySource(source: UserNoticeSource, line: string): boolean {
  const normalized = normalizeNoticeText(line);
  switch (source) {
    case "compaction":
      return (
        normalized.includes("上下文压缩") ||
        (normalized.includes("contextcompaction") && normalized.includes("currenttaskline")) ||
        (normalized.includes("压缩") && normalized.includes("当前任务线"))
      );
    case "overflow-recovery":
      return (
        normalized.includes("上下文恢复模式") ||
        normalized.includes("更激进的上下文恢复") ||
        (normalized.includes("recoverymode") && normalized.includes("currenttask"))
      );
    case "stale-read":
      return (
        (normalized.includes("旧读取结果") && normalized.includes("过期")) ||
        (normalized.includes("outdated") && normalized.includes("latestcontent")) ||
        (normalized.includes("过期") && normalized.includes("最新内容"))
      );
    case "path-rule":
      return (
        normalized.includes("项目规则") ||
        (normalized.includes("projectrules") && normalized.includes("currentscope")) ||
        (normalized.includes("文件范围") && normalized.includes("规则"))
      );
  }
}

export function didAssistantDeliverNotice(params: {
  source: UserNoticeSource;
  expectedMessage: string;
  assistantTexts: string[];
}): boolean {
  const firstLine = extractFirstDeliverableLine(params.assistantTexts);
  if (!firstLine) return false;
  const normalizedLine = normalizeNoticeText(firstLine);
  const normalizedExpected = normalizeNoticeText(params.expectedMessage);
  if (!normalizedLine || !normalizedExpected) return false;
  if (
    normalizedLine.startsWith(normalizedExpected) ||
    normalizedExpected.startsWith(normalizedLine) ||
    normalizedLine.includes(normalizedExpected) ||
    normalizedExpected.includes(normalizedLine)
  ) {
    return true;
  }
  return matchesBySource(params.source, firstLine);
}
