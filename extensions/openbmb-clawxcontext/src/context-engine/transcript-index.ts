import fs from "node:fs/promises";
import type {
  ActiveScopeSignal,
  ContextMessage,
  IndexedToolResult,
  ToolCallRef,
  TranscriptBranchEntry,
  TranscriptCompactionEntry,
  TranscriptGenericEntry,
  TranscriptHeaderEntry,
  TranscriptIndex,
  TranscriptMessageEntry,
} from "./types.js";

const CRITICAL_TOOL_NAMES = new Set([
  "bash",
  "exec",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "search",
  "fetch",
]);
const EDIT_TOOL_NAMES = new Set(["edit", "write", "replace", "patch"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "glob"]);

const PATH_ARGUMENT_KEYS = [
  "path",
  "file",
  "filePath",
  "filepath",
  "file_path",
  "target",
  "targetPath",
  "target_path",
  "from",
  "src",
  "to",
  "dst",
];

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function getMessageRole(message: ContextMessage): string | undefined {
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

export function isCompactionSummaryMessage(message: ContextMessage): boolean {
  return getMessageRole(message) === "compactionSummary";
}

export function findLatestCompactionSummaryIndex(messages: readonly ContextMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isCompactionSummaryMessage(messages[index]!)) {
      return index;
    }
  }
  return -1;
}

export function getMessageText(message: ContextMessage): string {
  if (isCompactionSummaryMessage(message)) {
    const summary = (message as { summary?: unknown }).summary;
    return typeof summary === "string" ? summary : "";
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      const block = asRecord(part);
      if (!block) return [];
      if (block.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      if (typeof block.text === "string") {
        return [block.text];
      }
      return [];
    })
    .join("\n")
    .trim();
}

export function extractToolCalls(message: ContextMessage): Array<{
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}> {
  if (getMessageRole(message) !== "assistant") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const block = asRecord(part);
    if (!block) return [];
    if ((block.type !== "toolCall" && block.type !== "toolUse") || typeof block.id !== "string") {
      return [];
    }
    return [
      {
        id: block.id,
        name: typeof block.name === "string" && block.name.trim() ? block.name.trim() : "unknown",
        ...(asRecord(block.arguments) ? { arguments: asRecord(block.arguments)! } : {}),
      },
    ];
  });
}

function normalizePathCandidate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith(".")
  ) {
    return trimmed;
  }
  return undefined;
}

function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function extractWorkspaceRelativePaths(text: string, maxCount = 6): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b([A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)+)\b/g)) {
    const raw = match[1]?.trim();
    if (!raw || raw.includes("://")) continue;
    const normalized = normalizeScopePath(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
    if (paths.length >= maxCount) break;
  }
  return paths;
}

export function extractPathFromArguments(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  for (const key of PATH_ARGUMENT_KEYS) {
    const candidate = normalizePathCandidate(args[key]);
    if (candidate) return candidate;
  }
  for (const value of Object.values(args)) {
    const candidate = normalizePathCandidate(value);
    if (candidate) return candidate;
  }
  return undefined;
}

export function findProtectedTailStartIndex(
  messages: readonly ContextMessage[],
  protectedRecentTurns: number,
): number {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (getMessageRole(messages[index]!) === "user") {
      userIndexes.push(index);
    }
  }
  if (userIndexes.length === 0) return 0;
  if (userIndexes.length <= protectedRecentTurns) return 0;
  return userIndexes[userIndexes.length - protectedRecentTurns] ?? 0;
}

function findRecentTurnStartIndex(
  messages: readonly ContextMessage[],
  recentTurns: number,
): number {
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (getMessageRole(messages[index]!) === "user") {
      userIndexes.push(index);
    }
  }
  if (userIndexes.length === 0 || userIndexes.length <= recentTurns) return 0;
  return userIndexes[userIndexes.length - recentTurns] ?? 0;
}

