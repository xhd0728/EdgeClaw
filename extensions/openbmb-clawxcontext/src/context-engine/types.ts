import type { ContextEngine } from "openclaw/plugin-sdk";

export type ContextMessage = Parameters<ContextEngine["assemble"]>[0]["messages"][number];

export type DiagnosticEventType =
  | "bootstrap"
  | "assemble"
  | "maintain"
  | "compact"
  | "fail-soft"
  | "hook";

export type DiagnosticEventRecord = {
  at: string;
  type: DiagnosticEventType;
  detail: Record<string, unknown>;
};

export type WorkingSetSnapshot = {
  messageCount: number;
  estimatedTokens: number;
  tokenBudget?: number;
  budgetUtilization?: number;
  protectedTailStartIndex: number;
  protectedTailMessageCount: number;
  protectedRecentTurns: number;
  includedCompactionSummary: boolean;
  reinjected: boolean;
  trimmedToBudget: boolean;
  collapsedHistory?: CollapsedHistorySnapshot;
  retainedPreview: WorkingSetPreviewEntry[];
  notes: string[];
};

export type WorkingSetPreviewEntry = {
  workingIndex: number;
  sourceIndex: number | null;
  role: string;
  kind: "source" | "reinjection" | "collapsed";
  textPreview: string;
  toolName?: string;
  toolCallId?: string;
};

export type CollapsedHistorySnapshot = {
  stage: "elevated" | "critical";
  sourceMessageCount: number;
  sourceTokenEstimate: number;
  preview: string;
  layers: CollapsedHistoryLayerSnapshot[];
  tokenSavingsEstimate: number;
};

export type CollapsedHistoryLayerSnapshot = {
  label: "archive" | "handoff";
  sourceStartIndex: number;
  sourceEndIndex: number;
  sourceMessageCount: number;
  sourceTokenEstimate: number;
  tokenSavingsEstimate: number;
  preview: string;
};

export type RewriteStatsSnapshot = {
  snipHits: number;
  microcompactHits: number;
  rewrittenEntries: number;
  bytesFreed: number;
  lastRewrittenAt?: string;
};

export type CompactionSnapshot = {
  at: string;
  ok: boolean;
  compacted: boolean;
  reason?: string;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
};

export type ReinjectionSnapshot = {
  summary?: string;
  recentFiles: string[];
  criticalToolOutputs: string[];
  mode: ReinjectionMode;
  rendered?: string;
};

export type FailSoftRecord = {
  at: string;
  phase: "maintain" | "compact" | "assemble" | "afterTurn" | "bootstrap";
  message: string;
};

export type ProjectContextSource = {
  kind: "userOpenclawMd" | "openclawMd" | "openclawLocalMd" | "pathRule" | "git";
  present: boolean;
  path?: string;
  summary?: string;
  usedForPrompt?: boolean;
  usedForCompaction?: boolean;
};

export type RuleMatchSource = {
  path: string;
  scope: string;
  origin: "user" | "workspace";
  specificity: number;
  matchedBy: Array<"edit" | "read" | "search" | "error" | "legacy">;
  summary?: string;
  usedForCompaction?: boolean;
};

export type ProjectContextSnapshot = {
  workspaceDir?: string;
  platform?: string;
  branch?: string;
  headSha?: string;
  recentCommits: string[];
  gitStatusSummary: string[];
  gitDiffSummary: string[];
  sources: ProjectContextSource[];
  stablePrefixPreview?: string;
  staticContextPreview?: string;
  dynamicContextPreview?: string;
  compactInstructionsPreview?: string;
  activeRuleMatches?: RuleMatchSource[];
  lastLoadedAt: string;
};

export type CacheUsageSnapshot = {
  runsObserved: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  recentStatuses?: Array<"hit" | "write" | "miss">;
  lastCacheReadTokens?: number;
  lastCacheWriteTokens?: number;
  lastProvider?: string;
  lastModel?: string;
  lastObservedAt?: string;
};

export type OverflowRisk = "low" | "medium" | "high";

export type PreflightAction = "none" | "snip-pressure-recommended" | "compact-recommended";

export type CacheHealthSnapshot = {
  supported: boolean;
  stablePrefixAvailable: boolean;
  runsObserved: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  recentStatuses: Array<"hit" | "write" | "miss">;
  recentStatus: "unknown" | "hit" | "write" | "miss";
  recentTrend: "unknown" | "warming" | "steady-hit" | "steady-miss" | "mixed";
  cacheMissAfterCompaction: boolean;
};

export type CompactionLifecycleSnapshot = {
  turnCounter: number;
  compactionCount: number;
  turnsSinceCompaction?: number;
  firstPostCompactionTurnAt?: string | null;
  lastTrigger?: "bootstrap" | "threshold" | "budget" | "force" | "manual" | "overflow" | "unknown";
  lastTokensBefore?: number;
  lastTokensAfter?: number;
  cacheMissAfterCompaction?: boolean;
  lastOverflowRecoveryAttempt?: number;
  lastOverflowRecoveryMaxAttempts?: number;
  lastOverflowRecoveryMode?: "standard" | "aggressive" | "rescue";
  overflowRecoveryProfile?: OverflowRecoveryProfile;
  currentBias?: CompactionBias;
  rapidReentryStage?: "elevated" | "critical";
  postCompactionRepeatedReads?: number;
};

