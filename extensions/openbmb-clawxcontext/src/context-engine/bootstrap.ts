import type { PluginRuntimeConfig } from "../config.js";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import type { ProjectContextManager } from "./project-context.js";
import { buildReinjectionSnapshot } from "./reinjection.js";
import {
  buildTranscriptIndex,
  collectCriticalToolOutputsFromIndex,
  collectRecentFilesFromIndex,
} from "./transcript-index.js";

function nowIso(): string {
  return new Date().toISOString();
}

export async function bootstrapContextSession(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  projectContextManager?: ProjectContextManager;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
}): Promise<{ bootstrapped: boolean; importedMessages?: number; reason?: string }> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const index = await buildTranscriptIndex({
      sessionFile: params.sessionFile,
      protectedRecentTurns: params.config.protectedRecentTurns,
    });
    const recentFiles = collectRecentFilesFromIndex(index, params.config.reinjectRecentFiles);
    const criticalToolOutputs = collectCriticalToolOutputsFromIndex(
      index,
      params.config.reinjectCriticalToolOutputs,
    );
    const latestSummary = index.latestCompaction?.summary?.trim() || undefined;
    const reinjection = buildReinjectionSnapshot(
      {
        config: params.config,
        recentFiles,
        criticalToolOutputs,
        ...(latestSummary ? { summary: latestSummary } : {}),
      },
    );

    await params.store.updateSessionContext({
      sessionKey,
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
      bootstrapped: true,
      recentFiles,
      criticalToolOutputs,
      ...(latestSummary ? { latestSummarySnapshot: latestSummary } : {}),
      ...(reinjection ? { reinjection } : {}),
    });
    if (params.projectContextManager) {
      await params.projectContextManager.load({
        sessionKey,
        ...(index.workspaceDir ? { workspaceDir: index.workspaceDir } : {}),
        sessionFile: params.sessionFile,
        persist: true,
      });
    }

    if (index.latestCompaction) {
      await params.store.updateCompaction(
        sessionKey,
        {
          at: nowIso(),
          ok: true,
          compacted: true,
          summary: index.latestCompaction.summary,
          ...(index.latestCompaction.firstKeptEntryId
            ? { firstKeptEntryId: index.latestCompaction.firstKeptEntryId }
            : {}),
          tokensBefore: index.latestCompaction.tokensBefore,
          ...(typeof index.latestCompaction.tokensAfter === "number"
            ? { tokensAfter: index.latestCompaction.tokensAfter }
            : {}),
        },
        {
          ...(latestSummary ? { summary: latestSummary } : {}),
          ...(reinjection ? { reinjection } : {}),
          trigger: "bootstrap",
        },
      );
    }

    await params.store.appendEvent(sessionKey, {
      at: nowIso(),
      type: "bootstrap",
      detail: {
        sessionFile: params.sessionFile,
        importedMessages: index.messageEntries.length,
        recentFiles: recentFiles.length,
        criticalToolOutputs: criticalToolOutputs.length,
        hasCompaction: Boolean(index.latestCompaction),
      },
    });

    return {
      bootstrapped: true,
      importedMessages: index.messageEntries.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.noteFailSoft(sessionKey, {
      at: nowIso(),
      phase: "bootstrap",
      message,
    });
    return {
      bootstrapped: false,
      reason: message,
    };
  }
}
