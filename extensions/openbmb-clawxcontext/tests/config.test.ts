import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json";
import { buildPluginConfig } from "../src/config.js";

describe("config surface", () => {
  it("does not expose UI config keys anymore", () => {
    const properties = (manifest as { configSchema?: { properties?: Record<string, unknown> } }).configSchema?.properties ?? {};
    expect(properties).not.toHaveProperty("uiEnabled");
    expect(properties).not.toHaveProperty("uiHost");
    expect(properties).not.toHaveProperty("uiPort");
    expect(properties).not.toHaveProperty("uiPathPrefix");
  });

  it("normalizes the reduced runtime config", () => {
    const config = buildPluginConfig({
      dataDir: "~/.openclaw/clawxcontext",
      protectedRecentTurns: 8,
      autoCompactReserveTokens: 9000,
    });

    expect(config.protectedRecentTurns).toBe(8);
    expect(config.autoCompactReserveTokens).toBe(9000);
    expect(config).not.toHaveProperty("uiEnabled");
  });
});
