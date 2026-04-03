import type { PluginRuntimeConfig } from "../config.js";
import { resolvePressureProfile, type PressureProfile } from "../context-engine/pressure.js";
import { buildTranscriptIndex } from "../context-engine/transcript-index.js";
import type { ContextSuggestion, SessionDiagnosticsSnapshot } from "../context-engine/types.js";
import {
  buildCacheHealth,
  listRuleMatchSources,
  hasCacheBustRisk,
  resolveOverflowRisk,
  resolvePreflightAction,
} from "./context-health.js";

function buildNearCapacitySuggestion(
  session: SessionDiagnosticsSnapshot,
  profile: PressureProfile,
): ContextSuggestion | undefined {
  const estimated =
    profile.debtBreakdown.estimatedTokens ?? session.lastWorkingSet?.estimatedTokens;
  const hardThreshold = profile.debtBreakdown.hardThresholdTokens;
  const utilization = profile.debtBreakdown.hardThresholdUtilization ?? 0;
  if (!estimated || !hardThreshold || utilization < 0.85) return undefined;
  const severity: ContextSuggestion["severity"] = utilization >= 0.95 ? "critical" : "warn";
  return {
    severity,
    title: "Working set is near the token limit",
    detail: `Current working set is ${estimated}/${hardThreshold} estimated tokens against the effective hard threshold (${Math.round(utilization * 100)}%). Another large tool result is likely to trigger compaction soon.`,
    savingsTokens: Math.max(0, estimated - Math.floor(hardThreshold * 0.7)),
  };
}

function buildAutoCompactSuggestion(
  config: PluginRuntimeConfig,
  profile: PressureProfile,
): ContextSuggestion | undefined {
  if (config.autoCompactEnabled) return undefined;
  const utilization = profile.debtBreakdown.hardThresholdUtilization ?? 0;
  return {
    severity: utilization >= 0.7 ? "warn" : "info",
    title: "Auto compaction is disabled",
    detail:
      "ClawXContext will keep snipping and stale-read cleanup active, but it will not proactively compact near the token limit.",
  };
}

function buildLargeToolResultSuggestion(profile: PressureProfile): ContextSuggestion | undefined {
  const largeResult = profile.largestLargeToolResult;
  if (!largeResult || profile.debtBreakdown.largeToolResultDebt <= 0) return undefined;
  const label = largeResult.path
    ? `${largeResult.toolName} ${largeResult.path}`
    : largeResult.toolName;
  return {
    severity: largeResult.text.length >= 4_000 ? "critical" : "warn",
    title: "Large tool result is still resident in transcript history",
    detail: `${label} still contributes a large payload outside the protected tail. This is a good candidate for additional snip pressure or manual compaction.`,
    savingsTokens: profile.debtBreakdown.largeToolResultDebt,
  };
}

function buildReadBloatSuggestion(profile: PressureProfile): ContextSuggestion | undefined {
  if (!profile.readBloatPath || profile.debtBreakdown.readBloatDebt <= 0) return undefined;
  return {
    severity: profile.stage === "critical" ? "warn" : "info",
    title: "Repeated file reads are bloating transcript history",
    detail: `${profile.readBloatPath} has multiple stale read payloads still resident in transcript history. Older reads are likely low-value once later edits or newer reads exist.`,
    savingsTokens: profile.debtBreakdown.readBloatDebt,
  };
}

function buildToolBudgetSuggestion(profile: PressureProfile): ContextSuggestion | undefined {
  const dominant = profile.budgetHotspots[0];
  if (!dominant) return undefined;
  return {
    severity: profile.stage === "critical" ? "warn" : "info",
    title: `${dominant.toolName} output is dominating transcript budget`,
    detail: `${dominant.toolName} ${dominant.target} is currently the top transcript hotspot (${dominant.estimatedTokens} estimated tokens). Factors: ${dominant.reasons.join(", ")}.`,
    savingsTokens: dominant.estimatedTokens,
  };
}

function buildRecentCompactionRiskSuggestion(
  session: SessionDiagnosticsSnapshot,
): ContextSuggestion | undefined {
  if (!session.lastCompaction?.compacted) return undefined;
  const turnsSince = session.compactionLifecycle.turnsSinceCompaction;
  if (typeof turnsSince !== "number" || turnsSince > 2) return undefined;
  const cacheMiss = session.compactionLifecycle.cacheMissAfterCompaction === true;
  return {
    severity: cacheMiss ? "warn" : "info",
    title: "Session is still close to a recent compaction boundary",
    detail: cacheMiss
      ? "The most recent post-compaction run had no cache reads, so the agent may still be rebuilding stable context. Keep the next few turns tight."
      : `Compaction happened ${turnsSince} turn${turnsSince === 1 ? "" : "s"} ago. Avoid dumping large tool outputs until the new working set stabilizes.`,
  };
}

function buildCompactionQualitySuggestion(
  session: SessionDiagnosticsSnapshot,
): ContextSuggestion | undefined {
  const rapidReentryStage = session.compactionLifecycle.rapidReentryStage;
  const repeatedReads = session.compactionLifecycle.postCompactionRepeatedReads ?? 0;
  if (!rapidReentryStage && repeatedReads <= 0) return undefined;
  return {
    severity: rapidReentryStage === "critical" ? "warn" : "info",
    title: "Recent compaction may not be holding cleanly",
    detail:
      rapidReentryStage === "critical"
        ? `The session re-entered ${rapidReentryStage} pressure soon after compaction${repeatedReads > 0 ? ` and repeated ${repeatedReads} file read${repeatedReads === 1 ? "" : "s"}` : ""}. A tighter compact or more aggressive snip pressure is likely warranted.`
        : repeatedReads > 0
          ? `The first post-compaction turns already repeated ${repeatedReads} file read${repeatedReads === 1 ? "" : "s"}. The compact summary may be missing key operational detail.`
          : `The session quickly re-entered ${rapidReentryStage} pressure after compaction. Consider a more aggressive compact before the next large turn.`,
  };
}

