import type {
  ContextEngine,
  ContextEngineMaintenanceResult,
} from "openclaw/plugin-sdk";
import { PLUGIN_ID, type PluginRuntimeConfig } from "../config.js";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import { assembleWorkingSet } from "./assemble.js";
import { bootstrapContextSession } from "./bootstrap.js";
import { compactContext } from "./compact.js";
import { maintainContextTranscript } from "./maintain.js";
import {
  applyCompactionBiasToReinjectionMode,
  decayCompactionBias,
  maxCompactionBias,
  resolvePressureProfile,
} from "./pressure.js";
import type { ProjectContextManager } from "./project-context.js";
import { buildReinjectionSnapshot } from "./reinjection.js";
import {
  buildTranscriptIndex,
  collectCriticalToolOutputsFromMessages,
  collectRecentFilesFromMessages,
  extractPathFromArguments,
  extractToolCalls,
} from "./transcript-index.js";
import { estimateMessagesTokens } from "./token-budget.js";

function nowIso(): string {
  return new Date().toISOString();
}

function countRepeatedReadsAfterCompaction(
  messages: Parameters<ContextEngine["assemble"]>[0]["messages"],
  priorRecentFiles: string[],
): number {
  if (priorRecentFiles.length === 0) return 0;
  const prior = new Set(priorRecentFiles);
  const repeated = new Set<string>();
  for (const message of messages) {
    for (const toolCall of extractToolCalls(message)) {
      if (toolCall.name !== "read") continue;
      const filePath = extractPathFromArguments(toolCall.arguments);
      if (filePath && prior.has(filePath)) {
        repeated.add(filePath);
      }
    }
  }
  return repeated.size;
}

function resolveNextCompactionBias(params: {
  currentBias: "normal" | "aggressive" | "rescue";
  nextStage: "normal" | "elevated" | "critical" | "stabilizing";
  rapidReentryStage?: "elevated" | "critical";
  repeatedReads: number;
  cacheMissAfterCompaction: boolean;
}): "normal" | "aggressive" | "rescue" {
  if (params.rapidReentryStage === "critical" || params.repeatedReads >= 2) {
    return maxCompactionBias(params.currentBias, "rescue");
  }
  if (
    params.rapidReentryStage === "elevated" ||
    params.cacheMissAfterCompaction ||
    params.repeatedReads === 1
  ) {
    return maxCompactionBias(params.currentBias, "aggressive");
  }
  if (params.nextStage === "normal") {
    return decayCompactionBias(params.currentBias);
  }
  return params.currentBias;
}

class ClawXContextEngine implements ContextEngine {
  readonly info = {
    id: PLUGIN_ID,
    name: "ClawXContext",
    version: "0.1.0",
    ownsCompaction: true,
  };

  constructor(
    private readonly config: PluginRuntimeConfig,
    private readonly store: ContextDiagnosticsStore,
    private readonly projectContextManager?: ProjectContextManager,
  ) {}

