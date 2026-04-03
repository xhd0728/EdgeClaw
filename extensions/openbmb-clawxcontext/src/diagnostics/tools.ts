import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import { resolvePressureProfile } from "../context-engine/pressure.js";
import { buildTranscriptIndex } from "../context-engine/transcript-index.js";
import { buildContextSuggestions } from "./suggestions.js";
import {
  buildCacheHealth,
  buildOverflowRecoveryProfile,
  buildStablePrefixPreview,
  listProjectRuleSources,
  listRuleMatchSources,
  resolveOverflowRisk,
  resolvePreflightAction,
} from "./context-health.js";
import type { ContextDiagnosticsStore } from "./store.js";

const ContextInspectSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  includeEvents: Type.Optional(Type.Boolean()),
  eventLimit: Type.Optional(Type.Integer({ minimum: 1 })),
});

const ContextSuggestSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
});

export function buildDiagnosticsTools(store: ContextDiagnosticsStore): AnyAgentTool[] {
  return buildDiagnosticsToolsForSession(store);
}

export function buildDiagnosticsToolsForSession(
  store: ContextDiagnosticsStore,
  defaults?: { sessionKey?: string },
): AnyAgentTool[] {
  return [
    {
      label: "Context Inspect",
      name: "context_inspect",
      description:
        "Inspect ClawXContext working-set state, transcript rewrites, compaction status, reinjection payload, and recent fail-soft diagnostics for the current or specified session.",
      parameters: ContextInspectSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        const sessionKey = readStringParam(params, "sessionKey") ?? defaults?.sessionKey ?? "";
        const includeEvents = params.includeEvents === true;
        const eventLimit = readNumberParam(params, "eventLimit", { integer: true }) ?? 20;

        if (!sessionKey) {
          return jsonResult({
            overview: await store.getOverview(),
            warning: "No sessionKey provided. Returning plugin overview only.",
          });
        }

        const session = await store.getSession(sessionKey);
        const index = session.sessionFile
          ? await buildTranscriptIndex({
              sessionFile: session.sessionFile,
              protectedRecentTurns: session.protectedRecentTurns,
            }).catch(() => undefined)
          : undefined;
        const profile = resolvePressureProfile({
          config: store.config,
          session,
          ...(index ? { index } : {}),
        });
        const shouldUseDerivedProfile =
          Boolean(index) ||
          typeof session.lastWorkingSet?.tokenBudget === "number" ||
          typeof session.debtBreakdown.hardThresholdTokens === "number";
        const effectiveSession = shouldUseDerivedProfile
          ? {
              ...session,
              pressureStage: profile.stage,
              reinjectionMode: profile.reinjectionMode,
              debtBreakdown: profile.debtBreakdown,
              budgetHotspots: profile.budgetHotspots,
            }
          : session;
        const projectRuleSources = listProjectRuleSources(effectiveSession);
        const ruleMatchSources = listRuleMatchSources(effectiveSession);
        const stablePrefixPreview = buildStablePrefixPreview(effectiveSession);
        const preflightAction = resolvePreflightAction(effectiveSession);
        const overflowRisk = resolveOverflowRisk(effectiveSession);
        const overflowRecoveryProfile = buildOverflowRecoveryProfile(effectiveSession);
        const cacheHealth = buildCacheHealth(effectiveSession);
        const suggestions = await buildContextSuggestions({
          config: store.config,
          session: effectiveSession,
        });
        const payload: Record<string, unknown> = {
          session: effectiveSession,
          suggestions,
          pressureStage: effectiveSession.pressureStage,
          compactionBias: effectiveSession.compactionBias,
          reinjectionMode: effectiveSession.reinjectionMode,
          debtBreakdown: effectiveSession.debtBreakdown,
          budgetHotspots: effectiveSession.budgetHotspots,
          collapsedLayers: effectiveSession.lastWorkingSet?.collapsedHistory?.layers ?? [],
          projectRuleSources,
          ruleMatchSources,
          stablePrefixPreview,
          preflightAction,
          overflowRisk,
          overflowRecoveryProfile,
          cacheHealth,
          pendingUserNotice: effectiveSession.pendingUserNotice,
          lastDeliveredUserNotice: effectiveSession.lastDeliveredUserNotice,
          userNoticeSource:
            effectiveSession.pendingUserNotice?.source ??
            effectiveSession.lastDeliveredUserNotice?.source ??
            effectiveSession.userNoticeSource,
        };
        if (includeEvents) {
          payload.events = (await store.listEvents(sessionKey)).slice(-eventLimit);
        }
        return jsonResult(payload);
      },
    } as AnyAgentTool,
    {
      label: "Context Suggest",
      name: "context_suggest",
      description:
        "Suggest practical context-management improvements for the current or specified session, including near-capacity risk, large retained tool output, repeated reads, auto-compaction posture, and recent compaction risk.",
      parameters: ContextSuggestSchema,
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as Record<string, unknown>;
        const sessionKey = readStringParam(params, "sessionKey") ?? defaults?.sessionKey ?? "";
        if (!sessionKey) {
          return jsonResult({
            overview: await store.getOverview(),
            warning: "No sessionKey provided. Returning plugin overview only.",
          });
        }

        const session = await store.getSession(sessionKey);
        const index = session.sessionFile
          ? await buildTranscriptIndex({
              sessionFile: session.sessionFile,
              protectedRecentTurns: session.protectedRecentTurns,
            }).catch(() => undefined)
          : undefined;
        const profile = resolvePressureProfile({
          config: store.config,
          session,
          ...(index ? { index } : {}),
        });
        const shouldUseDerivedProfile =
          Boolean(index) ||
          typeof session.lastWorkingSet?.tokenBudget === "number" ||
          typeof session.debtBreakdown.hardThresholdTokens === "number";
        const effectiveSession = shouldUseDerivedProfile
          ? {
              ...session,
              pressureStage: profile.stage,
              reinjectionMode: profile.reinjectionMode,
              debtBreakdown: profile.debtBreakdown,
              budgetHotspots: profile.budgetHotspots,
            }
          : session;
        const projectRuleSources = listProjectRuleSources(effectiveSession);
        const ruleMatchSources = listRuleMatchSources(effectiveSession);
        const stablePrefixPreview = buildStablePrefixPreview(effectiveSession);
        const preflightAction = resolvePreflightAction(effectiveSession);
        const overflowRisk = resolveOverflowRisk(effectiveSession);
        const overflowRecoveryProfile = buildOverflowRecoveryProfile(effectiveSession);
        const cacheHealth = buildCacheHealth(effectiveSession);
        const suggestions = await buildContextSuggestions({
          config: store.config,
          session: effectiveSession,
        });
        return jsonResult({
          sessionKey,
          suggestions,
          pressureStage: effectiveSession.pressureStage,
          compactionBias: effectiveSession.compactionBias,
          reinjectionMode: effectiveSession.reinjectionMode,
          debtBreakdown: effectiveSession.debtBreakdown,
          budgetHotspots: effectiveSession.budgetHotspots,
          collapsedLayers: effectiveSession.lastWorkingSet?.collapsedHistory?.layers ?? [],
          projectRuleSources,
          ruleMatchSources,
          stablePrefixPreview,
          preflightAction,
          overflowRisk,
          overflowRecoveryProfile,
          cacheHealth,
          pendingUserNotice: effectiveSession.pendingUserNotice,
          lastDeliveredUserNotice: effectiveSession.lastDeliveredUserNotice,
          userNoticeSource:
            effectiveSession.pendingUserNotice?.source ??
            effectiveSession.lastDeliveredUserNotice?.source ??
            effectiveSession.userNoticeSource,
          summary:
            suggestions.length > 0
              ? `Generated ${suggestions.length} context suggestions for ${sessionKey}.`
              : `No immediate context-management suggestions for ${sessionKey}.`,
        });
      },
    } as AnyAgentTool,
  ];
}
