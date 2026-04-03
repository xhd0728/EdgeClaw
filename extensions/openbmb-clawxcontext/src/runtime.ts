import type {
  OpenClawConfig,
  PluginLogger,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import { buildPluginConfig, type PluginRuntimeConfig } from "./config.js";
import { ProjectContextManager } from "./context-engine/project-context.js";
import {
  collectActiveScopeSignalsFromMessages,
  collectRecentFilesFromMessages,
} from "./context-engine/transcript-index.js";
import {
  buildPathRuleNoticeKey,
  buildPendingUserNotice,
  buildUserNoticeInstruction,
  buildUserNoticeMessage,
  detectUserNoticeLanguage,
  didAssistantDeliverNotice,
  hasDeliverableAssistantText,
  isDiagnosticsOnlyTurn,
} from "./context-engine/user-notices.js";
import { ContextDiagnosticsStore } from "./diagnostics/store.js";
import { buildDiagnosticsTools } from "./diagnostics/tools.js";
import { createContextEngine } from "./context-engine/engine.js";

function nowIso(): string {
  return new Date().toISOString();
}

type HookAgentContext = {
  sessionKey?: string;
  workspaceDir?: string;
};

type BeforePromptBuildEvent = {
  prompt: string;
  messages: unknown[];
};

type LlmOutputEvent = {
  runId?: string;
  sessionId?: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  usage?: {
    cacheRead?: number;
    cacheWrite?: number;
  };
};

function joinBlocks(...parts: Array<string | undefined>): string | undefined {
  const blocks = parts.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

type BeforeCompactionEvent = {
  messageCount: number;
  compactingCount?: number;
  tokenCount?: number;
};

type AfterCompactionEvent = {
  messageCount: number;
  compactedCount: number;
  tokenCount?: number;
};

export class ContextPluginRuntime {
  readonly runtimeConfig: PluginRuntimeConfig;
  readonly store: ContextDiagnosticsStore;
  readonly projectContextManager: ProjectContextManager;

  constructor(params: {
    apiConfig: OpenClawConfig;
    pluginRuntime: PluginRuntime;
    pluginConfig?: Record<string, unknown>;
    logger?: PluginLogger;
  }) {
    void params.apiConfig;
    this.runtimeConfig = buildPluginConfig(params.pluginConfig);
    this.store = new ContextDiagnosticsStore(this.runtimeConfig);
    this.projectContextManager = new ProjectContextManager(
      params.pluginRuntime.system.runCommandWithTimeout,
      this.store,
      params.logger,
    );
  }

  createContextEngineFactory() {
    return async () =>
      createContextEngine({
        config: this.runtimeConfig,
        store: this.store,
        projectContextManager: this.projectContextManager,
      });
  }

  getTools() {
    return buildDiagnosticsTools(this.store);
  }

  createBeforePromptBuildHook() {
    return async (
      _event: BeforePromptBuildEvent,
      ctx: HookAgentContext,
    ): Promise<
      { prependSystemContext?: string; appendSystemContext?: string; prependContext?: string } | void
    > => {
      const sessionKey = ctx.sessionKey?.trim();
      const isDiagnosticsTurn = Array.isArray(_event.messages)
        ? isDiagnosticsOnlyTurn(_event.messages as never[])
        : false;
      const relevantFiles = Array.isArray(_event.messages)
        ? collectRecentFilesFromMessages(_event.messages as never[], 12)
        : [];
      const scopeSignals = Array.isArray(_event.messages)
        ? collectActiveScopeSignalsFromMessages(_event.messages as never[], 3)
        : [];
      const loaded = await this.projectContextManager.load({
        ...(sessionKey ? { sessionKey } : {}),
        ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
        ...(relevantFiles.length > 0 ? { relevantFiles } : {}),
        ...(scopeSignals.length > 0 ? { scopeSignals } : {}),
        persist: Boolean(sessionKey),
      });
      if (sessionKey && loaded?.snapshot.activeRuleMatches?.length) {
        const pathRuleNoticeKey = buildPathRuleNoticeKey(loaded.snapshot.activeRuleMatches);
        if (pathRuleNoticeKey) {
          await this.store.queueUserNotice(
            sessionKey,
            buildPendingUserNotice({
              key: pathRuleNoticeKey,
              source: "path-rule",
            }),
          );
        }
      }
      const session = sessionKey ? await this.store.getSession(sessionKey) : undefined;
      const noticeLanguage = Array.isArray(_event.messages)
        ? detectUserNoticeLanguage(_event.messages as never[])
        : "en";
      const pendingNotice = session?.pendingUserNotice;
      const userNoticeMessage =
        pendingNotice && !isDiagnosticsTurn
          ? buildUserNoticeMessage(pendingNotice.source, noticeLanguage)
          : undefined;
      const noticeInstruction = userNoticeMessage
        ? buildUserNoticeInstruction(userNoticeMessage)
        : undefined;

      if (sessionKey && pendingNotice && userNoticeMessage) {
        await this.store.setSession(sessionKey, (current) => ({
          ...(current.pendingUserNotice
            ? {
                pendingUserNotice: {
                  ...current.pendingUserNotice,
                  language: noticeLanguage,
                  message: userNoticeMessage,
                },
                userNoticeSource: current.pendingUserNotice.source,
              }
            : {}),
        }));
      }

      if (!loaded && !noticeInstruction) {
        return;
      }

      if (sessionKey) {
        await this.store.appendEvent(sessionKey, {
          at: nowIso(),
          type: "hook",
          detail: {
            hook: "before_prompt_build",
            hasStaticContext: Boolean(loaded?.systemContext),
            hasDynamicContext: Boolean(loaded?.dynamicContext),
            hasUserNotice: Boolean(noticeInstruction),
            ...(loaded
              ? {
                  projectSources: loaded.snapshot.sources.map((source) => ({
                    kind: source.kind,
                    present: source.present,
                    ...(source.path ? { path: source.path } : {}),
                  })),
                }
              : {}),
          },
        });
      }

      const appendSystemContext = joinBlocks(loaded?.dynamicContext, noticeInstruction);
      return {
        ...(loaded?.systemContext ? { prependSystemContext: loaded.systemContext } : {}),
        ...(appendSystemContext ? { appendSystemContext } : {}),
      };
    };
  }

  createLlmOutputHook() {
    return async (event: LlmOutputEvent, ctx: HookAgentContext): Promise<void> => {
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) return;
      await this.store.recordCacheUsage({
        sessionKey,
        ...(event.provider ? { provider: event.provider } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(typeof event.usage?.cacheRead === "number" ? { cacheRead: event.usage.cacheRead } : {}),
        ...(typeof event.usage?.cacheWrite === "number"
          ? { cacheWrite: event.usage.cacheWrite }
          : {}),
        observedAt: nowIso(),
      });
      if (
        typeof event.usage?.cacheRead === "number" ||
        typeof event.usage?.cacheWrite === "number"
      ) {
        await this.store.appendEvent(sessionKey, {
          at: nowIso(),
          type: "hook",
          detail: {
            hook: "llm_output",
            provider: event.provider,
            model: event.model,
            ...(typeof event.usage?.cacheRead === "number"
              ? { cacheRead: event.usage.cacheRead }
              : {}),
            ...(typeof event.usage?.cacheWrite === "number"
              ? { cacheWrite: event.usage.cacheWrite }
              : {}),
          },
        });
      }
      const currentSession = await this.store.getSession(sessionKey);
      const pendingMessage = currentSession.pendingUserNotice?.message?.trim();
      const deliveredNotice =
        pendingMessage &&
        hasDeliverableAssistantText(event.assistantTexts ?? []) &&
        currentSession.pendingUserNotice?.source &&
        didAssistantDeliverNotice({
          source: currentSession.pendingUserNotice.source,
          expectedMessage: pendingMessage,
          assistantTexts: event.assistantTexts ?? [],
        });
      if (deliveredNotice) {
        await this.store.markUserNoticeDelivered({
          sessionKey,
        });
      }
    };
  }

  createBeforeCompactionHook() {
    return async (
      event: BeforeCompactionEvent,
      ctx: HookAgentContext,
    ): Promise<void> => {
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) return;
      await this.store.appendEvent(sessionKey, {
        at: nowIso(),
        type: "hook",
        detail: {
          hook: "before_compaction",
          messageCount: event.messageCount,
          ...(typeof event.compactingCount === "number"
            ? { compactingCount: event.compactingCount }
            : {}),
          ...(typeof event.tokenCount === "number" ? { tokenCount: event.tokenCount } : {}),
        },
      });
    };
  }

  createAfterCompactionHook() {
    return async (
      event: AfterCompactionEvent,
      ctx: HookAgentContext,
    ): Promise<void> => {
      const sessionKey = ctx.sessionKey?.trim();
      if (!sessionKey) return;
      await this.store.appendEvent(sessionKey, {
        at: nowIso(),
        type: "hook",
        detail: {
          hook: "after_compaction",
          messageCount: event.messageCount,
          compactedCount: event.compactedCount,
          ...(typeof event.tokenCount === "number" ? { tokenCount: event.tokenCount } : {}),
        },
      });
    };
  }
}
