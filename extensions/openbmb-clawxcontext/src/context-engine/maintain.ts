import type { ContextEngineMaintenanceResult, ContextEngineRuntimeContext } from "openclaw/plugin-sdk";
import type { PluginRuntimeConfig } from "../config.js";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import type { ContextMessage, PressureStage } from "./types.js";
import { listSnipCandidates } from "./budget-manager.js";
import { summarizeCompactedToolOutput } from "./tool-output-summary.js";
import { buildTranscriptIndex } from "./transcript-index.js";
import { buildPendingUserNotice } from "./user-notices.js";

const MICROCOMPACT_EDIT_TOOLS = new Set(["edit", "write", "replace", "patch"]);
const NORMAL_SNIP_MIN_TEXT_LENGTH = 1_200;
const ELEVATED_SNIP_MIN_TEXT_LENGTH = 800;
const CRITICAL_SNIP_MIN_TEXT_LENGTH = 400;

function nowIso(): string {
  return new Date().toISOString();
}

function isCompactStub(text: string): boolean {
  return text.startsWith("[tool output compacted:") || text.startsWith("[tool output outdated after");
}

function replaceToolResultText(message: ContextMessage, text: string): ContextMessage {
  return {
    ...(message as unknown as Record<string, unknown>),
    content: [{ type: "text", text }],
  } as ContextMessage;
}

function getSnipMinTextLength(stage: PressureStage, bias: "normal" | "aggressive" | "rescue"): number {
  if (bias === "rescue") {
    return 220;
  }
  if (stage === "critical" || bias === "aggressive") return CRITICAL_SNIP_MIN_TEXT_LENGTH;
  if (stage === "elevated" || stage === "stabilizing") {
    return ELEVATED_SNIP_MIN_TEXT_LENGTH;
  }
  return NORMAL_SNIP_MIN_TEXT_LENGTH;
}

export async function maintainContextTranscript(params: {
  config: PluginRuntimeConfig;
  store: ContextDiagnosticsStore;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  runtimeContext?: ContextEngineRuntimeContext;
}): Promise<ContextEngineMaintenanceResult> {
  const sessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const maintainAt = nowIso();
    const session = await params.store.getSession(sessionKey);
    const snipMinTextLength = getSnipMinTextLength(session.pressureStage, session.compactionBias);
    const index = await buildTranscriptIndex({
      sessionFile: params.sessionFile,
      protectedRecentTurns: params.config.protectedRecentTurns,
    });

    const replacements = new Map<string, ContextMessage>();
    let snipHits = 0;
    let microcompactHits = 0;

    if (params.config.snipEnabled) {
      for (const candidate of listSnipCandidates({
        index,
        stage: session.pressureStage,
        bias: session.compactionBias,
        baseMinTextLength: snipMinTextLength,
      })) {
        const result = candidate.entry;
        replacements.set(
          result.entryId,
          replaceToolResultText(
            result.message,
            summarizeCompactedToolOutput(result, session.pressureStage),
          ),
        );
        snipHits += 1;
      }
    }

    if (params.config.microcompactEnabled) {
      const editsByPath = new Map<string, { toolName: string; messageIndex: number }>();
      for (const toolCall of [...index.toolCallsById.values()].sort((a, b) => b.messageIndex - a.messageIndex)) {
        if (!toolCall.path || !MICROCOMPACT_EDIT_TOOLS.has(toolCall.toolName)) continue;
        if (!editsByPath.has(toolCall.path)) {
          editsByPath.set(toolCall.path, {
            toolName: toolCall.toolName,
            messageIndex: toolCall.messageIndex,
          });
        }
      }

      for (const result of index.toolResults) {
        if (
          result.isProtected ||
          result.toolName !== "read" ||
          !result.path ||
          replacements.has(result.entryId) ||
          isCompactStub(result.text)
        ) {
          continue;
        }
        const edit = editsByPath.get(result.path);
        if (!edit || edit.messageIndex <= result.messageIndex) continue;
        replacements.set(
          result.entryId,
          replaceToolResultText(
            result.message,
            `[tool output outdated after ${edit.toolName}: ${result.path}]`,
          ),
        );
        microcompactHits += 1;
      }
    }

    if (replacements.size === 0) {
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "no rewrite candidates",
      };
    }

    const rewrite = params.runtimeContext?.rewriteTranscriptEntries;
    if (!rewrite) {
      const reason = "runtimeContext.rewriteTranscriptEntries unavailable";
      await params.store.noteFailSoft(sessionKey, {
        at: nowIso(),
        phase: "maintain",
        message: reason,
      });
      return {
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason,
      };
    }

    const result = await rewrite({
      replacements: [...replacements.entries()].map(([entryId, message]) => ({
        entryId,
        message,
      })),
    });

    if (result.changed) {
      await params.store.updateRewriteStats(sessionKey, {
        addSnipHits: snipHits,
        addMicrocompactHits: microcompactHits,
        addRewrittenEntries: result.rewrittenEntries,
        addBytesFreed: result.bytesFreed,
        lastRewrittenAt: maintainAt,
      });
      if (microcompactHits > 0) {
        await params.store.queueUserNotice(
          sessionKey,
          buildPendingUserNotice({
            key: `stale-read:${maintainAt}`,
            source: "stale-read",
            createdAt: maintainAt,
          }),
        );
      }
    }

    await params.store.appendEvent(sessionKey, {
      at: maintainAt,
      type: "maintain",
      detail: {
        sessionFile: params.sessionFile,
        rewriteCandidates: replacements.size,
        snipHits,
        microcompactHits,
        pressureStage: session.pressureStage,
        snipMinTextLength,
        changed: result.changed,
        rewrittenEntries: result.rewrittenEntries,
        bytesFreed: result.bytesFreed,
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.store.noteFailSoft(sessionKey, {
      at: nowIso(),
      phase: "maintain",
      message,
    });
    return {
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
      reason: message,
    };
  }
}
