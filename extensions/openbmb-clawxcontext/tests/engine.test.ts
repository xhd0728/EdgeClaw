import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const delegateCompactionToRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk")>("openclaw/plugin-sdk");
  return {
    ...actual,
    delegateCompactionToRuntime: delegateCompactionToRuntimeMock,
  };
});

import { buildPluginConfig } from "../src/config.js";
import { createContextEngine } from "../src/context-engine/engine.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createHarness(
  rawConfig: Record<string, unknown> = {},
  options?: {
    projectContextManager?: {
      load: (params: Record<string, unknown>) => Promise<unknown>;
    };
  },
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-engine-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: 7,
        id: "session-1",
        timestamp: new Date().toISOString(),
        cwd: dir,
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: 1,
        message: { role: "user", content: "hello", timestamp: 1 },
      }),
    ].join("\n") + "\n",
    "utf-8",
  );

  const config = buildPluginConfig({
    dataDir: dir,
    protectedRecentTurns: 1,
    autoCompactReserveTokens: 0,
    ...rawConfig,
  });
  const store = new ContextDiagnosticsStore(config);
  await store.ensureReady();
  const engine = createContextEngine({
    config,
    store,
    ...(options?.projectContextManager
      ? { projectContextManager: options.projectContextManager as never }
      : {}),
  });

  return {
    sessionFile,
    store,
    engine,
  };
}

function buildLargeTurnMessages() {
  return [
    { role: "user", content: "please inspect src/index.ts", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/index.ts" } }],
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_read",
      toolName: "read",
      content: [{ type: "text", text: "z".repeat(2_000) }],
      isError: false,
      timestamp: 3,
    },
  ];
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  delegateCompactionToRuntimeMock.mockReset();
});

