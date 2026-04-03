import type { PluginRuntimeConfig } from "../config.js";
import { estimateMessageTokens } from "./token-budget.js";
import type {
  BudgetHotspot,
  DebtBreakdown,
  IndexedToolResult,
  PressureStage,
  RewriteStatsSnapshot,
  TranscriptIndex,
} from "./types.js";

const LARGE_TOOL_RESULT_MIN_CHARS = 1_200;
const VERY_LARGE_TOOL_RESULT_MIN_CHARS = 4_000;
const BUDGETABLE_TOOL_RESULT_MIN_CHARS = 600;
const RECENT_SCOPE_TURNS = 3;

const SEARCH_TOOL_NAMES = new Set(["grep", "glob"]);
const COMMAND_TOOL_NAMES = new Set(["bash", "exec"]);
const WEB_TOOL_NAMES = new Set(["web_fetch", "web_search", "search", "fetch"]);
const EDIT_TOOL_NAMES = new Set(["edit", "write", "replace", "patch"]);
const SNIP_ALLOWLIST = new Set([
  "read",
  "grep",
  "glob",
  "bash",
  "exec",
  "web_fetch",
  "web_search",
  "search",
  "fetch",
]);

export type ToolResultBudgetCategory = "read" | "search" | "command" | "web" | "other";

export type ToolResultBudgetCandidate = {
  entry: IndexedToolResult;
  category: ToolResultBudgetCategory;
  estimatedTokens: number;
  priorityScore: number;
};

export type TranscriptDebtAnalysis = {
  debtBreakdown: DebtBreakdown;
  hasReadBloat: boolean;
  hasVeryLargeUnprotectedToolResult: boolean;
  largestLargeToolResult?: IndexedToolResult;
  readBloatPath?: string;
  budgetHotspots: BudgetHotspot[];
};

function isCompactedToolOutput(text: string): boolean {
  return (
    text.startsWith("[tool output compacted:") ||
    text.startsWith("[tool output outdated after")
  );
}

function estimateToolResultTokens(entry: IndexedToolResult): number {
  return estimateMessageTokens(entry.message);
}

