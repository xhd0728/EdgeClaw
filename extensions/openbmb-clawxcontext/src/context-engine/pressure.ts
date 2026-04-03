import type { PluginRuntimeConfig } from "../config.js";
import { buildTranscriptDebtAnalysis, type TranscriptDebtAnalysis } from "./budget-manager.js";
import type {
  CompactionBias,
  PressureStage,
  ReinjectionMode,
  SessionDiagnosticsSnapshot,
  TranscriptIndex,
} from "./types.js";

const ELEVATED_UTILIZATION = 0.85;
const CRITICAL_UTILIZATION = 0.95;

export type PressureProfile = TranscriptDebtAnalysis & {
  stage: PressureStage;
  reinjectionMode: ReinjectionMode;
};

export function getReinjectionModeForStage(stage: PressureStage): ReinjectionMode {
  if (stage === "normal") return "summary+recent-files+critical-outputs";
  if (stage === "elevated") return "summary+recent-files";
  return "summary-only";
}

const BIAS_ORDER: Record<CompactionBias, number> = {
  normal: 0,
  aggressive: 1,
  rescue: 2,
};

export function maxCompactionBias(left: CompactionBias, right: CompactionBias): CompactionBias {
  return BIAS_ORDER[left] >= BIAS_ORDER[right] ? left : right;
}

export function decayCompactionBias(bias: CompactionBias): CompactionBias {
  if (bias === "rescue") return "aggressive";
  if (bias === "aggressive") return "normal";
  return "normal";
}

export function applyCompactionBiasToReinjectionMode(
  mode: ReinjectionMode,
  bias: CompactionBias,
): ReinjectionMode {
  if (bias === "rescue") return "summary-only";
  if (bias === "aggressive" && mode === "summary+recent-files+critical-outputs") {
    return "summary+recent-files";
  }
  return mode;
}

export function resolvePressureProfile(params: {
  config: PluginRuntimeConfig;
  session: SessionDiagnosticsSnapshot;
  index?: TranscriptIndex;
  estimatedTokens?: number;
  tokenBudget?: number;
}): PressureProfile {
  const estimatedTokens =
    typeof params.estimatedTokens === "number"
      ? params.estimatedTokens
      : params.session.lastWorkingSet?.estimatedTokens;
  const tokenBudget =
    typeof params.tokenBudget === "number" ? params.tokenBudget : params.session.lastWorkingSet?.tokenBudget;
  const debt = buildTranscriptDebtAnalysis({
    config: params.config,
    rewrites: params.session.rewrites,
    ...(params.index ? { index: params.index } : {}),
    ...(typeof estimatedTokens === "number" ? { estimatedTokens } : {}),
    ...(typeof tokenBudget === "number" ? { tokenBudget } : {}),
  });
  const totalToolDebt =
    debt.debtBreakdown.largeToolResultDebt +
    debt.debtBreakdown.searchToolResultDebt +
    debt.debtBreakdown.commandToolResultDebt +
    debt.debtBreakdown.webToolResultDebt;
  const hardThresholdTokens = debt.debtBreakdown.hardThresholdTokens ?? 0;
  const estimatedTokenCount = debt.debtBreakdown.estimatedTokens ?? 0;
  const hasBudgetHeavyToolHistory =
    totalToolDebt >= 1_200 &&
    (hardThresholdTokens <= 0 || totalToolDebt >= Math.floor(hardThresholdTokens * 0.18));
  const hasCollapsePressure =
    debt.debtBreakdown.collapseCandidateDebt >=
      Math.max(600, hardThresholdTokens > 0 ? Math.floor(hardThresholdTokens * 0.15) : 600) &&
    ((debt.debtBreakdown.hardThresholdUtilization ?? 0) >= 0.6 || estimatedTokenCount >= 1_800);

  let stage: PressureStage = "normal";
  if (params.session.stabilizationTurnsRemaining > 0) {
    stage = "stabilizing";
  } else if (
    debt.hasVeryLargeUnprotectedToolResult ||
    hasBudgetHeavyToolHistory ||
    (debt.debtBreakdown.hardThresholdUtilization ?? 0) >= CRITICAL_UTILIZATION
  ) {
    stage = "critical";
  } else if (
    debt.hasReadBloat ||
    debt.debtBreakdown.searchToolResultDebt > 0 ||
    debt.debtBreakdown.commandToolResultDebt > 0 ||
    debt.debtBreakdown.webToolResultDebt > 0 ||
    hasCollapsePressure ||
    (debt.debtBreakdown.hardThresholdUtilization ?? 0) >= ELEVATED_UTILIZATION
  ) {
    stage = "elevated";
  }

  return {
    ...debt,
    stage,
    reinjectionMode: getReinjectionModeForStage(stage),
  };
}