  async bootstrap(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }) {
    return await bootstrapContextSession({
      config: this.config,
      store: this.store,
      ...(this.projectContextManager ? { projectContextManager: this.projectContextManager } : {}),
      ...params,
    });
  }

  async maintain(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: Record<string, unknown>;
  }): Promise<ContextEngineMaintenanceResult> {
    return await maintainContextTranscript({
      config: this.config,
      store: this.store,
      ...params,
    });
  }

  async ingest(): Promise<{ ingested: boolean }> {
    return { ingested: true };
  }

  async ingestBatch(params: {
    messages: unknown[];
  }): Promise<{ ingestedCount: number }> {
    return { ingestedCount: params.messages.length };
  }

  async afterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: Parameters<ContextEngine["assemble"]>[0]["messages"];
    prePromptMessageCount: number;
    autoCompactionSummary?: string;
    tokenBudget?: number;
    runtimeContext?: Record<string, unknown>;
  }): Promise<void> {
    const sessionKey = params.sessionKey?.trim() || params.sessionId;
    const recentFiles = collectRecentFilesFromMessages(
      params.messages,
      this.config.reinjectRecentFiles,
    );
    const criticalToolOutputs = collectCriticalToolOutputsFromMessages(
      params.messages,
      this.config.reinjectCriticalToolOutputs,
    );
    const currentSession = await this.store.getSession(sessionKey);
    const latestSummarySnapshot =
      params.autoCompactionSummary?.trim() || currentSession.latestSummarySnapshot;
    const estimatedTokens = estimateMessagesTokens(params.messages);
    const transcriptIndex = await buildTranscriptIndex({
      sessionFile: params.sessionFile,
      protectedRecentTurns: this.config.protectedRecentTurns,
    }).catch(() => undefined);
    const currentProfile = resolvePressureProfile({
      config: this.config,
      session: currentSession,
      estimatedTokens,
      ...(transcriptIndex ? { index: transcriptIndex } : {}),
      ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
    });
    const nextStabilizationTurnsRemaining =
      currentProfile.stage === "stabilizing"
        ? Math.max(0, currentSession.stabilizationTurnsRemaining - 1)
        : currentSession.stabilizationTurnsRemaining;
    const nextProfile =
      currentProfile.stage === "stabilizing"
        ? resolvePressureProfile({
            config: this.config,
            session: {
              ...currentSession,
              stabilizationTurnsRemaining: nextStabilizationTurnsRemaining,
            },
            estimatedTokens,
            ...(transcriptIndex ? { index: transcriptIndex } : {}),
            ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
          })
        : currentProfile;
    const repeatedReads =
      typeof currentSession.compactionLifecycle.turnsSinceCompaction === "number" &&
      currentSession.compactionLifecycle.turnsSinceCompaction <= 1
        ? countRepeatedReadsAfterCompaction(params.messages, currentSession.recentFiles)
        : 0;
    const postCompactionQualityProfile =
      typeof currentSession.compactionLifecycle.turnsSinceCompaction === "number" &&
      currentSession.compactionLifecycle.turnsSinceCompaction <= 1
        ? resolvePressureProfile({
            config: this.config,
            session: {
              ...currentSession,
              stabilizationTurnsRemaining: 0,
            },
            estimatedTokens,
            ...(transcriptIndex ? { index: transcriptIndex } : {}),
            ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
          })
        : undefined;
    const rapidReentryStage =
      postCompactionQualityProfile?.stage === "elevated" ||
      postCompactionQualityProfile?.stage === "critical"
        ? postCompactionQualityProfile.stage
        : undefined;
    const nextBias = resolveNextCompactionBias({
      currentBias: currentSession.compactionBias,
      nextStage: nextProfile.stage,
      ...(rapidReentryStage ? { rapidReentryStage } : {}),
      repeatedReads,
      cacheMissAfterCompaction: currentSession.compactionLifecycle.cacheMissAfterCompaction === true,
    });
    const reinjection = buildReinjectionSnapshot(
      {
        config: this.config,
        recentFiles,
        criticalToolOutputs,
        mode: applyCompactionBiasToReinjectionMode(nextProfile.reinjectionMode, nextBias),
        ...(latestSummarySnapshot ? { summary: latestSummarySnapshot } : {}),
      },
    );

    await this.store.updateSessionContext({
      sessionKey,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      recentFiles,
      criticalToolOutputs,
      ...(latestSummarySnapshot ? { latestSummarySnapshot } : {}),
      ...(reinjection ? { reinjection } : {}),
    });
    await this.store.updatePressureState({
      sessionKey,
      pressureStage: nextProfile.stage,
      compactionBias: nextBias,
      reinjectionMode: applyCompactionBiasToReinjectionMode(nextProfile.reinjectionMode, nextBias),
      debtBreakdown: nextProfile.debtBreakdown,
      budgetHotspots: nextProfile.budgetHotspots,
      stabilizationTurnsRemaining: nextStabilizationTurnsRemaining,
    });
    if (
      typeof currentSession.compactionLifecycle.turnsSinceCompaction === "number" &&
      currentSession.compactionLifecycle.turnsSinceCompaction <= 1
    ) {
      await this.store.recordCompactionQuality({
        sessionKey,
        ...(rapidReentryStage
          ? { rapidReentryStage }
          : { rapidReentryStage: null }),
        postCompactionRepeatedReads: repeatedReads,
      });
    } else if (
      typeof currentSession.compactionLifecycle.turnsSinceCompaction === "number" &&
      currentSession.compactionLifecycle.turnsSinceCompaction > 1 &&
      (currentSession.compactionLifecycle.rapidReentryStage ||
        (currentSession.compactionLifecycle.postCompactionRepeatedReads ?? 0) > 0) &&
      nextProfile.stage === "normal"
    ) {
      await this.store.recordCompactionQuality({
        sessionKey,
        clear: true,
      });
    }
    await this.store.recordTurn(sessionKey);
    const hardThreshold =
      typeof params.tokenBudget === "number" && params.tokenBudget > 0
        ? Math.max(0, params.tokenBudget - this.config.autoCompactReserveTokens)
        : undefined;
    const isAboveHardThreshold =
      typeof hardThreshold === "number" && estimatedTokens >= hardThreshold;
    const shouldPreemptivelyCompact =
      nextProfile.stage === "critical" &&
      (nextProfile.debtBreakdown.hardThresholdUtilization ?? 0) >= 0.95;
    const shouldCompact =
      this.config.autoCompactEnabled &&
      typeof params.tokenBudget === "number" &&
      params.tokenBudget > 0 &&
      (isAboveHardThreshold || shouldPreemptivelyCompact);

    if (!shouldCompact) {
      return;
    }

    const result = await compactContext(
      {
        config: this.config,
        store: this.store,
        sessionId: params.sessionId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        sessionFile: params.sessionFile,
        ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
        currentTokenCount: estimatedTokens,
        compactionTarget: isAboveHardThreshold ? "threshold" : "budget",
        ...(params.runtimeContext ? { runtimeContext: params.runtimeContext } : {}),
        ...(this.projectContextManager ? { projectContextManager: this.projectContextManager } : {}),
      },
    );

    if (!result.ok) {
      await this.store.noteFailSoft(sessionKey, {
        at: nowIso(),
        phase: "afterTurn",
        message: result.reason ?? "auto compact failed",
      });
    }
  }

  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: Parameters<ContextEngine["assemble"]>[0]["messages"];
    tokenBudget?: number;
  }) {
    return await assembleWorkingSet({
      config: this.config,
      store: this.store,
      ...(this.projectContextManager ? { projectContextManager: this.projectContextManager } : {}),
      ...params,
    });
  }

  async compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: Record<string, unknown>;
  }) {
    return await compactContext({
      config: this.config,
      store: this.store,
      ...params,
      ...(this.projectContextManager ? { projectContextManager: this.projectContextManager } : {}),
    });
  }

  async dispose(): Promise<void> {}
}

export function createContextEngine(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  projectContextManager?: ProjectContextManager;
}): ContextEngine {
  return new ClawXContextEngine(params.config, params.store, params.projectContextManager);
}
