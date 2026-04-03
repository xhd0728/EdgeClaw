import { delegateCompactionToRuntime, type ContextEngineRuntimeContext } from "openclaw/plugin-sdk";
import type { PluginRuntimeConfig } from "../config.js";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import {
  applyCompactionBiasToReinjectionMode,
  getReinjectionModeForStage,
  maxCompactionBias,
} from "./pressure.js";
import type { ProjectContextManager } from "./project-context.js";
import { buildReinjectionSnapshot } from "./reinjection.js";
import { buildTranscriptIndex } from "./transcript-index.js";
import type { CompactionBias, OverflowRecoveryProfile } from "./types.js";
import { buildPendingUserNotice } from "./user-notices.js";

function nowIso(): string {
  return new Date().toISOString();
}

type OverflowRecoveryMode = "standard" | "aggressive" | "rescue";

type OverflowRecoveryInfo = {
  attempt: number;
  maxAttempts: number;
  currentTokenCount?: number;
  mode: OverflowRecoveryMode;
};

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resolveOverflowRecovery(
  runtimeContext: ContextEngineRuntimeContext | undefined,
): OverflowRecoveryInfo | undefined {
  const trigger =
    typeof runtimeContext?.trigger === "string" ? runtimeContext.trigger.trim() : "";
  if (trigger !== "overflow") return undefined;
  const attempt = Math.max(1, Math.trunc(readNumber(runtimeContext?.attempt) ?? 1));
  const maxAttempts = Math.max(
    attempt,
    Math.trunc(readNumber(runtimeContext?.maxAttempts) ?? attempt),
  );
  const mode: OverflowRecoveryMode =
    attempt >= 3 ? "rescue" : attempt >= 2 ? "aggressive" : "standard";
  return {
    attempt,
    maxAttempts,
    ...(typeof runtimeContext?.currentTokenCount === "number"
      ? { currentTokenCount: runtimeContext.currentTokenCount }
      : {}),
    mode,
  };
}

function joinInstructions(...blocks: Array<string | undefined>): string | undefined {
  const normalized = blocks
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return normalized.length > 0 ? normalized.join("\n\n") : undefined;
}

function buildOverflowRecoveryInstructions(info: OverflowRecoveryInfo): string {
  const shared =
    "This compaction is running as overflow recovery inside OpenClaw. Produce a compact, structured summary that preserves only what is necessary to continue the active task.";
  if (info.mode === "rescue") {
    return [
      shared,
      `Overflow recovery attempt ${info.attempt}/${info.maxAttempts}.`,
      "Rescue mode: keep only the active task goal, directly edited files, one-line blockers/errors, and the exact next action. Drop background exploration, redundant tool output, and old alternatives.",
    ].join("\n");
  }
  if (info.mode === "aggressive") {
    return [
      shared,
      `Overflow recovery attempt ${info.attempt}/${info.maxAttempts}.`,
      "Aggressive mode: keep the active task, directly relevant files, unresolved blockers, and essential command/error results. Omit redundant tool payloads and older exploratory branches.",
    ].join("\n");
  }
  return [
    shared,
    `Overflow recovery attempt ${info.attempt}/${info.maxAttempts}.`,
    "Standard overflow mode: keep the active task, current blockers, recently touched files, and the minimum recent tool context required to resume without re-reading the entire transcript.",
  ].join("\n");
}

function buildBiasInstructions(bias: CompactionBias): string | undefined {
  if (bias === "rescue") {
    return [
      "Compaction bias: rescue.",
      "Keep only the active task goal, edited files, active blocker/error state, and the exact next action. Prefer omission over completeness.",
    ].join("\n");
  }
  if (bias === "aggressive") {
    return [
      "Compaction bias: aggressive.",
      "Favor a shorter summary that keeps current blockers, directly relevant files, and the minimum recent operational context needed to continue the task.",
    ].join("\n");
  }
  return undefined;
}

function buildOverflowRecoveryProfile(
  info: OverflowRecoveryInfo | undefined,
): OverflowRecoveryProfile | undefined {
  if (!info) return undefined;
  return {
    attempt: info.attempt,
    maxAttempts: info.maxAttempts,
    mode: info.mode,
    canReduceOutputTokens: false,
  };
}

function resolveBiasAfterCompaction(params: {
  currentBias: CompactionBias;
  overflowRecovery?: OverflowRecoveryInfo;
}): CompactionBias {
  if (!params.overflowRecovery) {
    return params.currentBias;
  }
  if (params.overflowRecovery.mode === "rescue") return "rescue";
  return maxCompactionBias(params.currentBias, "aggressive");
}