function parseTranscriptLine(line: string): TranscriptHeaderEntry | TranscriptBranchEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.type === "session") {
      return parsed as TranscriptHeaderEntry;
    }
    if (parsed.type === "message" && typeof parsed.id === "string" && parsed.message) {
      return parsed as TranscriptMessageEntry;
    }
    if (parsed.type === "compaction" && typeof parsed.id === "string") {
      return parsed as TranscriptCompactionEntry;
    }
    if (typeof parsed.type === "string") {
      return parsed as TranscriptGenericEntry;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function buildTranscriptIndex(params: {
  sessionFile: string;
  protectedRecentTurns: number;
}): Promise<TranscriptIndex> {
  const raw = await fs.readFile(params.sessionFile, "utf-8").catch(() => "");
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines.map(parseTranscriptLine).find((entry): entry is TranscriptHeaderEntry => entry?.type === "session");
  const entries = lines
    .map(parseTranscriptLine)
    .filter((entry): entry is TranscriptBranchEntry => Boolean(entry && entry.type !== "session"));

  const byId = new Map<string, TranscriptBranchEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string" && entry.id) {
      byId.set(entry.id, entry);
    }
  }

  let current = [...entries].reverse().find((entry) => typeof entry.id === "string" && entry.id);
  const branch: TranscriptBranchEntry[] = [];
  const visited = new Set<string>();
  while (current && typeof current.id === "string" && !visited.has(current.id)) {
    branch.push(current);
    visited.add(current.id);
    const parentId =
      "parentId" in current && typeof current.parentId === "string" ? current.parentId : undefined;
    current = parentId ? byId.get(parentId) : undefined;
  }
  branch.reverse();

  const messageEntries = branch.filter(
    (entry): entry is TranscriptMessageEntry => entry.type === "message",
  );
  const compactions = branch.filter(
    (entry): entry is TranscriptCompactionEntry => entry.type === "compaction",
  );

  const protectedTailStartIndex = findProtectedTailStartIndex(
    messageEntries.map((entry) => entry.message),
    params.protectedRecentTurns,
  );

  const toolCallsById = new Map<string, ToolCallRef>();
  for (let messageIndex = 0; messageIndex < messageEntries.length; messageIndex++) {
    const entry = messageEntries[messageIndex]!;
    for (const toolCall of extractToolCalls(entry.message)) {
      const path = extractPathFromArguments(toolCall.arguments);
      toolCallsById.set(toolCall.id, {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        assistantEntryId: entry.id,
        messageIndex,
        ...(toolCall.arguments ? { args: toolCall.arguments } : {}),
        ...(path ? { path } : {}),
      });
    }
  }

  const toolResults: IndexedToolResult[] = [];
  for (let messageIndex = 0; messageIndex < messageEntries.length; messageIndex++) {
    const entry = messageEntries[messageIndex]!;
    const message = entry.message as Extract<ContextMessage, { role: "toolResult" }>;
    if (getMessageRole(message) !== "toolResult") continue;
    const rawToolName = (message as { toolName?: unknown }).toolName;
    const toolCallId =
      typeof (message as { toolCallId?: unknown }).toolCallId === "string"
        ? ((message as { toolCallId?: string }).toolCallId ?? "")
        : typeof (message as { toolUseId?: unknown }).toolUseId === "string"
          ? ((message as { toolUseId?: string }).toolUseId ?? "")
          : "";
    const toolCall = toolCallId ? toolCallsById.get(toolCallId) : undefined;
    const toolName =
      typeof rawToolName === "string" && rawToolName.trim()
        ? rawToolName.trim()
        : toolCall?.toolName ?? "unknown";
    const isError = Boolean((message as { isError?: unknown }).isError);

    toolResults.push({
      entryId: entry.id,
      messageIndex,
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      ...(toolCall?.path ? { path: toolCall.path } : {}),
      ...(toolCall?.args ? { args: toolCall.args } : {}),
      text: getMessageText(message),
      isError,
      isProtected: messageIndex >= protectedTailStartIndex,
      message,
    });
  }

  return {
    ...(typeof header?.id === "string" ? { sessionId: header.id } : {}),
    ...(typeof header?.cwd === "string" && header.cwd.trim()
      ? { workspaceDir: header.cwd.trim() }
      : {}),
    branch,
    messageEntries,
    compactions,
    ...(compactions.length > 0 ? { latestCompaction: compactions[compactions.length - 1] } : {}),
    protectedTailStartIndex,
    toolCallsById,
    toolResults,
  };
}