export type PressureStage = "normal" | "elevated" | "critical" | "stabilizing";

export type CompactionBias = "normal" | "aggressive" | "rescue";

export type ReinjectionMode =
  | "summary+recent-files+critical-outputs"
  | "summary+recent-files"
  | "summary-only";

export type DebtBreakdown = {
  largeToolResultDebt: number;
  readBloatDebt: number;
  searchToolResultDebt: number;
  commandToolResultDebt: number;
  webToolResultDebt: number;
  collapseCandidateDebt: number;
  recentRewriteSavings: number;
  hardThresholdTokens?: number;
  estimatedTokens?: number;
  hardThresholdUtilization?: number;
};

export type BudgetHotspot = {
  toolName: string;
  target: string;
  category: "read" | "search" | "command" | "web" | "other";
  estimatedTokens: number;
  score: number;
  messageIndex: number;
  reasons: string[];
};

export type OverflowRecoveryProfile = {
  attempt: number;
  maxAttempts: number;
  mode: "standard" | "aggressive" | "rescue";
  canReduceOutputTokens: false;
};

export type ContextSuggestion = {
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  savingsTokens?: number;
};

export type UserNoticeSource =
  | "overflow-recovery"
  | "compaction"
  | "stale-read"
  | "path-rule";

export type UserNoticeLanguage = "zh" | "en";

export type PendingUserNotice = {
  key: string;
  source: UserNoticeSource;
  priority: 1 | 2 | 3 | 4;
  createdAt: string;
  language?: UserNoticeLanguage;
  message?: string;
};

export type DeliveredUserNotice = {
  key: string;
  source: UserNoticeSource;
  priority: 1 | 2 | 3 | 4;
  createdAt: string;
  deliveredAt: string;
  language: UserNoticeLanguage;
  message: string;
};

export type SessionDiagnosticsSnapshot = {
  sessionKey: string;
  sessionId?: string;
  sessionFile?: string;
  bootstrapped: boolean;
  protectedRecentTurns: number;
  autoCompactReserveTokens: number;
  recentFiles: string[];
  criticalToolOutputs: string[];
  latestSummarySnapshot?: string;
  lastCompaction?: CompactionSnapshot;
  lastWorkingSet?: WorkingSetSnapshot;
  reinjection?: ReinjectionSnapshot;
  projectContext?: ProjectContextSnapshot;
  pressureStage: PressureStage;
  compactionBias: CompactionBias;
  reinjectionMode: ReinjectionMode;
  debtBreakdown: DebtBreakdown;
  budgetHotspots: BudgetHotspot[];
  stabilizationTurnsRemaining: number;
  cacheUsage: CacheUsageSnapshot;
  compactionLifecycle: CompactionLifecycleSnapshot;
  rewrites: RewriteStatsSnapshot;
  pendingUserNotice?: PendingUserNotice | undefined;
  lastDeliveredUserNotice?: DeliveredUserNotice | undefined;
  userNoticeSource?: UserNoticeSource | undefined;
  failSoft: FailSoftRecord[];
  lastUpdatedAt: string;
};

export type DiagnosticsOverview = {
  engineId: string;
  trackedSessions: number;
  lastCompaction?: CompactionSnapshot & { sessionKey: string };
  recentFailures: Array<FailSoftRecord & { sessionKey: string }>;
};

export type TranscriptHeaderEntry = {
  type: "session";
  id?: string;
  cwd?: string;
};

export type TranscriptMessageEntry = {
  type: "message";
  id: string;
  parentId?: string | null;
  timestamp?: string | number;
  message: ContextMessage;
};

export type TranscriptCompactionEntry = {
  type: "compaction";
  id: string;
  parentId?: string | null;
  timestamp?: string | number;
  summary: string;
  firstKeptEntryId?: string | null;
  tokensBefore: number;
  tokensAfter?: number;
  details?: unknown;
};

export type TranscriptGenericEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  [key: string]: unknown;
};

export type TranscriptBranchEntry =
  | TranscriptMessageEntry
  | TranscriptCompactionEntry
  | TranscriptGenericEntry;

export type ToolCallRef = {
  toolCallId: string;
  toolName: string;
  assistantEntryId: string;
  messageIndex: number;
  path?: string;
  args?: Record<string, unknown>;
};

export type IndexedToolResult = {
  entryId: string;
  messageIndex: number;
  toolCallId?: string;
  toolName: string;
  path?: string;
  args?: Record<string, unknown>;
  text: string;
  isError: boolean;
  isProtected: boolean;
  message: Extract<ContextMessage, { role: "toolResult" }>;
};

export type ActiveScopeSignal = {
  path: string;
  source: "edit" | "read" | "search" | "error" | "legacy";
  messageIndex: number;
};

export type TranscriptIndex = {
  sessionId?: string;
  workspaceDir?: string;
  branch: TranscriptBranchEntry[];
  messageEntries: TranscriptMessageEntry[];
  compactions: TranscriptCompactionEntry[];
  latestCompaction?: TranscriptCompactionEntry;
  protectedTailStartIndex: number;
  toolCallsById: Map<string, ToolCallRef>;
  toolResults: IndexedToolResult[];
};
