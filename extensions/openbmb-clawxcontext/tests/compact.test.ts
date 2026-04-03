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
import { compactContext } from "../src/context-engine/compact.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createSessionFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-compact-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({ type: "session", version: 7, id: "session-1", timestamp: new Date().toISOString(), cwd: dir }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: 1, message: { role: "user", content: "hello", timestamp: 1 } }),
    ].join("\n") + "\n",
    "utf-8",
  );
  return { dir, sessionFile };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  delegateCompactionToRuntimeMock.mockReset();
});

describe("compactContext", () => {
  it("records compaction and prepares reinjection state", async () => {
    const { dir, sessionFile } = await createSessionFile();
    const config = buildPluginConfig({ dataDir: dir });
    const store = new ContextDiagnosticsStore(config);
    await store.ensureReady();
    await store.updateSessionContext({
      sessionKey: "agent:main:main",
      recentFiles: ["src/index.ts"],
      criticalToolOutputs: ["read src/index.ts: exported createContextEngine"],
    });
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "summary after compact",
        tokensBefore: 20_000,
        tokensAfter: 4_000,
      },
    });

    const projectContextManager = {
      load: vi.fn(async () => ({
        snapshot: {
          recentCommits: [],
          gitStatusSummary: [],
          sources: [],
          lastLoadedAt: new Date().toISOString(),
        },
        compactInstructions: "Keep the active task and pending validation steps.",
      })),
    };

    const result = await compactContext({
      config,
      store,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      tokenBudget: 16_000,
      currentTokenCount: 18_000,
      projectContextManager: projectContextManager as never,
    });

    expect(result.ok).toBe(true);
    expect(projectContextManager.load).toHaveBeenCalledTimes(1);
    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: "Keep the active task and pending validation steps.",
      }),
    );
    const session = await store.getSession("agent:main:main");
    expect(session.lastCompaction?.summary).toBe("summary after compact");
    expect(session.reinjection?.rendered).toContain("summary after compact");
    expect(session.reinjection?.mode).toBe("summary-only");
    expect(session.reinjection?.rendered).not.toContain("src/index.ts");
    expect(session.pressureStage).toBe("stabilizing");
    expect(session.stabilizationTurnsRemaining).toBe(2);
    expect(session.compactionLifecycle.lastTrigger).toBe("manual");
    expect(session.pendingUserNotice?.source).toBe("compaction");
  });

  it("fails soft when delegated compaction reports failure", async () => {
    const { dir, sessionFile } = await createSessionFile();
    const config = buildPluginConfig({ dataDir: dir });
    const store = new ContextDiagnosticsStore(config);
    await store.ensureReady();
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "delegate failed",
    });

    const result = await compactContext({
      config,
      store,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
    });

    expect(result.ok).toBe(false);
    const session = await store.getSession("agent:main:main");
    expect(session.failSoft.at(-1)?.message).toContain("delegate failed");
  });

  it("escalates custom instructions for overflow recovery attempts", async () => {
    const { dir, sessionFile } = await createSessionFile();
    const config = buildPluginConfig({ dataDir: dir });
    const store = new ContextDiagnosticsStore(config);
    await store.ensureReady();
    await store.updateSessionContext({
      sessionKey: "agent:main:main",
      recentFiles: ["src/index.ts"],
      criticalToolOutputs: ["read src/index.ts: exported createContextEngine"],
    });
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "overflow compact summary " + "x".repeat(700),
        tokensBefore: 240_000,
        tokensAfter: 8_000,
      },
    });

    const projectContextManager = {
      load: vi.fn(async () => ({
        snapshot: {
          recentCommits: [],
          gitStatusSummary: [],
          gitDiffSummary: [],
          sources: [],
          lastLoadedAt: new Date().toISOString(),
        },
        compactInstructions: "Keep active blockers and edited files.",
      })),
    };

    const result = await compactContext({
      config,
      store,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      tokenBudget: 180_000,
      currentTokenCount: 220_000,
      runtimeContext: {
        trigger: "overflow",
        attempt: 2,
        maxAttempts: 3,
        currentTokenCount: 220_000,
      } as never,
      projectContextManager: projectContextManager as never,
    });

    expect(result.ok).toBe(true);
    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: expect.stringContaining("Overflow recovery attempt 2/3."),
      }),
    );
    expect(delegateCompactionToRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        customInstructions: expect.stringContaining(
          "Keep active blockers and edited files.",
        ),
      }),
    );
    const session = await store.getSession("agent:main:main");
    expect(session.compactionLifecycle.lastTrigger).toBe("overflow");
    expect(session.compactionLifecycle.lastOverflowRecoveryAttempt).toBe(2);
    expect(session.compactionLifecycle.lastOverflowRecoveryMaxAttempts).toBe(3);
    expect(session.compactionLifecycle.lastOverflowRecoveryMode).toBe("aggressive");
    expect(session.compactionLifecycle.overflowRecoveryProfile).toMatchObject({
      attempt: 2,
      maxAttempts: 3,
      mode: "aggressive",
      canReduceOutputTokens: false,
    });
    expect(session.compactionBias).toBe("aggressive");
    expect(session.reinjection?.summary?.length).toBeLessThanOrEqual(360);
    expect(session.pendingUserNotice?.source).toBe("overflow-recovery");
  });

  it("enters rescue bias on late overflow recovery attempts", async () => {
    const { dir, sessionFile } = await createSessionFile();
    const config = buildPluginConfig({ dataDir: dir });
    const store = new ContextDiagnosticsStore(config);
    await store.ensureReady();
    delegateCompactionToRuntimeMock.mockResolvedValue({
      ok: true,
      compacted: true,
      result: {
        summary: "rescue overflow summary " + "x".repeat(900),
        tokensBefore: 320_000,
        tokensAfter: 6_000,
      },
    });

    await compactContext({
      config,
      store,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      tokenBudget: 180_000,
      currentTokenCount: 260_000,
      runtimeContext: {
        trigger: "overflow",
        attempt: 3,
        maxAttempts: 3,
        currentTokenCount: 260_000,
      } as never,
    });

    const session = await store.getSession("agent:main:main");
    expect(session.compactionBias).toBe("rescue");
    expect(session.compactionLifecycle.overflowRecoveryProfile?.mode).toBe("rescue");
  });
});