export function buildTranscriptIndexFromMessages(params: {
  messages: readonly ContextMessage[];
  protectedRecentTurns: number;
  sessionId?: string;
  workspaceDir?: string;
}): TranscriptIndex {
  const messageEntries: TranscriptMessageEntry[] = params.messages.map((message, messageIndex) => ({
    type: "message",
    id: `live-message-${messageIndex}`,
    parentId: messageIndex > 0 ? `live-message-${messageIndex - 1}` : null,
    timestamp:
      typeof (message as { timestamp?: unknown }).timestamp === "number" ||
      typeof (message as { timestamp?: unknown }).timestamp === "string"
        ? ((message as { timestamp?: string | number }).timestamp ?? messageIndex)
        : messageIndex,
    message,
  }));
  const compactions = params.messages
    .map((message, messageIndex): TranscriptCompactionEntry | null => {
      if (!isCompactionSummaryMessage(message)) return null;
      return {
        type: "compaction",
        id: `live-compaction-${messageIndex}`,
        parentId: messageIndex > 0 ? `live-message-${messageIndex - 1}` : null,
        timestamp:
          typeof (message as { timestamp?: unknown }).timestamp === "number" ||
          typeof (message as { timestamp?: unknown }).timestamp === "string"
            ? ((message as { timestamp?: string | number }).timestamp ?? messageIndex)
            : messageIndex,
        summary: getMessageText(message),
        tokensBefore:
          typeof (message as { tokensBefore?: unknown }).tokensBefore === "number"
            ? ((message as { tokensBefore?: number }).tokensBefore ?? 0)
            : 0,
        ...(typeof (message as { tokensAfter?: unknown }).tokensAfter === "number"
          ? { tokensAfter: (message as { tokensAfter?: number }).tokensAfter }
          : {}),
      };
    })
    .filter((entry): entry is TranscriptCompactionEntry => entry !== null);

  const protectedTailStartIndex = findProtectedTailStartIndex(
    messageEntries.map((entry) => entry.message),
    params.protectedRecentTurns,
  );

  const toolCallsById = new Map<string, ToolCallRef>();
  for (let messageIndex = 0; messageIndex < messageEntries.length; messageIndex++) {
    const entry = messageEntries[messageIndex]!;
    for (const toolCall of extractToolCalls(entry.message)) {
      const extractedPath = extractPathFromArguments(toolCall.arguments);
      toolCallsById.set(toolCall.id, {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        assistantEntryId: entry.id,
        messageIndex,
        ...(toolCall.arguments ? { args: toolCall.arguments } : {}),
        ...(extractedPath ? { path: extractedPath } : {}),
      });
    }
  }

  const toolResults: IndexedToolResult[] = [];
  for (let messageIndex = 0; messageIndex < messageEntries.length; messageIndex++) {
    const entry = messageEntries[messageIndex]!;
    const message = entry.message as Extract<ContextMessage, { role: "toolResult" }>;
    if (getMessageRole(message) !== "toolResult") continue;
    const rawToolName = (message as { toolName?: unknown }).toolName;
    const toolCallId =
      typeof (message as { toolCallId?: unknown }).toolCallId === "string"
        ? ((message as { toolCallId?: string }).toolCallId ?? "")
        : typeof (message as { toolUseId?: unknown }).toolUseId === "string"
          ? ((message as { toolUseId?: string }).toolUseId ?? "")
          : "";
    const toolCall = toolCallId ? toolCallsById.get(toolCallId) : undefined;
    const toolName =
      typeof rawToolName === "string" && rawToolName.trim()
        ? rawToolName.trim()
        : toolCall?.toolName ?? "unknown";
    const isError = Boolean((message as { isError?: unknown }).isError);

    toolResults.push({
      entryId: entry.id,
      messageIndex,
      ...(toolCallId ? { toolCallId } : {}),
      toolName,
      ...(toolCall?.path ? { path: toolCall.path } : {}),
      ...(toolCall?.args ? { args: toolCall.args } : {}),
      text: getMessageText(message),
      isError,
      isProtected: messageIndex >= protectedTailStartIndex,
      message,
    });
  }

  return {
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    branch: messageEntries,
    messageEntries,
    compactions,
    ...(compactions.length > 0 ? { latestCompaction: compactions[compactions.length - 1] } : {}),
    protectedTailStartIndex,
    toolCallsById,
    toolResults,
  };
}

function dedupeRecent(values: string[], limit: number): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= limit) break;
  }
  return unique;
}

function truncateInline(value: string, maxLength = 240): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

export function collectRecentFilesFromIndex(index: TranscriptIndex, limit: number): string[] {
  const candidates = [...index.toolCallsById.values()]
    .sort((left, right) => right.messageIndex - left.messageIndex)
    .map((entry) => entry.path)
    .filter((value): value is string => Boolean(value && value.trim()));
  return dedupeRecent(candidates, limit);
}

export function collectCriticalToolOutputsFromIndex(index: TranscriptIndex, limit: number): string[] {
  const candidates = [...index.toolResults]
    .sort((left, right) => right.messageIndex - left.messageIndex)
    .filter((result) => result.isError || CRITICAL_TOOL_NAMES.has(result.toolName))
    .map((result) => {
      const label = result.path ? `${result.toolName} ${result.path}` : result.toolName;
      const text = truncateInline(result.text);
      return text ? `${label}: ${text}` : label;
    });
  return dedupeRecent(candidates, limit);
}

