import type { PluginRuntimeConfig } from "../config.js";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import { maybeBuildCollapsedHistory } from "./collapsed-history.js";
import { compactContext } from "./compact.js";
import { resolvePressureProfile } from "./pressure.js";
import type { ProjectContextManager } from "./project-context.js";
import { injectReinjectionMessage } from "./reinjection.js";
import {
  buildTranscriptIndex,
  buildTranscriptIndexFromMessages,
  extractPathFromArguments,
  extractToolCalls,
  findLatestCompactionSummaryIndex,
  findProtectedTailStartIndex,
  getMessageRole,
  getMessageText,
} from "./transcript-index.js";
import { estimateMessagesTokens, trimMessagesToBudget } from "./token-budget.js";
import type {
  ContextMessage,
  WorkingSetPreviewEntry,
  WorkingSetSnapshot,
} from "./types.js";

const SYSTEM_PROMPT_ADDITION =
  "ClawXContext has already curated the working set. Older tool output may be compacted or summarized. Use context_inspect when you need to inspect retained context state.";
const PREVIEW_MAX_LENGTH = 220;

type WorkingMessageMeta = Omit<WorkingSetPreviewEntry, "workingIndex"> & {
  toolCallIds: string[];
};

type PreflightCompactionResult = {
  summary?: string;
  tokensBefore?: number;
  mode?: "threshold" | "budget";
};

function nowIso(): string {
  return new Date().toISOString();
}

function buildPinnedIndexes(params: {
  includedSummary: boolean;
  protectedTailStartIndex: number;
  sliceStart: number;
  collapsedIndexes: number[];
  injectedIndex: number | undefined;
  totalMessages: number;
}): Set<number> {
  const pinned = new Set<number>();
  let protectedStartInWorking = Math.max(0, params.protectedTailStartIndex - params.sliceStart);
  if (params.includedSummary) {
    pinned.add(0);
    protectedStartInWorking += 1;
  }
  for (const collapsedIndex of params.collapsedIndexes) {
    if (
      typeof collapsedIndex !== "number" ||
      collapsedIndex < 0 ||
      collapsedIndex >= params.totalMessages
    ) {
      continue;
    }
    pinned.add(collapsedIndex);
    if (collapsedIndex <= protectedStartInWorking) {
      protectedStartInWorking += 1;
    }
  }
  if (
    typeof params.injectedIndex === "number" &&
    params.injectedIndex >= 0 &&
    params.injectedIndex < params.totalMessages
  ) {
    pinned.add(params.injectedIndex);
    if (params.injectedIndex <= protectedStartInWorking) {
      protectedStartInWorking += 1;
    }
  }
  for (let index = protectedStartInWorking; index < params.totalMessages; index++) {
    pinned.add(index);
  }
  return pinned;
}

function truncatePreview(value: string, maxLength = PREVIEW_MAX_LENGTH): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function extractToolResultReference(message: ContextMessage): { toolCallId?: string; toolName?: string } {
  const role = getMessageRole(message);
  if (role !== "toolResult") return {};
  const toolCallId =
    typeof (message as { toolCallId?: unknown }).toolCallId === "string"
      ? ((message as { toolCallId?: string }).toolCallId ?? "")
      : typeof (message as { toolUseId?: unknown }).toolUseId === "string"
        ? ((message as { toolUseId?: string }).toolUseId ?? "")
        : "";
  const toolName =
    typeof (message as { toolName?: unknown }).toolName === "string"
      ? ((message as { toolName?: string }).toolName ?? "").trim()
      : "";

  return {
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolName ? { toolName } : {}),
  };
}

