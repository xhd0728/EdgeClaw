import { estimateMessageTokens, estimateMessagesTokens } from "./token-budget.js";
import {
  extractPathFromArguments,
  extractToolCalls,
  getMessageRole,
  getMessageText,
} from "./transcript-index.js";
import type {
  CollapsedHistoryLayerSnapshot,
  CollapsedHistorySnapshot,
  CompactionBias,
  ContextMessage,
  PressureStage,
} from "./types.js";

const MIN_COLLAPSE_SOURCE_MESSAGES = 3;
const MIN_COLLAPSE_SOURCE_TOKENS = 300;
const MAX_RENDERED_CHARS = 1_600;

type CollapsedLayerMessage = {
  message: ContextMessage;
  snapshot: CollapsedHistoryLayerSnapshot;
};

type CollapsedHistoryResult = {
  messages: ContextMessage[];
  collapseUntilIndex: number;
  snapshot: CollapsedHistorySnapshot;
};

type LayerBuildMode = "single" | "layered";

function truncateInline(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function uniqueHead(values: string[], limit: number): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

function buildAtomicUnits(messages: ContextMessage[]): number[][] {
  const toolCallAssistantIndex = new Map<string, number>();
  for (let index = 0; index < messages.length; index++) {
    for (const toolCall of extractToolCalls(messages[index]!)) {
      toolCallAssistantIndex.set(toolCall.id, index);
    }
  }

  const parents = messages.map((_, index) => index);
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

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index] as { toolCallId?: unknown; toolUseId?: unknown };
    const toolCallId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof message.toolUseId === "string"
          ? message.toolUseId
          : "";
    if (!toolCallId) continue;
    const assistantIndex = toolCallAssistantIndex.get(toolCallId);
    if (typeof assistantIndex === "number") {
      union(index, assistantIndex);
    }
  }

  const grouped = new Map<number, number[]>();
  for (let index = 0; index < messages.length; index++) {
    const root = find(index);
    const group = grouped.get(root);
    if (group) {
      group.push(index);
    } else {
      grouped.set(root, [index]);
    }
  }

  return [...grouped.values()]
    .map((indexes) => [...indexes].sort((left, right) => left - right))
    .sort((left, right) => left[0]! - right[0]!);
}

function getLayerMinimums(
  label: "archive" | "handoff",
  mode: LayerBuildMode,
): { minSourceMessages: number; minSourceTokens: number } {
  if (mode === "layered") {
    return {
      minSourceMessages: 2,
      minSourceTokens: 180,
    };
  }
  return {
    minSourceMessages: label === "archive" ? 2 : MIN_COLLAPSE_SOURCE_MESSAGES,
    minSourceTokens: label === "archive" ? 180 : MIN_COLLAPSE_SOURCE_TOKENS,
  };
}

function summarizeUnitWindow(units: number[][], messages: ContextMessage[]): {
  sourceMessageCount: number;
  sourceTokenEstimate: number;
} {
  let sourceMessageCount = 0;
  let sourceTokenEstimate = 0;
  for (const unit of units) {
    sourceMessageCount += unit.length;
    sourceTokenEstimate += estimateMessagesTokens(unit.map((index) => messages[index]!));
  }
  return { sourceMessageCount, sourceTokenEstimate };
}