export function collectRecentFilesFromMessages(
  messages: readonly ContextMessage[],
  limit: number,
): string[] {
  const candidates: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const toolCall of extractToolCalls(messages[index]!)) {
      const path = extractPathFromArguments(toolCall.arguments);
      if (path) candidates.push(path);
    }
  }
  return dedupeRecent(candidates, limit);
}

export function collectActiveScopeSignalsFromMessages(
  messages: readonly ContextMessage[],
  recentTurns: number,
): ActiveScopeSignal[] {
  const startIndex = findRecentTurnStartIndex(messages, recentTurns);
  const signals: ActiveScopeSignal[] = [];
  const toolCallPathsById = new Map<string, { toolName: string; path?: string; messageIndex: number }>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    for (const toolCall of extractToolCalls(message)) {
      const extractedPath = extractPathFromArguments(toolCall.arguments);
      toolCallPathsById.set(toolCall.id, {
        toolName: toolCall.name,
        ...(extractedPath ? { path: normalizeScopePath(extractedPath) } : {}),
        messageIndex: index,
      });
      if (index < startIndex || !extractedPath) continue;
      const normalizedPath = normalizeScopePath(extractedPath);
      if (EDIT_TOOL_NAMES.has(toolCall.name)) {
        signals.push({ path: normalizedPath, source: "edit", messageIndex: index });
      } else if (toolCall.name === "read") {
        signals.push({ path: normalizedPath, source: "read", messageIndex: index });
      } else if (SEARCH_TOOL_NAMES.has(toolCall.name)) {
        signals.push({ path: normalizedPath, source: "search", messageIndex: index });
      }
    }
  }

  for (let index = startIndex; index < messages.length; index++) {
    const message = messages[index]!;
    if (getMessageRole(message) !== "toolResult") continue;
    const toolRecord = message as {
      toolCallId?: string;
      toolUseId?: string;
      toolName?: string;
      isError?: boolean;
    };
    const toolCallId = toolRecord.toolCallId ?? toolRecord.toolUseId ?? "";
    const toolRef = toolCallId ? toolCallPathsById.get(toolCallId) : undefined;
    const toolName =
      typeof toolRecord.toolName === "string" && toolRecord.toolName.trim()
        ? toolRecord.toolName.trim()
        : toolRef?.toolName ?? "unknown";
    if (SEARCH_TOOL_NAMES.has(toolName)) {
      for (const extractedPath of extractWorkspaceRelativePaths(getMessageText(message))) {
        signals.push({ path: extractedPath, source: "search", messageIndex: index });
      }
    }
    if (toolRecord.isError) {
      for (const extractedPath of extractWorkspaceRelativePaths(getMessageText(message))) {
        signals.push({ path: extractedPath, source: "error", messageIndex: index });
      }
    }
  }

  const deduped = new Map<string, ActiveScopeSignal>();
  for (const signal of signals.sort((left, right) => right.messageIndex - left.messageIndex)) {
    const key = `${signal.source}:${signal.path}`;
    if (!deduped.has(key)) {
      deduped.set(key, signal);
    }
  }
  return [...deduped.values()];
}

export function collectCriticalToolOutputsFromMessages(
  messages: readonly ContextMessage[],
  limit: number,
): string[] {
  const toolNameById = new Map<string, { toolName: string; path?: string }>();
  for (const message of messages) {
    for (const toolCall of extractToolCalls(message)) {
      const path = extractPathFromArguments(toolCall.arguments);
      toolNameById.set(toolCall.id, {
        toolName: toolCall.name,
        ...(path ? { path } : {}),
      });
    }
  }

  const candidates: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (getMessageRole(message) !== "toolResult") continue;
    const record = message as {
      toolCallId?: string;
      toolUseId?: string;
      toolName?: string;
      isError?: boolean;
    };
    const toolCallId = record.toolCallId ?? record.toolUseId ?? "";
    const ref = toolCallId ? toolNameById.get(toolCallId) : undefined;
    const toolName =
      typeof record.toolName === "string" && record.toolName.trim()
        ? record.toolName.trim()
        : ref?.toolName ?? "unknown";
    if (!record.isError && !CRITICAL_TOOL_NAMES.has(toolName)) continue;
    const label = ref?.path ? `${toolName} ${ref.path}` : toolName;
    const text = truncateInline(getMessageText(message));
    candidates.push(text ? `${label}: ${text}` : label);
  }
  return dedupeRecent(candidates, limit);
}

export function isCriticalToolName(toolName: string): boolean {
  return CRITICAL_TOOL_NAMES.has(toolName);
}