function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function readStringArg(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function pathsOverlap(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const normalizedLeft = normalizeScopePath(left);
  const normalizedRight = normalizeScopePath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
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

function resolveRecentScopeStartIndex(index: TranscriptIndex): number {
  const userIndexes = index.messageEntries
    .map((entry, messageIndex) =>
      (entry.message as { role?: unknown }).role === "user" ? messageIndex : -1,
    )
    .filter((value) => value >= 0);
  if (userIndexes.length <= RECENT_SCOPE_TURNS) return 0;
  return userIndexes[userIndexes.length - RECENT_SCOPE_TURNS] ?? 0;
}

function buildRecentScopeState(index: TranscriptIndex) {
  const startIndex = resolveRecentScopeStartIndex(index);
  const activePaths = new Set<string>();
  const editedPaths = new Set<string>();
  const blockerPaths = new Set<string>();

  for (const toolCall of index.toolCallsById.values()) {
    if (toolCall.messageIndex < startIndex || !toolCall.path) continue;
    const normalizedPath = normalizeScopePath(toolCall.path);
    if (!normalizedPath) continue;
    if (
      EDIT_TOOL_NAMES.has(toolCall.toolName) ||
      toolCall.toolName === "read" ||
      SEARCH_TOOL_NAMES.has(toolCall.toolName)
    ) {
      activePaths.add(normalizedPath);
    }
    if (EDIT_TOOL_NAMES.has(toolCall.toolName)) {
      editedPaths.add(normalizedPath);
    }
  }

  for (const result of index.toolResults) {
    if (result.messageIndex < startIndex || !result.isError) continue;
    for (const extractedPath of extractWorkspaceRelativePaths(result.text)) {
      activePaths.add(extractedPath);
      blockerPaths.add(extractedPath);
    }
  }

  return { activePaths, editedPaths, blockerPaths };
}

function resolveBudgetTarget(entry: IndexedToolResult): string {
  const query = readStringArg(entry.args, ["pattern", "query", "search", "q", "regex", "match"]);
  return entry.path ?? query ?? entry.toolName;
}

function resolveSearchKey(entry: IndexedToolResult): string | undefined {
  if (!SEARCH_TOOL_NAMES.has(entry.toolName)) return undefined;
  const pattern = readStringArg(entry.args, ["pattern", "query", "search", "q", "regex", "match"]) ?? "";
  const basePath = entry.path ?? readStringArg(entry.args, ["path", "cwd", "root"]) ?? "";
  return `${entry.toolName}:${pattern}:${basePath}`.trim();
}

function getCategoryPriorityBoost(category: ToolResultBudgetCategory): number {
  if (category === "web") return 140;
  if (category === "command") return 120;
  if (category === "search") return 90;
  if (category === "read") return 40;
  return 0;
}

export function classifyToolResultBudgetCategory(toolName: string): ToolResultBudgetCategory {
  if (toolName === "read") return "read";
  if (SEARCH_TOOL_NAMES.has(toolName)) return "search";
  if (COMMAND_TOOL_NAMES.has(toolName)) return "command";
  if (WEB_TOOL_NAMES.has(toolName)) return "web";
  return "other";
}

export function rankBudgetHotspots(params: {
  index: TranscriptIndex;
  limit?: number;
}): BudgetHotspot[] {
  const latestEditByPath = new Map<string, number>();
  const latestReadByPath = new Map<string, number>();
  const searchCounts = new Map<string, number>();

  for (const toolCall of params.index.toolCallsById.values()) {
    if (!toolCall.path || !EDIT_TOOL_NAMES.has(toolCall.toolName)) continue;
    const normalizedPath = normalizeScopePath(toolCall.path);
    latestEditByPath.set(
      normalizedPath,
      Math.max(latestEditByPath.get(normalizedPath) ?? -1, toolCall.messageIndex),
    );
  }

  for (const result of params.index.toolResults) {
    if (isCompactedToolOutput(result.text)) continue;
    if (result.toolName === "read" && result.path) {
      const normalizedPath = normalizeScopePath(result.path);
      latestReadByPath.set(
        normalizedPath,
        Math.max(latestReadByPath.get(normalizedPath) ?? -1, result.messageIndex),
      );
    }
    const searchKey = resolveSearchKey(result);
    if (searchKey) {
      searchCounts.set(searchKey, (searchCounts.get(searchKey) ?? 0) + 1);
    }
  }

  const { activePaths, editedPaths, blockerPaths } = buildRecentScopeState(params.index);
  const hotspots = params.index.toolResults
    .filter((entry) => !entry.isProtected && !isCompactedToolOutput(entry.text))
    .map((entry) => {
      const category = classifyToolResultBudgetCategory(entry.toolName);
      const estimatedTokens = estimateToolResultTokens(entry);
      const reasons: string[] = [];
      let score = estimatedTokens + getCategoryPriorityBoost(category);

      if (entry.text.length >= LARGE_TOOL_RESULT_MIN_CHARS) {
        score += Math.round(estimatedTokens * 0.35);
        reasons.push("large-payload");
      }

      const normalizedPath = entry.path ? normalizeScopePath(entry.path) : undefined;
      const latestEditIndex = normalizedPath ? latestEditByPath.get(normalizedPath) : undefined;
      const latestReadIndex = normalizedPath ? latestReadByPath.get(normalizedPath) : undefined;
      const staleRead =
        entry.toolName === "read" &&
        Boolean(
          (typeof latestEditIndex === "number" && latestEditIndex > entry.messageIndex) ||
            (typeof latestReadIndex === "number" && latestReadIndex > entry.messageIndex),
        );
      if (staleRead) {
        score += Math.round(estimatedTokens * 0.45);
        reasons.push("stale-read");
      }

      const searchKey = resolveSearchKey(entry);
      if (searchKey && (searchCounts.get(searchKey) ?? 0) > 1) {
        score += 160;
        reasons.push("duplicate-search");
      }

      const inActiveScope =
        normalizedPath &&
        [...activePaths].some((candidate) => pathsOverlap(candidate, normalizedPath));
      if (activePaths.size > 0 && normalizedPath && !inActiveScope) {
        score += 140;
        reasons.push("out-of-active-scope");
      }

      const stronglyRelevant =
        normalizedPath &&
        ([...editedPaths].some((candidate) => pathsOverlap(candidate, normalizedPath)) ||
          [...blockerPaths].some((candidate) => pathsOverlap(candidate, normalizedPath)));
      if (stronglyRelevant) {
        score -= 260;
        reasons.push("active-file");
      }

      const distanceToProtectedTail = Math.max(
        0,
        params.index.protectedTailStartIndex - entry.messageIndex,
      );
      if (distanceToProtectedTail <= 2) {
        score -= 220;
        reasons.push("near-protected-tail");
      } else if (distanceToProtectedTail >= 6) {
        score += 80;
        reasons.push("far-from-focus");
      }

      return {
        toolName: entry.toolName,
        target: resolveBudgetTarget(entry),
        category,
        estimatedTokens,
        score: Math.max(1, Math.round(score)),
        messageIndex: entry.messageIndex,
        reasons,
      } satisfies BudgetHotspot;
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.estimatedTokens !== left.estimatedTokens) {
        return right.estimatedTokens - left.estimatedTokens;
      }
      return right.messageIndex - left.messageIndex;
    });

  return typeof params.limit === "number" ? hotspots.slice(0, params.limit) : hotspots;
}

function getSnipCategoryWeight(
  category: ToolResultBudgetCategory,
  stage: PressureStage,
): number {
  if (stage === "critical") {
    if (category === "web") return 1.6;
    if (category === "command") return 1.45;
    if (category === "search") return 1.35;
    if (category === "read") return 1.2;
    return 1;
  }
  if (stage === "elevated" || stage === "stabilizing") {
    if (category === "web") return 1.4;
    if (category === "command") return 1.25;
    if (category === "search") return 1.2;
    if (category === "read") return 1.1;
  }
  return 1;
}

function getBudgetableMinTextLength(
  category: ToolResultBudgetCategory,
  stage: PressureStage,
  baseMinTextLength: number,
): number {
  if (stage === "normal") {
    return Math.max(baseMinTextLength, BUDGETABLE_TOOL_RESULT_MIN_CHARS);
  }

  if (stage === "critical") {
    if (category === "web" || category === "command") {
      return Math.max(160, Math.floor(baseMinTextLength * 0.5));
    }
    if (category === "search") {
      return Math.max(220, Math.floor(baseMinTextLength * 0.65));
    }
    return baseMinTextLength;
  }

  if (category === "web" || category === "command") {
    return Math.max(300, Math.floor(baseMinTextLength * 0.75));
  }
  return baseMinTextLength;
}

export function listSnipCandidates(params: {
  index: TranscriptIndex;
  stage: PressureStage;
  bias?: "normal" | "aggressive" | "rescue";
  baseMinTextLength: number;
}): ToolResultBudgetCandidate[] {
  const effectiveStage =
    params.bias === "rescue"
      ? "critical"
      : params.bias === "aggressive" && params.stage === "normal"
        ? "elevated"
        : params.stage;
  const hotspots = rankBudgetHotspots({ index: params.index });
  const hotspotByKey = new Map(
    hotspots.map((hotspot) => [
      `${hotspot.toolName}:${hotspot.messageIndex}:${hotspot.target}`,
      hotspot,
    ]),
  );

  const candidates = params.index.toolResults
    .filter(
      (entry) =>
        !entry.isProtected &&
        SNIP_ALLOWLIST.has(entry.toolName) &&
        !isCompactedToolOutput(entry.text),
    )
    .map((entry) => {
      const category = classifyToolResultBudgetCategory(entry.toolName);
      const estimatedTokens = estimateToolResultTokens(entry);
      const minTextLength = getBudgetableMinTextLength(
        category,
        effectiveStage,
        params.baseMinTextLength,
      );
      const hotspot = hotspotByKey.get(
        `${entry.toolName}:${entry.messageIndex}:${resolveBudgetTarget(entry)}`,
      );
      return {
        entry,
        category,
        estimatedTokens,
        minTextLength,
        priorityScore:
          (hotspot?.score ?? estimatedTokens) *
            getSnipCategoryWeight(category, effectiveStage) +
          Math.max(0, params.index.protectedTailStartIndex - entry.messageIndex),
      };
    })
    .filter((candidate) => candidate.entry.text.length >= candidate.minTextLength);

  return candidates.sort((left, right) => {
    if (right.priorityScore !== left.priorityScore) {
      return right.priorityScore - left.priorityScore;
    }
    return right.entry.messageIndex - left.entry.messageIndex;
  });
}

export function buildTranscriptDebtAnalysis(params: {
  config: PluginRuntimeConfig;
  index?: TranscriptIndex;
  rewrites: RewriteStatsSnapshot;
  estimatedTokens?: number;
  tokenBudget?: number;
}): TranscriptDebtAnalysis {
  const recentRewriteSavings = Math.max(0, Math.ceil((params.rewrites.bytesFreed ?? 0) / 4));
  const hardThresholdTokens =
    typeof params.tokenBudget === "number" && params.tokenBudget > 0
      ? Math.max(0, params.tokenBudget - params.config.autoCompactReserveTokens)
      : undefined;
  const hardThresholdUtilization =
    typeof params.estimatedTokens === "number" &&
    typeof hardThresholdTokens === "number" &&
    hardThresholdTokens > 0
      ? Number((params.estimatedTokens / hardThresholdTokens).toFixed(4))
      : undefined;

  if (!params.index) {
    return {
      debtBreakdown: {
        largeToolResultDebt: 0,
        readBloatDebt: 0,
        searchToolResultDebt: 0,
        commandToolResultDebt: 0,
        webToolResultDebt: 0,
        collapseCandidateDebt: 0,
        recentRewriteSavings,
        ...(typeof hardThresholdTokens === "number" ? { hardThresholdTokens } : {}),
        ...(typeof params.estimatedTokens === "number"
          ? { estimatedTokens: params.estimatedTokens }
          : {}),
        ...(typeof hardThresholdUtilization === "number"
          ? { hardThresholdUtilization }
          : {}),
      },
      hasReadBloat: false,
      hasVeryLargeUnprotectedToolResult: false,
      budgetHotspots: [],
    };
  }

  const candidateResults = params.index.toolResults.filter(
    (entry) => !entry.isProtected && !isCompactedToolOutput(entry.text),
  );
  const candidateLargeResults = candidateResults.filter(
    (entry) => entry.text.length >= LARGE_TOOL_RESULT_MIN_CHARS,
  );
  const largestLargeToolResult = [...candidateLargeResults].sort(
    (left, right) => right.text.length - left.text.length,
  )[0];

  let largeToolResultDebt = 0;
  let searchToolResultDebt = 0;
  let commandToolResultDebt = 0;
  let webToolResultDebt = 0;
  for (const entry of candidateResults) {
    const estimated = estimateToolResultTokens(entry);
    const category = classifyToolResultBudgetCategory(entry.toolName);
    if (entry.text.length >= LARGE_TOOL_RESULT_MIN_CHARS) {
      largeToolResultDebt += estimated;
    }
    if (entry.text.length < BUDGETABLE_TOOL_RESULT_MIN_CHARS) continue;
    if (category === "search") {
      searchToolResultDebt += estimated;
    } else if (category === "command") {
      commandToolResultDebt += estimated;
    } else if (category === "web") {
      webToolResultDebt += estimated;
    }
  }

  const readsByPath = new Map<string, IndexedToolResult[]>();
  for (const result of params.index.toolResults) {
    if (
      result.toolName !== "read" ||
      !result.path ||
      result.isProtected ||
      isCompactedToolOutput(result.text)
    ) {
      continue;
    }
    const existing = readsByPath.get(result.path);
    if (existing) {
      existing.push(result);
    } else {
      readsByPath.set(result.path, [result]);
    }
  }

  let readBloatDebt = 0;
  let readBloatPath: string | undefined;
  let readBloatPathDebt = 0;
  for (const [filePath, entries] of readsByPath.entries()) {
    if (entries.length < 2) continue;
    const sorted = [...entries].sort((left, right) => right.messageIndex - left.messageIndex);
    const staleReads = sorted.slice(1);
    const staleDebt = staleReads.reduce(
      (total, entry) => total + estimateToolResultTokens(entry),
      0,
    );
    readBloatDebt += staleDebt;
    if (staleDebt > readBloatPathDebt) {
      readBloatPathDebt = staleDebt;
      readBloatPath = filePath;
    }
  }

  const collapseCandidateDebt =
    params.index.latestCompaction || params.index.protectedTailStartIndex <= 1
      ? 0
      : params.index.messageEntries
          .slice(0, params.index.protectedTailStartIndex)
          .reduce((total, entry) => total + estimateMessageTokens(entry.message), 0);

  return {
    debtBreakdown: {
      largeToolResultDebt,
      readBloatDebt,
      searchToolResultDebt,
      commandToolResultDebt,
      webToolResultDebt,
      collapseCandidateDebt,
      recentRewriteSavings,
      ...(typeof hardThresholdTokens === "number" ? { hardThresholdTokens } : {}),
      ...(typeof params.estimatedTokens === "number"
        ? { estimatedTokens: params.estimatedTokens }
        : {}),
      ...(typeof hardThresholdUtilization === "number"
        ? { hardThresholdUtilization }
        : {}),
    },
    hasReadBloat: readBloatDebt > 0,
    hasVeryLargeUnprotectedToolResult:
      (largestLargeToolResult?.text.length ?? 0) >= VERY_LARGE_TOOL_RESULT_MIN_CHARS,
    ...(largestLargeToolResult ? { largestLargeToolResult } : {}),
    ...(readBloatPath ? { readBloatPath } : {}),
    budgetHotspots: rankBudgetHotspots({
      index: params.index,
      limit: 5,
    }),
  };
}
