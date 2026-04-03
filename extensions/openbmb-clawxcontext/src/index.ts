import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PLUGIN_ID, pluginConfigJsonSchema, pluginConfigUiHints } from "./config.js";
import { buildDiagnosticsToolsForSession } from "./diagnostics/tools.js";
import { ContextPluginRuntime } from "./runtime.js";

const plugin = definePluginEntry({
  id: PLUGIN_ID,
  name: "ClawXContext",
  description: "Long-session context hardening plugin for OpenClaw.",
  kind: "context-engine",
  configSchema: {
    jsonSchema: pluginConfigJsonSchema,
    uiHints: pluginConfigUiHints,
  },
  register(api): void {
    if (api.registrationMode !== "full") {
      return;
    }

    const runtime = new ContextPluginRuntime({
      apiConfig: api.config,
      pluginRuntime: api.runtime,
      ...(api.pluginConfig ? { pluginConfig: api.pluginConfig } : {}),
      ...(api.logger ? { logger: api.logger } : {}),
    });

    api.registerContextEngine(PLUGIN_ID, runtime.createContextEngineFactory());
    api.on("before_prompt_build", runtime.createBeforePromptBuildHook(), { priority: 25 });
    api.on("llm_output", runtime.createLlmOutputHook(), { priority: 10 });
    api.on("before_compaction", runtime.createBeforeCompactionHook(), { priority: 10 });
    api.on("after_compaction", runtime.createAfterCompactionHook(), { priority: 10 });

    const toolNames = runtime.getTools().map((tool) => tool.name);
    api.registerTool(
      (ctx) =>
        buildDiagnosticsToolsForSession(runtime.store, {
          ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
        }),
      { names: toolNames },
    );
  },
});

export default plugin;
