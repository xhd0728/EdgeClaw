import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

function createBaseApi(overrides: Partial<OpenClawPluginApi> = {}): OpenClawPluginApi {
  return {
    id: plugin.id,
    name: plugin.name,
    description: plugin.description,
    source: "/tmp/clawxcontext-test",
    registrationMode: "full",
    config: {},
    pluginConfig: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerCliBackend: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerSpeechProvider: vi.fn(),
    registerMediaUnderstandingProvider: vi.fn(),
    registerImageGenerationProvider: vi.fn(),
    registerWebSearchProvider: vi.fn(),
    registerInteractiveHandler: vi.fn(),
    onConversationBindingResolved: vi.fn(),
    registerCommand: vi.fn(),
    registerContextEngine: vi.fn(),
    registerMemoryPromptSection: vi.fn(),
    registerMemoryFlushPlan: vi.fn(),
    registerMemoryRuntime: vi.fn(),
    registerMemoryEmbeddingProvider: vi.fn(),
    resolvePath: (value: string) => value,
    on: vi.fn(),
    ...overrides,
  };
}

describe("openbmb-clawxcontext plugin entry", () => {
  it("skips non-full registration modes used by CLI metadata generation", () => {
    const api = createBaseApi({
      registrationMode: "cli-metadata",
    });

    expect(() => plugin.register(api)).not.toThrow();
    expect(api.registerContextEngine).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });
});