function trimSummaryForOverflow(summary: string | undefined, info: OverflowRecoveryInfo | undefined): string | undefined {
  const trimmed = summary?.trim();
  if (!trimmed) return undefined;
  const maxLength = info?.mode === "rescue" ? 240 : info?.mode === "aggressive" ? 360 : 480;
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

export async function compactContext(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  force?: boolean;
  currentTokenCount?: number;
  compactionTarget?: "budget" | "threshold";
  customInstructions?: string;
  runtimeContext?: ContextEngineRuntimeContext;
  projectContextManager?: ProjectContextManager;
}): Promise<{
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown;
  };
}> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const compactionAt = nowIso();
    const currentSession = await params.store.getSession(sessionKey);
    const overflowRecovery = resolveOverflowRecovery(params.runtimeContext);
    const overflowRecoveryProfile = buildOverflowRecoveryProfile(overflowRecovery);
    const projectContext = await params.projectContextManager?.load({
      sessionKey,
      ...(() => {
        const workspaceDir =
          typeof (params.runtimeContext as { workspaceDir?: unknown } | undefined)?.workspaceDir ===
          "string"
            ? (((params.runtimeContext as { workspaceDir?: string }).workspaceDir ?? "").trim() ||
              undefined)
            : undefined;
        return workspaceDir ? { workspaceDir } : {};
      })(),
      sessionFile: params.sessionFile,
      ...(currentSession.recentFiles.length > 0
        ? { relevantFiles: currentSession.recentFiles }
        : {}),
      persist: true,
    });
    const customInstructions = joinInstructions(
      params.customInstructions,
      projectContext?.compactInstructions,
      buildBiasInstructions(currentSession.compactionBias),
      overflowRecovery ? buildOverflowRecoveryInstructions(overflowRecovery) : undefined,
    );
    const result = await delegateCompactionToRuntime({
      sessionId: params.sessionId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      sessionFile: params.sessionFile,
      ...(typeof params.tokenBudget === "number" ? { tokenBudget: params.tokenBudget } : {}),
      ...(typeof params.force === "boolean" ? { force: params.force } : {}),
      ...(typeof params.currentTokenCount === "number"
        ? { currentTokenCount: params.currentTokenCount }
        : {}),
      ...(params.compactionTarget ? { compactionTarget: params.compactionTarget } : {}),
      ...(customInstructions ? { customInstructions } : {}),
      ...(params.runtimeContext ? { runtimeContext: params.runtimeContext } : {}),
    });

    const refreshedIndex = await buildTranscriptIndex({
      sessionFile: params.sessionFile,
      protectedRecentTurns: params.config.protectedRecentTurns,
    });

    const summary =
      trimSummaryForOverflow(result.result?.summary, overflowRecovery) ||
      refreshedIndex.latestCompaction?.summary?.trim() ||
      currentSession.latestSummarySnapshot;
    const compactionSucceeded = result.ok && result.compacted;
    const nextBias = compactionSucceeded
      ? resolveBiasAfterCompaction({
          currentBias: currentSession.compactionBias,
          ...(overflowRecovery ? { overflowRecovery } : {}),
        })
      : currentSession.compactionBias;
    const reinjection = buildReinjectionSnapshot(
      {
        config: params.config,
        recentFiles: currentSession.recentFiles,
        criticalToolOutputs: currentSession.criticalToolOutputs,
        mode: applyCompactionBiasToReinjectionMode(
          compactionSucceeded
            ? getReinjectionModeForStage("stabilizing")
            : currentSession.reinjectionMode,
          nextBias,
        ),
        ...(summary ? { summary } : {}),
      },
    );

    await params.store.updateCompaction(
      sessionKey,
      {
        at: compactionAt,
        ok: result.ok,
        compacted: result.compacted,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(summary ? { summary } : {}),
        ...(result.result?.firstKeptEntryId
          ? { firstKeptEntryId: result.result.firstKeptEntryId }
          : {}),
        ...(typeof result.result?.tokensBefore === "number"
          ? { tokensBefore: result.result.tokensBefore }
          : {}),
        ...(typeof result.result?.tokensAfter === "number"
          ? { tokensAfter: result.result.tokensAfter }
          : {}),
      },
      {
        ...(summary ? { summary } : {}),
        ...(reinjection ? { reinjection } : {}),
        compactionBias: nextBias,
        enterStabilization: compactionSucceeded,
        ...(overflowRecovery
          ? {
              overflowRecoveryAttempt: overflowRecovery.attempt,
              overflowRecoveryMaxAttempts: overflowRecovery.maxAttempts,
              overflowRecoveryMode: overflowRecovery.mode,
            }
          : {}),
        ...(overflowRecoveryProfile ? { overflowRecoveryProfile } : {}),
        trigger: overflowRecovery
          ? "overflow"
          : params.force === true
            ? "force"
            : params.compactionTarget === "threshold" || params.compactionTarget === "budget"
              ? params.compactionTarget
              : customInstructions
                ? "manual"
                : "unknown",
      },
    );

    if (compactionSucceeded) {
      await params.store.queueUserNotice(
        sessionKey,
        buildPendingUserNotice({
          key: overflowRecovery
            ? `overflow-recovery:${compactionAt}:${overflowRecovery.attempt}`
            : `compaction:${compactionAt}`,
          source: overflowRecovery ? "overflow-recovery" : "compaction",
          createdAt: compactionAt,
        }),
      );
    }

    await params.store.appendEvent(sessionKey, {
      at: compactionAt,
      type: "compact",
      detail: {
        sessionFile: params.sessionFile,
        ok: result.ok,
        compacted: result.compacted,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(typeof result.result?.tokensBefore === "number"
          ? { tokensBefore: result.result.tokensBefore }
          : {}),
        ...(typeof result.result?.tokensAfter === "number"
          ? { tokensAfter: result.result.tokensAfter }
          : {}),
        ...(overflowRecovery
          ? {
              overflowRecoveryAttempt: overflowRecovery.attempt,
              overflowRecoveryMaxAttempts: overflowRecovery.maxAttempts,
              overflowRecoveryMode: overflowRecovery.mode,
            }
          : {}),
        ...(overflowRecoveryProfile
          ? {
              overflowRecoveryProfile,
            }
          : {}),
        compactionBias: nextBias,
      },
    });

    if (!result.ok) {
      await params.store.noteFailSoft(sessionKey, {
        at: nowIso(),
        phase: "compact",
        message: result.reason ?? "runtime compaction failed",
      });
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.noteFailSoft(sessionKey, {
      at: nowIso(),
      phase: "compact",
      message,
    });
    return {
      ok: false,
      compacted: false,
      reason: message,
    };
  }
}
