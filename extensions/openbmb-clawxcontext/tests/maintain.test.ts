import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginConfig } from "../src/config.js";
import { maintainContextTranscript } from "../src/context-engine/maintain.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createTempSessionFile(buildLines) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-maintain-"));
  tempDirs.push(dir);
  const sessionFile = path.join(dir, "session.jsonl");
  const lines = typeof buildLines === "function" ? buildLines(dir) : buildLines;
  await fs.writeFile(sessionFile, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf-8");
  return { dir, sessionFile };
}

async function createStore(dir, rawConfig = {}) {
  const config = buildPluginConfig({
    dataDir: dir,
    protectedRecentTurns: 1,
    ...rawConfig,
  });
  const store = new ContextDiagnosticsStore(config);
  await store.ensureReady();
  return { config, store };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("maintainContextTranscript", () => {
  it("snips large unprotected tool outputs", async () => {
    const { sessionFile, dir } = await createTempSessionFile((tempDir) => [
      { type: "session", version: 7, id: "session-1", timestamp: new Date().toISOString(), cwd: tempDir },
      { type: "message", id: "m1", parentId: null, timestamp: 1, message: { role: "user", content: "read file", timestamp: 1 } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: 2,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/a.ts" } }],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(5_000) }],
          isError: false,
          timestamp: 3,
        },
      },
      { type: "message", id: "m4", parentId: "m3", timestamp: 4, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4 } },
      { type: "message", id: "m5", parentId: "m4", timestamp: 5, message: { role: "user", content: "current turn", timestamp: 5 } },
    ]);
    const { config, store } = await createStore(dir, { microcompactEnabled: false });
    const rewriteTranscriptEntries = vi.fn(async ({ replacements }) => ({
      changed: true,
      bytesFreed: 4_000,
      rewrittenEntries: replacements.length,
    }));

    const result = await maintainContextTranscript({
      config,
      store,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile,
      runtimeContext: { rewriteTranscriptEntries },
    });

    expect(result.changed).toBe(true);
    expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);
    const replacement = rewriteTranscriptEntries.mock.calls[0][0].replacements[0];
    expect(replacement.entryId).toBe("m3");
    expect(JSON.stringify(replacement.message)).toContain(
      "[tool output compacted: read src/a.ts (5000 chars, ~63 lines)]",
    );
  });

  it("microcompacts stale read results after an edit on the same path", async () => {
    const { sessionFile, dir } = await createTempSessionFile((tempDir) => [
      { type: "session", version: 7, id: "session-2", timestamp: new Date().toISOString(), cwd: tempDir },
      { type: "message", id: "m1", parentId: null, timestamp: 1, message: { role: "user", content: "read file", timestamp: 1 } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: 2,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/a.ts" } }],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "small read result" }],
          isError: false,
          timestamp: 3,
        },
      },
      { type: "message", id: "m4", parentId: "m3", timestamp: 4, message: { role: "assistant", content: [{ type: "text", text: "done" }], timestamp: 4 } },
      { type: "message", id: "m5", parentId: "m4", timestamp: 5, message: { role: "user", content: "edit file", timestamp: 5 } },
      {
        type: "message",
        id: "m6",
        parentId: "m5",
        timestamp: 6,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_edit", name: "edit", arguments: { path: "src/a.ts" } }],
          timestamp: 6,
        },
      },
      {
        type: "message",
        id: "m7",
        parentId: "m6",
        timestamp: 7,
        message: {
          role: "toolResult",
          toolCallId: "call_edit",
          toolName: "edit",
          content: [{ type: "text", text: "edited" }],
          isError: false,
          timestamp: 7,
        },
      },
    ]);
    const { config, store } = await createStore(dir, { snipEnabled: false, microcompactEnabled: true });
    const rewriteTranscriptEntries = vi.fn(async ({ replacements }) => ({
      changed: true,
      bytesFreed: 120,
      rewrittenEntries: replacements.length,
    }));

    await maintainContextTranscript({
      config,
      store,
      sessionId: "session-2",
      sessionKey: "agent:main:main",
      sessionFile,
      runtimeContext: { rewriteTranscriptEntries },
    });

    const replacement = rewriteTranscriptEntries.mock.calls[0][0].replacements[0];
    expect(replacement.entryId).toBe("m3");
    expect(JSON.stringify(replacement.message)).toContain("[tool output outdated after edit: src/a.ts]");
    expect((await store.getSession("agent:main:main")).pendingUserNotice?.source).toBe(
      "stale-read",
    );
  });

  it("snips more aggressively in critical pressure than elevated pressure", async () => {
    const { sessionFile, dir } = await createTempSessionFile((tempDir) => [
      { type: "session", version: 7, id: "session-3", timestamp: new Date().toISOString(), cwd: tempDir },
      { type: "message", id: "m1", parentId: null, timestamp: 1, message: { role: "user", content: "read file", timestamp: 1 } },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: 2,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "src/a.ts" } }],
          timestamp: 2,
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: 3,
        message: {
          role: "toolResult",
          toolCallId: "call_read",
          toolName: "read",
          content: [{ type: "text", text: "x".repeat(500) }],
          isError: false,
          timestamp: 3,
        },
      },
      { type: "message", id: "m4", parentId: "m3", timestamp: 4, message: { role: "user", content: "current turn", timestamp: 4 } },
    ]);

    const { config, store } = await createStore(dir, { microcompactEnabled: false });
    await store.updatePressureState({
      sessionKey: "agent:main:main",
      pressureStage: "elevated",
      reinjectionMode: "summary+recent-files",
      debtBreakdown: {
        largeToolResultDebt: 0,
        readBloatDebt: 0,
        recentRewriteSavings: 0,
      },
      stabilizationTurnsRemaining: 0,
    });
    const elevatedRewrite = vi.fn(async ({ replacements }) => ({
      changed: true,
      bytesFreed: 100,
      rewrittenEntries: replacements.length,
    }));

    const elevatedResult = await maintainContextTranscript({
      config,
      store,
      sessionId: "session-3",
      sessionKey: "agent:main:main",
      sessionFile,
      runtimeContext: { rewriteTranscriptEntries: elevatedRewrite },
    });

    expect(elevatedResult.changed).toBe(false);
    expect(elevatedRewrite).not.toHaveBeenCalled();

    await store.updatePressureState({
      sessionKey: "agent:main:main",
      pressureStage: "critical",
      reinjectionMode: "summary-only",
      debtBreakdown: {
        largeToolResultDebt: 300,
        readBloatDebt: 0,
        recentRewriteSavings: 0,
      },
      stabilizationTurnsRemaining: 0,
    });
    const criticalRewrite = vi.fn(async ({ replacements }) => ({
      changed: true,
      bytesFreed: 100,
      rewrittenEntries: replacements.length,
    }));

    const criticalResult = await maintainContextTranscript({
      config,
      store,
      sessionId: "session-3",
      sessionKey: "agent:main:main",
      sessionFile,
      runtimeContext: { rewriteTranscriptEntries: criticalRewrite },
    });

    expect(criticalResult.changed).toBe(true);
    const replacement = criticalRewrite.mock.calls[0][0].replacements[0];
    expect(replacement.entryId).toBe("m3");
    expect(JSON.stringify(replacement.message)).toContain(
      "[tool output compacted: read src/a.ts (500 chars)]",
    );
  });
});
