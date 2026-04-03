import type {
  CacheHealthSnapshot,
  OverflowRecoveryProfile,
  OverflowRisk,
  PreflightAction,
  ProjectContextSource,
  RuleMatchSource,
  SessionDiagnosticsSnapshot,
} from "../context-engine/types.js";

const PROJECT_RULE_KINDS = new Set([
  "userOpenclawMd",
  "openclawMd",
  "openclawLocalMd",
  "pathRule",
]);

export function listProjectRuleSources(
  session: SessionDiagnosticsSnapshot,
): ProjectContextSource[] {
  return (
    session.projectContext?.sources.filter((source) => PROJECT_RULE_KINDS.has(source.kind)) ?? []
  );
}

export function listRuleMatchSources(
  session: SessionDiagnosticsSnapshot,
): RuleMatchSource[] {
  return session.projectContext?.activeRuleMatches ?? [];
}

export function buildStablePrefixPreview(
  session: SessionDiagnosticsSnapshot,
): string | undefined {
  return (
    session.projectContext?.stablePrefixPreview ??
    session.projectContext?.staticContextPreview ??
    undefined
  );
}

export function resolveOverflowRisk(session: SessionDiagnosticsSnapshot): OverflowRisk {
  const utilization = session.debtBreakdown.hardThresholdUtilization ?? 0;
  if (session.pressureStage === "critical" || utilization >= 0.95) {
    return "high";
  }
  if (session.pressureStage === "elevated" || session.pressureStage === "stabilizing" || utilization >= 0.85) {
    return "medium";
  }
  return "low";
}

export function resolvePreflightAction(
  session: SessionDiagnosticsSnapshot,
): PreflightAction {
  const overflowRisk = resolveOverflowRisk(session);
  if (overflowRisk === "high") {
    return "compact-recommended";
  }
  if (
    session.debtBreakdown.largeToolResultDebt > 0 ||
    session.debtBreakdown.readBloatDebt > 0 ||
    session.debtBreakdown.searchToolResultDebt > 0 ||
    session.debtBreakdown.commandToolResultDebt > 0 ||
    session.debtBreakdown.webToolResultDebt > 0
  ) {
    return "snip-pressure-recommended";
  }
  return "none";
}

export function buildCacheHealth(
  session: SessionDiagnosticsSnapshot,
): CacheHealthSnapshot {
  const lastRead = session.cacheUsage.lastCacheReadTokens ?? 0;
  const lastWrite = session.cacheUsage.lastCacheWriteTokens ?? 0;
  const recentStatuses = session.cacheUsage.recentStatuses ?? [];
  let recentStatus: CacheHealthSnapshot["recentStatus"] = "unknown";
  if (lastRead > 0) {
    recentStatus = "hit";
  } else if (lastWrite > 0) {
    recentStatus = "write";
  } else if (session.cacheUsage.runsObserved > 0) {
    recentStatus = "miss";
  }

  let recentTrend: CacheHealthSnapshot["recentTrend"] = "unknown";
  if (recentStatuses.length > 0) {
    if (recentStatuses.every((status) => status === "hit")) {
      recentTrend = "steady-hit";
    } else if (recentStatuses.every((status) => status === "miss")) {
      recentTrend = "steady-miss";
    } else if (
      recentStatuses[recentStatuses.length - 1] === "hit" &&
      recentStatuses.slice(0, -1).some((status) => status !== "hit")
    ) {
      recentTrend = "warming";
    } else {
      recentTrend = "mixed";
    }
  }

  return {
    supported:
      session.cacheUsage.runsObserved > 0 || Boolean(session.cacheUsage.lastProvider?.trim()),
    stablePrefixAvailable: Boolean(buildStablePrefixPreview(session)),
    runsObserved: session.cacheUsage.runsObserved,
    totalCacheReadTokens: session.cacheUsage.totalCacheReadTokens,
    totalCacheWriteTokens: session.cacheUsage.totalCacheWriteTokens,
    recentStatuses,
    recentStatus,
    recentTrend,
    cacheMissAfterCompaction: session.compactionLifecycle.cacheMissAfterCompaction === true,
  };
}

export function buildOverflowRecoveryProfile(
  session: SessionDiagnosticsSnapshot,
): OverflowRecoveryProfile | undefined {
  return session.compactionLifecycle.overflowRecoveryProfile;
}

export function hasCacheBustRisk(session: SessionDiagnosticsSnapshot): boolean {
  const cacheHealth = buildCacheHealth(session);
  const utilization = session.debtBreakdown.hardThresholdUtilization ?? 0;
  return (
    cacheHealth.stablePrefixAvailable &&
    cacheHealth.recentStatus === "miss" &&
    (utilization >= 0.75 ||
      session.pressureStage === "elevated" ||
      session.pressureStage === "critical")
  );
}
