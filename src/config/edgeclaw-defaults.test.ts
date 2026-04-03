import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./config.js";
import { generateEdgeClawDefaults } from "./edgeclaw-defaults.js";

describe("generateEdgeClawDefaults", () => {
  it("enables ClawXContext as the default bundled context engine", () => {
    const stateDir = path.resolve("tmp", "edgeclaw-defaults-context");
    const config = generateEdgeClawDefaults({
      OPENCLAW_STATE_DIR: stateDir,
      EDGECLAW_API_KEY: "edgeclaw-test-key",
    });

    expect(config.plugins?.allow).toEqual(
      expect.arrayContaining(["openbmb-clawxcontext", "openbmb-clawxmemory", "ClawXRouter"]),
    );
    expect(config.plugins?.entries?.["openbmb-clawxcontext"]).toEqual({
      enabled: true,
      config: {
        dataDir: path.join(stateDir, "clawxcontext"),
      },
    });
    expect(config.plugins?.slots).toEqual(
      expect.objectContaining({
        memory: "openbmb-clawxmemory",
        contextEngine: "openbmb-clawxcontext",
      }),
    );
    expect(config.tools?.alsoAllow).toEqual(
      expect.arrayContaining(["context_inspect", "context_suggest"]),
    );

    const validated = validateConfigObject(config);
    expect(validated.ok).toBe(true);
  });
});
