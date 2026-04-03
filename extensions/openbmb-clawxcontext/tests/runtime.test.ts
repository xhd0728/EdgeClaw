import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { ContextPluginRuntime } from "../src/runtime.js";

const tempDirs: string[] = [];

function createRuntimeHarness(runCommand: ReturnType<typeof vi.fn>, dataDir: string) {
  return new ContextPluginRuntime({
    apiConfig: {} as OpenClawConfig,
    pluginRuntime: {
      system: {
        runCommandWithTimeout: runCommand,
      },
    } as PluginRuntime,
    pluginConfig: {
      dataDir,
    },
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ContextPluginRuntime hooks", () => {
  it("injects project context through before_prompt_build and records cache usage", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-runtime-"));
    tempDirs.push(dir);
    const homeDir = path.join(dir, "home");
    await fs.mkdir(path.join(homeDir, ".openclaw"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    await fs.writeFile(
      path.join(homeDir, ".openclaw", "OPENCLAW.md"),
      ["# User Defaults", "", "## Compact Instructions", "Keep user defaults stable."].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "OPENCLAW.md"),
      ["# Project Guide", "", "## Compact Instructions", "Keep summaries terse."].join("\n"),
      "utf-8",
    );
    const runCommand = vi.fn(async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --show-toplevel") {
        return {
          stdout: `${dir}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git branch --show-current") {
        return {
          stdout: "main\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git rev-parse --short HEAD") {
        return {
          stdout: "abc1234\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git log --pretty=format:%h %s -n 5 --no-show-signature") {
        return {
          stdout: "abc123 initial\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git status --porcelain=v1 --branch") {
        return {
          stdout: "## main\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git diff --stat --compact-summary HEAD") {
        return {
          stdout: " src/index.ts | 2 +-\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });

    const runtime = createRuntimeHarness(runCommand, dir);
    await runtime.store.ensureReady();

    const promptHook = runtime.createBeforePromptBuildHook();
    const promptResult = await promptHook(
      { prompt: "inspect", messages: [] },
      { sessionKey: "agent:main:main", workspaceDir: dir },
    );

    expect(promptResult?.prependSystemContext).toContain("User defaults from ~/.openclaw/OPENCLAW.md");
    expect(promptResult?.prependSystemContext).toContain("Project instructions from OPENCLAW.md");
    expect(promptResult?.prependSystemContext).toContain("Runtime platform:");
    expect(promptResult?.prependContext).toBeUndefined();
    expect(promptResult?.appendSystemContext).toContain("Project state maintained by ClawXContext.");
    expect(promptResult?.appendSystemContext).toContain("Current git branch: main");
    expect(promptResult?.appendSystemContext).toContain("HEAD: abc1234");

    const llmOutputHook = runtime.createLlmOutputHook();
    await llmOutputHook(
      {
        provider: "anthropic",
        model: "claude-sonnet",
        assistantTexts: ["reply"],
        usage: {
          cacheRead: 256,
          cacheWrite: 1024,
        },
      },
      { sessionKey: "agent:main:main" },
    );

    const session = await runtime.store.getSession("agent:main:main");
    expect(session.projectContext?.branch).toBe("main");
    expect(session.projectContext?.headSha).toBe("abc1234");
    expect(session.cacheUsage.totalCacheReadTokens).toBe(256);
    expect(session.cacheUsage.totalCacheWriteTokens).toBe(1024);
    expect(session.cacheUsage.recentStatuses).toEqual(["hit"]);
    expect((await runtime.store.listEvents("agent:main:main")).some((event) => event.type === "hook")).toBe(true);
  });

  it("passes recent file activity into path-scoped rule matching during before_prompt_build", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-runtime-rules-"));
    tempDirs.push(dir);
    const homeDir = path.join(dir, "home");
    await fs.mkdir(path.join(homeDir, ".openclaw"), { recursive: true });
    await fs.mkdir(path.join(dir, ".openclaw", "rules", "src"), { recursive: true });
    vi.stubEnv("HOME", homeDir);
    await fs.writeFile(
      path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      ["# Path Rule", "Keep src/index.ts edits narrow."].join("\n"),
      "utf-8",
    );
    const runCommand = vi.fn(async (argv: string[]) => {
      const key = argv.join(" ");
      if (key === "git rev-parse --show-toplevel") {
        return {
          stdout: `${dir}\n`,
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git branch --show-current") {
        return {
          stdout: "main\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git rev-parse --short HEAD") {
        return {
          stdout: "abc1234\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git log --pretty=format:%h %s -n 5 --no-show-signature") {
        return {
          stdout: "abc123 initial\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git status --porcelain=v1 --branch") {
        return {
          stdout: "## main\n",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      if (key === "git diff --stat --compact-summary HEAD") {
        return {
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          killed: false,
          termination: "exit" as const,
        };
      }
      return {
        stdout: "",
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    });

    const runtime = createRuntimeHarness(runCommand, dir);
    await runtime.store.ensureReady();
    const promptHook = runtime.createBeforePromptBuildHook();
    const promptResult = await promptHook(
      {
        prompt: "inspect",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call_read",
                name: "read",
                arguments: { path: "src/index.ts" },
              },
            ],
          },
        ],
      },
      { sessionKey: "agent:main:main", workspaceDir: dir },
    );

    expect(promptResult?.prependSystemContext).toContain("Runtime platform:");
    expect(promptResult?.prependContext).toBeUndefined();
    expect(promptResult?.appendSystemContext).toContain("Matched path-scoped OPENCLAW rules");
    expect(promptResult?.appendSystemContext).toContain("Path scope: src/index.ts");
  });

  it("injects a pending compaction notice and marks it delivered only after the model says it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-runtime-notice-"));
    tempDirs.push(dir);
    const runtime = createRuntimeHarness(
      vi.fn(async () => ({
        stdout: "",
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      })),
      dir,
    );
    await runtime.store.ensureReady();
    await runtime.store.queueUserNotice("agent:main:main", {
      key: "compaction:test-1",
      source: "compaction",
      priority: 2,
      createdAt: new Date().toISOString(),
    });

    const promptHook = runtime.createBeforePromptBuildHook();
    const promptResult = await promptHook(
      {
        prompt: "continue",
        messages: [{ role: "user", content: "继续处理当前任务" }],
      },
      { sessionKey: "agent:main:main", workspaceDir: dir },
    );

    expect(promptResult?.prependContext).toBeUndefined();
    expect(promptResult?.appendSystemContext).toContain(
      "我刚完成一次上下文压缩，会继续按当前任务线处理。",
    );

    const llmOutputHook = runtime.createLlmOutputHook();
    await llmOutputHook(
      {
        provider: "anthropic",
        model: "claude-sonnet",
        assistantTexts: ["继续处理，不播报 notice。"],
        usage: {},
      },
      { sessionKey: "agent:main:main" },
    );
    expect((await runtime.store.getSession("agent:main:main")).pendingUserNotice?.key).toBe(
      "compaction:test-1",
    );

    await llmOutputHook(
      {
        provider: "anthropic",
        model: "claude-sonnet",
        assistantTexts: [
          "刚完成上下文压缩，会继续按当前任务线处理。\n下面继续。",
        ],
        usage: {},
      },
      { sessionKey: "agent:main:main" },
    );

    const session = await runtime.store.getSession("agent:main:main");
    expect(session.pendingUserNotice).toBeUndefined();
    expect(session.lastDeliveredUserNotice?.source).toBe("compaction");
    expect(session.lastDeliveredUserNotice?.language).toBe("zh");
  });

  it("suppresses user notices on diagnostics turns", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-runtime-debug-"));
    tempDirs.push(dir);
    const runtime = createRuntimeHarness(
      vi.fn(async () => ({
        stdout: "",
        stderr: "",
        code: 1,
        signal: null,
        killed: false,
        termination: "exit" as const,
      })),
      dir,
    );
    await runtime.store.ensureReady();
    await runtime.store.queueUserNotice("agent:main:main", {
      key: "stale-read:test-1",
      source: "stale-read",
      priority: 3,
      createdAt: new Date().toISOString(),
    });

    const promptHook = runtime.createBeforePromptBuildHook();
    const promptResult = await promptHook(
      {
        prompt: "inspect",
        messages: [
          {
            role: "user",
            content: "先调用一次 context_inspect，然后告诉我当前 pressure stage。",
          },
        ],
      },
      { sessionKey: "agent:main:main", workspaceDir: dir },
    );

    expect(promptResult?.appendSystemContext).toBeUndefined();

    const llmOutputHook = runtime.createLlmOutputHook();
    await llmOutputHook(
      {
        provider: "anthropic",
        model: "claude-sonnet",
        assistantTexts: ["当前 pressure stage 是 normal。"],
        usage: {},
      },
      { sessionKey: "agent:main:main" },
    );

    expect((await runtime.store.getSession("agent:main:main")).pendingUserNotice?.key).toBe(
      "stale-read:test-1",
    );
  });
});