describe("ClawXContext engine afterTurn", () => {
  it("does not compact when below the auto-compaction threshold", async () => {
    const { engine, sessionFile, store } = await createHarness({
      autoCompactReserveTokens: 500,
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [{ role: "user", content: "short turn", timestamp: 1 }],
      prePromptMessageCount: 0,
      tokenBudget: 2_000,
    });

    expect(delegateCompactionToRuntimeMock).not.toHaveBeenCalled();
    const session = await store.getSession("agent:main:main");
    expect(session.lastCompaction).toBeUndefined();
  });

  it("triggers delegated compaction and refreshes reinjection when over threshold", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 1_200,
        tokensAfter: 240,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 300,
      runtimeContext: {},
    });

    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledTimes(1);
    const session = await store.getSession("agent:main:main");
    expect(session.lastCompaction?.summary).toBe("summary after compact");
    expect(session.reinjection?.rendered).toContain("summary after compact");
    expect(session.reinjection?.mode).toBe("summary-only");
    expect(session.pressureStage).toBe("stabilizing");
    expect(session.stabilizationTurnsRemaining).toBe(2);
  });

  it("preemptively compacts when pressure is critical even before the hard threshold", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "critical preflight summary",
        tokensBefore: 2_000,
        tokensAfter: 260,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [
        { role: "user", content: "please inspect src/index.ts", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/index.ts" } },
          ],
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "z".repeat(5_000) }],
          isError: false,
          timestamp: 3,
        },
      ],
      prePromptMessageCount: 0,
      tokenBudget: 1_400,
      runtimeContext: {},
    });

    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionTarget: "budget",
      }),
    );
    const session = await store.getSession("agent:main:main");
    expect(session.lastCompaction?.summary).toBe("critical preflight summary");
    expect(session.pressureStage).toBe("stabilizing");
  });

  it("fails soft in afterTurn when delegated compaction reports failure", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "delegate failed",
    });

    await expect(
      engine.afterTurn({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile,
        messages: buildLargeTurnMessages(),
        prePromptMessageCount: 0,
        tokenBudget: 300,
        runtimeContext: {},
      }),
    ).resolves.toBeUndefined();

    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledTimes(1);
    const session = await store.getSession("agent:main:main");
    expect(
      session.failSoft.some(
        (entry) => entry.phase === "afterTurn" && entry.message.includes("delegate failed"),
      ),
    ).toBe(true);
  });

  it("exits stabilization after two subsequent turns", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 1_200,
        tokensAfter: 240,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 300,
      runtimeContext: {},
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [{ role: "user", content: "follow up", timestamp: 10 }],
      prePromptMessageCount: 0,
      tokenBudget: 3_000,
      runtimeContext: {},
    });

    let session = await store.getSession("agent:main:main");
    expect(session.pressureStage).toBe("stabilizing");
    expect(session.stabilizationTurnsRemaining).toBe(1);
    expect(session.reinjection?.mode).toBe("summary-only");

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [{ role: "user", content: "steady state", timestamp: 11 }],
      prePromptMessageCount: 0,
      tokenBudget: 3_000,
      runtimeContext: {},
    });

    session = await store.getSession("agent:main:main");
    expect(session.pressureStage).toBe("normal");
    expect(session.stabilizationTurnsRemaining).toBe(0);
    expect(session.reinjection?.mode).toBe("summary+recent-files+critical-outputs");
  });

  it("passes project compact instructions through manual compact", async () => {
    const projectContextManager = {
      load: vi.fn(async () => ({
        snapshot: {
          recentCommits: [],
          gitStatusSummary: [],
          sources: [],
          lastLoadedAt: new Date().toISOString(),
        },
        compactInstructions: "Keep active tasks and current blockers.",
      })),
    };
    const { engine, sessionFile } = await createHarness({}, { projectContextManager });
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "manual compact summary",
        tokensBefore: 800,
        tokensAfter: 200,
      },
    });

    await engine.compact({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      runtimeContext: {},
    });

    expect(projectContextManager.load).toHaveBeenCalledTimes(1);
    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "Keep active tasks and current blockers.",
      }),
    );
  });

  it("records repeated reads and rapid pressure re-entry after a recent compaction", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 1_200,
        tokensAfter: 240,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 300,
      runtimeContext: {},
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 680,
      runtimeContext: {},
    });

    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledTimes(1);
    const session = await store.getSession("agent:main:main");
    expect(session.compactionLifecycle.postCompactionRepeatedReads).toBe(1);
    expect(session.compactionLifecycle.rapidReentryStage).toBe("elevated");
    expect(session.compactionBias).toBe("aggressive");
  });

  it("clears stale compaction-quality warnings after later healthy turns", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 1_200,
        tokensAfter: 240,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 300,
      runtimeContext: {},
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 680,
      runtimeContext: {},
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [{ role: "user", content: "steady follow up", timestamp: 20 }],
      prePromptMessageCount: 0,
      tokenBudget: 3_000,
      runtimeContext: {},
    });

    const session = await store.getSession("agent:main:main");
    expect(session.compactionLifecycle.rapidReentryStage).toBeUndefined();
    expect(session.compactionLifecycle.postCompactionRepeatedReads).toBe(0);
    expect(session.compactionBias).toBe("normal");
  });

  it("upgrades bias to rescue for severe post-compaction recovery signals", async () => {
    const { engine, sessionFile, store } = await createHarness();
    delegateCompactionToRuntimeMock.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 1_200,
        tokensAfter: 240,
      },
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: buildLargeTurnMessages(),
      prePromptMessageCount: 0,
      tokenBudget: 300,
      runtimeContext: {},
    });

    await engine.afterTurn({
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      messages: [
        ...buildLargeTurnMessages(),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read_2", name: "read", arguments: { path: "src/index.ts" } }],
          timestamp: 4,
        },
      ],
      prePromptMessageCount: 0,
      tokenBudget: 350,
      runtimeContext: {},
    });

    const session = await store.getSession("agent:main:main");
    expect(session.compactionBias).toBe("rescue");
  });
});