function buildCompactionBiasSuggestion(
  session: SessionDiagnosticsSnapshot,
): ContextSuggestion | undefined {
  if (session.compactionBias === "normal") return undefined;
  return {
    severity: session.compactionBias === "rescue" ? "warn" : "info",
    title: "Next compaction is biased to be more aggressive",
    detail:
      session.compactionBias === "rescue"
        ? "ClawXContext has elevated the next compaction into rescue posture because recent recovery signals were weak."
        : "ClawXContext has elevated the next compaction into aggressive posture because recent recovery signals suggest the session needs a tighter summary.",
  };
}

function buildRuleMatchSuggestion(
  session: SessionDiagnosticsSnapshot,
): ContextSuggestion | undefined {
  const matches = listRuleMatchSources(session);
  if (matches.length === 0) return undefined;
  const top = matches[0]!;
  return {
    severity: "info",
    title: "Task-scoped OPENCLAW rules are active",
    detail: `The current task scope is activating rule ${top.scope} (${top.origin}) via ${top.matchedBy.join(", ")} signals.`,
  };
}

function buildPreflightCompactSuggestion(
  session: SessionDiagnosticsSnapshot,
  profile: PressureProfile,
): ContextSuggestion | undefined {
  const derivedSession = {
    ...session,
    pressureStage: profile.stage,
    reinjectionMode: profile.reinjectionMode,
    debtBreakdown: profile.debtBreakdown,
  };
  if (resolvePreflightAction(derivedSession) !== "compact-recommended") {
    return undefined;
  }
  const estimated = profile.debtBreakdown.estimatedTokens ?? session.lastWorkingSet?.estimatedTokens;
  const hardThreshold = profile.debtBreakdown.hardThresholdTokens;
  return {
    severity: resolveOverflowRisk(derivedSession) === "high" ? "critical" : "warn",
    title: "Compact before the next large turn",
    detail:
      estimated && hardThreshold
        ? `The session is operating close to the effective hard threshold (${estimated}/${hardThreshold} estimated tokens). Another large tool result is likely to force compaction or overflow recovery.`
        : "The session is already in a critical pressure stage. Compact before dumping more tool output into the transcript.",
  };
}

function buildCacheAwareSuggestion(
  session: SessionDiagnosticsSnapshot,
): ContextSuggestion | undefined {
  const cacheHealth = buildCacheHealth(session);
  if (!hasCacheBustRisk(session)) return undefined;
  return {
    severity: cacheHealth.cacheMissAfterCompaction ? "warn" : "info",
    title: "Dynamic context is eroding prompt-cache reuse",
    detail: cacheHealth.cacheMissAfterCompaction
      ? "The last post-compaction run had no cache reads even though a stable prefix exists. Keep git state, reinjection payloads, and large tool outputs tight for the next few turns."
      : "A stable prefix is available, but recent runs are not showing cache reads. High-churn dynamic context is likely busting prompt-cache reuse.",
  };
}

export async function buildContextSuggestions(params: {
  config: PluginRuntimeConfig;
  session: SessionDiagnosticsSnapshot;
}): Promise<ContextSuggestion[]> {
  const index = params.session.sessionFile
    ? await buildTranscriptIndex({
        sessionFile: params.session.sessionFile,
        protectedRecentTurns: params.session.protectedRecentTurns,
      }).catch(() => undefined)
    : undefined;
  const profile = resolvePressureProfile({
    config: params.config,
    session: params.session,
    ...(index ? { index } : {}),
  });
  const suggestions: ContextSuggestion[] = [];
  const nearCapacity = buildNearCapacitySuggestion(params.session, profile);
  if (nearCapacity) suggestions.push(nearCapacity);

  const autoCompact = buildAutoCompactSuggestion(params.config, profile);
  if (autoCompact) suggestions.push(autoCompact);

  const largeToolResult = buildLargeToolResultSuggestion(profile);
  if (largeToolResult) suggestions.push(largeToolResult);
  const readBloat = buildReadBloatSuggestion(profile);
  if (readBloat) suggestions.push(readBloat);
  const toolBudget = buildToolBudgetSuggestion(profile);
  if (toolBudget) suggestions.push(toolBudget);

  const recentCompaction = buildRecentCompactionRiskSuggestion(params.session);
  if (recentCompaction) suggestions.push(recentCompaction);
  const compactionQuality = buildCompactionQualitySuggestion(params.session);
  if (compactionQuality) suggestions.push(compactionQuality);
  const compactionBias = buildCompactionBiasSuggestion(params.session);
  if (compactionBias) suggestions.push(compactionBias);
  const preflightCompact = buildPreflightCompactSuggestion(params.session, profile);
  if (preflightCompact) suggestions.push(preflightCompact);
  const cacheAware = buildCacheAwareSuggestion(params.session);
  if (cacheAware) suggestions.push(cacheAware);
  const ruleMatch = buildRuleMatchSuggestion(params.session);
  if (ruleMatch) suggestions.push(ruleMatch);

  return suggestions;
}