function buildMessagePreviewText(params: {
  message: ContextMessage;
  role: string;
  toolCalls: Array<{ name: string; path?: string }>;
  toolResult: { toolCallId?: string; toolName?: string; path?: string };
}): string {
  const text = truncatePreview(getMessageText(params.message));
  if (text) return text;

  if (params.toolCalls.length > 0) {
    const labels = params.toolCalls.slice(0, 2).map((toolCall) =>
      toolCall.path ? `${toolCall.name} ${toolCall.path}` : toolCall.name,
    );
    const suffix =
      params.toolCalls.length > 2 ? ` +${params.toolCalls.length - 2} more` : "";
    return truncatePreview(`tool call: ${labels.join(", ")}${suffix}`);
  }

  if (params.toolResult.toolName || params.toolResult.path || params.toolResult.toolCallId) {
    const label = [
      params.toolResult.toolName,
      params.toolResult.path,
      !params.toolResult.toolName && !params.toolResult.path && params.toolResult.toolCallId
        ? `#${params.toolResult.toolCallId}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    return truncatePreview(`tool result: ${label}`);
  }

  return `[${params.role} message]`;
}

function buildWorkingMessageMeta(params: {
  messages: ContextMessage[];
  sourceIndexes: Array<number | null>;
  messageKinds: WorkingSetPreviewEntry["kind"][];
}): { meta: WorkingMessageMeta[]; atomicUnits: number[][] } {
  const toolCallInfoById = new Map<string, { assistantIndex: number; toolName: string; path?: string }>();

  const raw = params.messages.map((message, index) => {
    const sourceIndex = params.sourceIndexes[index] ?? null;
    const role = getMessageRole(message) ?? "unknown";
    const kind: WorkingSetPreviewEntry["kind"] =
      params.messageKinds[index] ?? (sourceIndex === null ? "reinjection" : "source");
    const toolCalls = extractToolCalls(message).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      path: extractPathFromArguments(toolCall.arguments),
    }));
    for (const toolCall of toolCalls) {
      toolCallInfoById.set(toolCall.id, {
        assistantIndex: index,
        toolName: toolCall.name,
        ...(toolCall.path ? { path: toolCall.path } : {}),
      });
    }
    return {
      sourceIndex,
      role,
      kind,
      toolCalls,
      toolResult: extractToolResultReference(message),
      message,
    };
  });

  const parents = raw.map((_, index) => index);
  const find = (index: number): number => {
    if (parents[index] === index) return index;
    parents[index] = find(parents[index]!);
    return parents[index]!;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parents[rightRoot] = leftRoot;
    }
  };

  raw.forEach((entry, index) => {
    const linkedToolCallId = entry.toolResult.toolCallId;
    if (!linkedToolCallId) return;
    const assistant = toolCallInfoById.get(linkedToolCallId);
    if (assistant) {
      union(index, assistant.assistantIndex);
    }
  });

  const meta = raw.map((entry) => {
    const firstToolCall = entry.toolCalls[0];
    const linkedToolCallInfo = entry.toolResult.toolCallId
      ? toolCallInfoById.get(entry.toolResult.toolCallId)
      : undefined;
    const toolCallId = firstToolCall?.id ?? entry.toolResult.toolCallId;
    const toolName =
      firstToolCall?.name ?? entry.toolResult.toolName ?? linkedToolCallInfo?.toolName;
    const toolPath = firstToolCall?.path ?? linkedToolCallInfo?.path;

    return {
      sourceIndex: entry.sourceIndex,
      role: entry.role,
      kind: entry.kind,
      textPreview: buildMessagePreviewText({
        message: entry.message,
        role: entry.role,
        toolCalls: entry.toolCalls.map((toolCall) => ({
          name: toolCall.name,
          ...(toolCall.path ? { path: toolCall.path } : {}),
        })),
        toolResult: {
          ...(entry.toolResult.toolCallId ? { toolCallId: entry.toolResult.toolCallId } : {}),
          ...(toolName ? { toolName } : {}),
          ...(toolPath ? { path: toolPath } : {}),
        },
      }),
      ...(toolName ? { toolName } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      toolCallIds: entry.toolCalls.map((toolCall) => toolCall.id),
    };
  });

  const grouped = new Map<number, number[]>();
  for (let index = 0; index < raw.length; index++) {
    const root = find(index);
    const group = grouped.get(root);
    if (group) {
      group.push(index);
    } else {
      grouped.set(root, [index]);
    }
  }
  const atomicUnits = [...grouped.values()]
    .map((indexes) => [...indexes].sort((left, right) => left - right))
    .sort((left, right) => left[0]! - right[0]!);

  return { meta, atomicUnits };
}

function buildRetainedPreview(
  meta: WorkingMessageMeta[],
  retainedIndexes: number[],
): WorkingSetPreviewEntry[] {
  return retainedIndexes.map((retainedIndex, workingIndex) => {
    const entry = meta[retainedIndex]!;
    return {
      workingIndex,
      sourceIndex: entry.sourceIndex,
      role: entry.role,
      kind: entry.kind,
      textPreview: entry.textPreview,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.toolCallId ? { toolCallId: entry.toolCallId } : {}),
    };
  });
}

async function maybeRunPreflightCompaction(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  sessionId: string;
  sessionKey: string;
  tokenBudget?: number;
  messages: ContextMessage[];
  projectContextManager?: ProjectContextManager;
}): Promise<PreflightCompactionResult | undefined> {
  if (!params.config.autoCompactEnabled || typeof params.tokenBudget !== "number" || params.tokenBudget <= 0) {
    return undefined;
  }

  const session = await params.store.getSession(params.sessionKey);
  if (!session.sessionFile?.trim()) {
    return undefined;
  }

  const estimatedTokens = estimateMessagesTokens(params.messages);
  const transcriptIndex = buildTranscriptIndexFromMessages({
    messages: params.messages,
    protectedRecentTurns: params.config.protectedRecentTurns,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
  });
  const profile = resolvePressureProfile({
    config: params.config,
    session,
    estimatedTokens,
    index: transcriptIndex,
    tokenBudget: params.tokenBudget,
  });
  const hardThreshold = Math.max(0, params.tokenBudget - params.config.autoCompactReserveTokens);
  const isAboveHardThreshold = estimatedTokens >= hardThreshold;
  const shouldPreemptivelyCompact =
    profile.stage === "critical" &&
    (profile.debtBreakdown.hardThresholdUtilization ?? 0) >= 0.95;

  if (!isAboveHardThreshold && !shouldPreemptivelyCompact) {
    return undefined;
  }

  const result = await compactContext({
    config: params.config,
    store: params.store,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: session.sessionFile,
    tokenBudget: params.tokenBudget,
    currentTokenCount: estimatedTokens,
    compactionTarget: isAboveHardThreshold ? "threshold" : "budget",
    ...(params.projectContextManager ? { projectContextManager: params.projectContextManager } : {}),
  });

  if (!result.ok || !result.compacted) {
    return undefined;
  }

  return {
    ...(result.result?.summary?.trim() ? { summary: result.result.summary.trim() } : {}),
    ...(typeof result.result?.tokensBefore === "number"
      ? { tokensBefore: result.result.tokensBefore }
      : {}),
    mode: isAboveHardThreshold ? "threshold" : "budget",
  };
}

export async function assembleWorkingSet(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  sessionId: string;
  sessionKey?: string;
  messages: ContextMessage[];
  tokenBudget?: number;
  projectContextManager?: ProjectContextManager;
}): Promise<{ messages: ContextMessage[]; estimatedTokens: number; systemPromptAddition: string }> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  const preflightCompaction = await maybeRunPreflightCompaction({
    config: params.config,
    store: params.store,
    sessionId: params.sessionId,
    sessionKey,
    messages: params.messages,
    ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
    ...(params.projectContextManager ? { projectContextManager: params.projectContextManager } : {}),
  });
  const latestSummaryIndex = preflightCompaction?.summary ? -1 : findLatestCompactionSummaryIndex(params.messages);
  const protectedTailStartIndex = findProtectedTailStartIndex(
    params.messages,
    params.config.protectedRecentTurns,
  );

  const sliceStart = preflightCompaction?.summary
    ? protectedTailStartIndex
    : latestSummaryIndex >= 0
      ? Math.min(protectedTailStartIndex, latestSummaryIndex + 1)
      : 0;
  const working: ContextMessage[] = [];
  const sourceIndexes: Array<number | null> = [];
  let includedCompactionSummary = false;
  let collapsedHistory: WorkingSetSnapshot["collapsedHistory"] | undefined;

  if (preflightCompaction?.summary) {
    working.push({
      role: "compactionSummary",
      summary: preflightCompaction.summary,
      ...(typeof preflightCompaction.tokensBefore === "number"
        ? { tokensBefore: preflightCompaction.tokensBefore }
        : {}),
    } as ContextMessage);
    sourceIndexes.push(-1);
    includedCompactionSummary = true;
  } else if (latestSummaryIndex >= 0) {
    working.push(params.messages[latestSummaryIndex]!);
    sourceIndexes.push(latestSummaryIndex);
    includedCompactionSummary = true;
  }
  const session = await params.store.getSession(sessionKey);
  const liveTranscriptIndex = buildTranscriptIndexFromMessages({
    messages: params.messages,
    protectedRecentTurns: params.config.protectedRecentTurns,
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
  });
  const currentProfile = resolvePressureProfile({
    config: params.config,
    session,
    estimatedTokens: estimateMessagesTokens(params.messages),
    index: liveTranscriptIndex,
    ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
  });
  const collapseBias =
    currentProfile.stage === "critical" ? session.compactionBias : session.compactionBias;
  const collapsed =
    !includedCompactionSummary && !preflightCompaction?.summary
      ? maybeBuildCollapsedHistory({
          messages: params.messages,
          protectedTailStartIndex,
          stage: currentProfile.stage,
          bias: collapseBias,
        })
      : undefined;
  const messageKinds: WorkingSetPreviewEntry["kind"][] = working.map(() => "source");
  if (collapsed) {
    for (const message of collapsed.messages) {
      working.push(message);
      sourceIndexes.push(null);
      messageKinds.push("collapsed");
    }
    collapsedHistory = collapsed.snapshot;
  }
  const rawStartIndex = collapsed ? Math.max(sliceStart, collapsed.collapseUntilIndex) : sliceStart;
  for (let index = rawStartIndex; index < params.messages.length; index++) {
    if (index === latestSummaryIndex) continue;
    working.push(params.messages[index]!);
    sourceIndexes.push(index);
    messageKinds.push("source");
  }

  const reinjected =
    preflightCompaction?.summary && session.reinjection?.mode === "summary-only"
      ? { messages: working, insertedIndex: undefined }
      : injectReinjectionMessage(working, session.reinjection);
  const workingSourceIndexes = [...sourceIndexes];
  const workingKinds = [...messageKinds];
  if (typeof reinjected.insertedIndex === "number") {
    workingSourceIndexes.splice(reinjected.insertedIndex, 0, null);
    workingKinds.splice(reinjected.insertedIndex, 0, "reinjection");
  }
  const { meta, atomicUnits } = buildWorkingMessageMeta({
    messages: reinjected.messages,
    sourceIndexes: workingSourceIndexes,
    messageKinds: workingKinds,
  });
  const pinnedIndexes = buildPinnedIndexes({
    includedSummary: includedCompactionSummary,
    protectedTailStartIndex,
    sliceStart: rawStartIndex,
    collapsedIndexes: workingKinds
      .map((kind, index) => (kind === "collapsed" ? index : -1))
      .filter((index) => index >= 0),
    injectedIndex: reinjected.insertedIndex,
    totalMessages: reinjected.messages.length,
  });

  const trimmed = trimMessagesToBudget(
    {
      messages: reinjected.messages,
      tokenBudget: params.tokenBudget,
      pinnedIndexes,
      atomicUnits,
    },
  );

  const estimatedTokens = trimmed.estimatedTokens || estimateMessagesTokens(trimmed.messages);
  const retainedPreview = buildRetainedPreview(meta, trimmed.retainedIndexes);
  const workingSet: WorkingSetSnapshot = {
    messageCount: trimmed.messages.length,
    estimatedTokens,
    ...(typeof params.tokenBudget === "number" && params.tokenBudget > 0
      ? {
          tokenBudget: params.tokenBudget,
          budgetUtilization: Number((estimatedTokens / params.tokenBudget).toFixed(4)),
        }
      : {}),
    protectedTailStartIndex,
    protectedTailMessageCount: Math.max(0, params.messages.length - protectedTailStartIndex),
    protectedRecentTurns: params.config.protectedRecentTurns,
    includedCompactionSummary,
    reinjected: typeof reinjected.insertedIndex === "number",
    trimmedToBudget: trimmed.trimmed,
    ...(collapsedHistory ? { collapsedHistory } : {}),
    retainedPreview,
    notes: [
      includedCompactionSummary ? "latest compaction summary retained" : "no compaction summary",
      preflightCompaction?.summary
        ? `preflight compaction triggered during assemble (${preflightCompaction.mode ?? "budget"})`
        : "no preflight compaction triggered",
      latestSummaryIndex >= 0
        ? `working set starts at message index ${sliceStart} after compaction summary`
        : preflightCompaction?.summary
          ? `working set reset to protected tail from message index ${sliceStart} after preflight compaction`
          : collapsed
            ? `older history collapsed into ${collapsed.snapshot.layers.length} layer(s) before message index ${collapsed.collapseUntilIndex}`
          : "pre-compaction session keeps full history until budget trimming",
      typeof reinjected.insertedIndex === "number"
        ? "reinjection context block inserted"
        : "no reinjection block inserted",
    ],
  };

  await params.store.updateWorkingSet(sessionKey, workingSet, {
    sessionId: params.sessionId,
  });
  await params.store.appendEvent(sessionKey, {
    at: nowIso(),
    type: "assemble",
    detail: {
      sourceMessageCount: params.messages.length,
      assembledMessageCount: workingSet.messageCount,
      estimatedTokens: workingSet.estimatedTokens,
      protectedTailStartIndex,
      includedCompactionSummary,
      collapsedHistory: Boolean(collapsedHistory),
      reinjected: workingSet.reinjected,
      trimmedToBudget: workingSet.trimmedToBudget,
    },
  });

  return {
    messages: trimmed.messages,
    estimatedTokens,
    systemPromptAddition: SYSTEM_PROMPT_ADDITION,
  };
}