function partitionTurns(messages: ContextMessage[]): ContextMessage[][] {
  const turns: ContextMessage[][] = [];
  let current: ContextMessage[] = [];
  for (const message of messages) {
    if (getMessageRole(message) === "user" && current.length > 0) {
      turns.push(current);
      current = [message];
      continue;
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push(current);
  }
  return turns;
}

function buildTurnBullet(messages: ContextMessage[], turnNumber: number): string | undefined {
  const userMessage = messages.find((message) => getMessageRole(message) === "user");
  const userPreview = truncateInline(getMessageText(userMessage ?? messages[0]!), 96) || "continued task";
  const files = uniqueHead(
    messages.flatMap((message) =>
      extractToolCalls(message)
        .map((toolCall) => extractPathFromArguments(toolCall.arguments))
        .filter((value): value is string => Boolean(value?.trim())),
    ),
    3,
  );
  const tools = uniqueHead(
    messages.flatMap((message) => extractToolCalls(message).map((toolCall) => toolCall.name)),
    3,
  );
  const outcomes = uniqueHead(
    messages
      .filter((message) => getMessageRole(message) !== "user")
      .map((message) => truncateInline(getMessageText(message), 88))
      .filter(Boolean),
    2,
  );

  const sections = [`Turn ${turnNumber}: ${userPreview}`];
  if (files.length > 0) sections.push(`files ${files.join(", ")}`);
  if (tools.length > 0) sections.push(`tools ${tools.join(", ")}`);
  if (outcomes.length > 0) sections.push(`outcome ${outcomes.join(" | ")}`);
  return `- ${sections.join("; ")}.`;
}

function renderLayer(params: {
  label: "archive" | "handoff";
  messages: ContextMessage[];
  stage: "elevated" | "critical";
}): string {
  const turns = partitionTurns(params.messages);
  const visibleTurns = params.label === "archive" ? turns.slice(-4) : turns.slice(-6);
  const omittedTurns = Math.max(0, turns.length - visibleTurns.length);
  const header =
    params.label === "archive"
      ? "Collapsed archive layer maintained by ClawXContext. This is the oldest retained history and is intentionally minimal."
      : "Collapsed handoff layer maintained by ClawXContext. This keeps the newer portion of older history in a handoff-friendly form.";
  const stageLine =
    params.stage === "critical"
      ? "Pressure mode: critical. Keep only the minimum structure needed to resume the active task."
      : "Pressure mode: elevated. Preserve older context structure while leaving newer raw detail intact.";
  const bullets = visibleTurns
    .map((turn, index) => buildTurnBullet(turn, omittedTurns + index + 1))
    .filter((value): value is string => Boolean(value));
  const rendered = [header, stageLine, omittedTurns > 0 ? `Earlier summarized turns omitted from bullets: ${omittedTurns}.` : undefined, bullets.join("\n")]
    .filter(Boolean)
    .join("\n\n");
  return rendered.length > MAX_RENDERED_CHARS
    ? `${rendered.slice(0, MAX_RENDERED_CHARS - 1)}…`
    : rendered;
}

function buildLayerMessage(params: {
  label: "archive" | "handoff";
  stage: "elevated" | "critical";
  layerUnits: number[][];
  messages: ContextMessage[];
  mode?: LayerBuildMode;
}): CollapsedLayerMessage | undefined {
  if (params.layerUnits.length === 0) return undefined;
  const sourceStartIndex = params.layerUnits[0]![0]!;
  const sourceEndIndex = params.layerUnits[params.layerUnits.length - 1]!.at(-1)!;
  const sliceMessages = params.messages.slice(sourceStartIndex, sourceEndIndex + 1);
  const sourceTokenEstimate = estimateMessagesTokens(sliceMessages);
  const { minSourceMessages, minSourceTokens } = getLayerMinimums(
    params.label,
    params.mode ?? "single",
  );
  if (
    sliceMessages.length < minSourceMessages ||
    sourceTokenEstimate < minSourceTokens
  ) {
    return undefined;
  }

  const rendered = renderLayer({
    label: params.label,
    messages: sliceMessages,
    stage: params.stage,
  });
  const renderedMessage = {
    role: "user",
    content: rendered,
    timestamp: Date.now(),
  } as ContextMessage;
  const tokenSavingsEstimate = Math.max(0, sourceTokenEstimate - estimateMessageTokens(renderedMessage));

  return {
    message: renderedMessage,
    snapshot: {
      label: params.label,
      sourceStartIndex,
      sourceEndIndex,
      sourceMessageCount: sliceMessages.length,
      sourceTokenEstimate,
      tokenSavingsEstimate,
      preview: truncateInline(rendered, 220),
    },
  };
}

function resolveCollapseStage(
  stage: PressureStage,
  bias: CompactionBias,
): "elevated" | "critical" | undefined {
  if (stage === "critical" || bias === "rescue") return "critical";
  if (stage === "elevated" || bias === "aggressive") return "elevated";
  return undefined;
}

function splitUnitsForLayers(
  units: number[][],
  messages: ContextMessage[],
): { archiveUnits: number[][]; handoffUnits: number[][] } | undefined {
  if (units.length < 2) return undefined;
  const totalTokens = units.reduce(
    (total, unit) => total + estimateMessagesTokens(unit.map((index) => messages[index]!)),
    0,
  );
  const archiveTarget = Math.floor(totalTokens * 0.6);
  let runningTokens = 0;
  let bestSplit:
    | {
        splitIndex: number;
        score: number;
      }
    | undefined;
  for (let index = 0; index < units.length - 1; index++) {
    runningTokens += estimateMessagesTokens(units[index]!.map((messageIndex) => messages[messageIndex]!));
    const archiveUnits = units.slice(0, index + 1);
    const handoffUnits = units.slice(index + 1);
    const archiveSummary = summarizeUnitWindow(archiveUnits, messages);
    const handoffSummary = summarizeUnitWindow(handoffUnits, messages);
    const archiveMinimums = getLayerMinimums("archive", "layered");
    const handoffMinimums = getLayerMinimums("handoff", "layered");
    if (
      archiveSummary.sourceMessageCount < archiveMinimums.minSourceMessages ||
      archiveSummary.sourceTokenEstimate < archiveMinimums.minSourceTokens ||
      handoffSummary.sourceMessageCount < handoffMinimums.minSourceMessages ||
      handoffSummary.sourceTokenEstimate < handoffMinimums.minSourceTokens
    ) {
      continue;
    }
    const score = Math.abs(runningTokens - archiveTarget);
    if (!bestSplit || score < bestSplit.score) {
      bestSplit = { splitIndex: index, score };
    }
  }
  if (!bestSplit) return undefined;
  const splitIndex = bestSplit.splitIndex;
  const archiveUnits = units.slice(0, splitIndex + 1);
  const handoffUnits = units.slice(splitIndex + 1);
  if (archiveUnits.length === 0 || handoffUnits.length === 0) return undefined;
  return { archiveUnits, handoffUnits };
}

export function maybeBuildCollapsedHistory(params: {
  messages: ContextMessage[];
  protectedTailStartIndex: number;
  stage: PressureStage;
  bias: CompactionBias;
}): CollapsedHistoryResult | undefined {
  const collapseStage = resolveCollapseStage(params.stage, params.bias);
  if (!collapseStage) {
    return undefined;
  }

  const atomicUnits = buildAtomicUnits(params.messages);
  const unitsBeforeProtectedTail = atomicUnits.filter(
    (unit) => unit.at(-1)! < params.protectedTailStartIndex,
  );
  const preserveTrailingUnits = collapseStage === "critical" ? 0 : 1;
  const collapsibleUnits =
    preserveTrailingUnits > 0
      ? unitsBeforeProtectedTail.slice(0, Math.max(0, unitsBeforeProtectedTail.length - preserveTrailingUnits))
      : unitsBeforeProtectedTail;

  if (collapsibleUnits.length === 0) {
    return undefined;
  }

  const collapseUntilIndex = collapsibleUnits[collapsibleUnits.length - 1]!.at(-1)! + 1;
  const prefixMessages = params.messages.slice(0, collapseUntilIndex);
  if (
    prefixMessages.length < MIN_COLLAPSE_SOURCE_MESSAGES ||
    estimateMessagesTokens(prefixMessages) < MIN_COLLAPSE_SOURCE_TOKENS
  ) {
    return undefined;
  }

  const preferTwoLayers = collapseStage === "critical";
  const split = preferTwoLayers ? splitUnitsForLayers(collapsibleUnits, params.messages) : undefined;

  const layers: CollapsedLayerMessage[] = [];
  if (split) {
    const archiveLayer = buildLayerMessage({
      label: "archive",
      stage: collapseStage,
      layerUnits: split.archiveUnits,
      messages: params.messages,
      mode: "layered",
    });
    const handoffLayer = buildLayerMessage({
      label: "handoff",
      stage: collapseStage,
      layerUnits: split.handoffUnits,
      messages: params.messages,
      mode: "layered",
    });
    if (archiveLayer && handoffLayer) {
      layers.push(archiveLayer, handoffLayer);
    }
  }

  if (layers.length === 0) {
    const singleLayer = buildLayerMessage({
      label: "handoff",
      stage: collapseStage,
      layerUnits: collapsibleUnits,
      messages: params.messages,
    });
    if (!singleLayer) return undefined;
    layers.push(singleLayer);
  }

  const sourceTokenEstimate = layers.reduce(
    (total, layer) => total + layer.snapshot.sourceTokenEstimate,
    0,
  );
  const tokenSavingsEstimate = layers.reduce(
    (total, layer) => total + layer.snapshot.tokenSavingsEstimate,
    0,
  );

  return {
    messages: layers.map((layer) => layer.message),
    collapseUntilIndex,
    snapshot: {
      stage: collapseStage,
      sourceMessageCount: prefixMessages.length,
      sourceTokenEstimate,
      preview: truncateInline(
        layers.map((layer) => `${layer.snapshot.label}: ${layer.snapshot.preview}`).join(" | "),
        220,
      ),
      layers: layers.map((layer) => layer.snapshot),
      tokenSavingsEstimate,
    },
  };
}
