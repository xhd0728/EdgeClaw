import path from "node:path";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  captureInstallState,
  cleanupConfigForUninstall,
  resolvePluginDataDir,
} from "../../dev-scripts/clawxcontext-plugin-flow.mjs";

const pluginId = "openbmb-clawxcontext";
const pluginRoot = "/tmp/ClawXContext/clawxcontext";
const defaultPluginDataDir = "/tmp/.openclaw/clawxcontext";

describe("clawxcontext plugin flow helpers", () => {
  it("removes ClawXContext from config when no previous state was saved", () => {
    const cleaned = cleanupConfigForUninstall(
      {
        plugins: {
          load: {
            paths: ["/tmp/other-plugin", pluginRoot],
          },
          slots: {
            contextEngine: pluginId,
          },
          entries: {
            [pluginId]: {
              enabled: true,
            },
            "other-plugin": {
              enabled: true,
            },
          },
          installs: {
            [pluginId]: {
              source: "path",
            },
          },
        },
      },
      undefined,
      {
        pluginId,
        pluginRoot,
      },
    );

    expect(cleaned.plugins.load.paths).toEqual(["/tmp/other-plugin"]);
    expect(cleaned.plugins.slots).toBeUndefined();
    expect(cleaned.plugins.entries[pluginId]).toBeUndefined();
    expect(cleaned.plugins.entries["other-plugin"]).toEqual({ enabled: true });
    expect(cleaned.plugins.installs).toBeUndefined();
  });

  it("restores previously saved slot and load path state", () => {
    const backup = captureInstallState(
      {
        plugins: {
          load: {
            paths: [pluginRoot, "/tmp/shared-plugin"],
          },
          slots: {
            contextEngine: "other-context-engine",
          },
          entries: {
            [pluginId]: {
              enabled: false,
              config: {
                dataDir: "/tmp/custom-context",
              },
            },
          },
        },
      },
      {
        pluginId,
        pluginRoot,
      },
    );

    const cleaned = cleanupConfigForUninstall(
      {
        plugins: {
          load: {
            paths: [pluginRoot, "/tmp/shared-plugin"],
          },
          slots: {
            contextEngine: pluginId,
          },
          entries: {
            [pluginId]: {
              enabled: true,
            },
          },
          installs: {
            [pluginId]: {
              source: "path",
            },
          },
        },
      },
      backup,
      {
        pluginId,
        pluginRoot,
      },
    );

    expect(cleaned.plugins.slots.contextEngine).toBe("other-context-engine");
    expect(cleaned.plugins.load.paths).toEqual(
      expect.arrayContaining([pluginRoot, "/tmp/shared-plugin"]),
    );
    expect(cleaned.plugins.entries[pluginId]).toEqual({
      enabled: false,
      config: {
        dataDir: "/tmp/custom-context",
      },
    });
    expect(cleaned.plugins.installs).toBeUndefined();
  });

  it("resolves configured plugin data dir with a safe default fallback", () => {
    expect(
      resolvePluginDataDir(
        {
          plugins: {
            entries: {
              [pluginId]: {
                config: {
                  dataDir: "~/not-expanded-here",
                },
              },
            },
          },
        },
        {
          pluginId,
          defaultPluginDataDir,
        },
      ),
    ).toBe(path.resolve(homedir(), "not-expanded-here"));

    expect(
      resolvePluginDataDir(
        {
          plugins: {
            entries: {
              [pluginId]: {
                enabled: true,
              },
            },
          },
        },
        {
          pluginId,
          defaultPluginDataDir,
        },
      ),
    ).toBe(defaultPluginDataDir);
  });
});
