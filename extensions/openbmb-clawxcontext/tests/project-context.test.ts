import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPluginConfig } from "../src/config.js";
import { ProjectContextManager } from "../src/context-engine/project-context.js";
import { ContextDiagnosticsStore } from "../src/diagnostics/store.js";

const tempDirs: string[] = [];

async function createHarness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawxcontext-project-"));
  tempDirs.push(dir);
  const homeDir = path.join(dir, "home");
  await fs.mkdir(path.join(homeDir, ".openclaw"), { recursive: true });
  vi.stubEnv("HOME", homeDir);
  const config = buildPluginConfig({ dataDir: dir });
  const store = new ContextDiagnosticsStore(config);
  await store.ensureReady();
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
        stdout:
          "abc123 tighten compact path\nbcd234 add hook metrics\ncde345 docs tweak\ndef456 add cache hints\nefg567 prune rules\n",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    }
    if (key === "git status --porcelain=v1 --branch") {
      return {
        stdout: "## main...origin/main [ahead 1]\n M src/index.ts\n?? notes.md\n",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    }
    if (key === "git diff --stat --compact-summary HEAD") {
      return {
        stdout: " src/index.ts | 12 ++++++++----\n src/runtime.ts | 4 ++--\n",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit" as const,
      };
    }
    return {
      stdout: "",
      stderr: "unsupported",
      code: 1,
      signal: null,
      killed: false,
      termination: "exit" as const,
    };
  });
  const manager = new ProjectContextManager(runCommand as never, store);
  return { dir, homeDir, store, runCommand, manager };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("ProjectContextManager", () => {
  it("loads OPENCLAW files, git context, and compact instructions while ignoring CLAUDE files", async () => {
    const { dir, homeDir, store, manager, runCommand } = await createHarness();
    await fs.writeFile(
      path.join(homeDir, ".openclaw", "OPENCLAW.md"),
      [
        "# User Defaults",
        "Always keep diagnostics terse.",
        "",
        "## Compact Instructions",
        "Retain the active task and user-specific defaults.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "OPENCLAW.md"),
      [
        "# Project Guide",
        "Prefer concise diagnostics.",
        "",
        "## Compact Instructions",
        "Keep the active task, current blockers, and recent files.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "OPENCLAW.local.md"),
      [
        "# Local Guide",
        "Use the local workspace defaults.",
        "",
        "## Compact Instructions",
        "Preserve local overrides and pending validation work.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "CLAUDE.md"),
      ["# Legacy Guide", "This file should not be loaded."].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      sessionKey: "agent:main:main",
      workspaceDir: dir,
      persist: true,
    });

    expect(loaded?.systemContext).toContain("User defaults from ~/.openclaw/OPENCLAW.md");
    expect(loaded?.systemContext).toContain("Project instructions from OPENCLAW.md");
    expect(loaded?.systemContext).toContain("Local overrides from OPENCLAW.local.md");
    expect(loaded?.systemContext).toContain("Runtime platform:");
    expect(loaded?.systemContext).not.toContain("Legacy Guide");
    expect(loaded?.dynamicContext).toContain("Current git branch: main");
    expect(loaded?.dynamicContext).toContain("HEAD: abc1234");
    expect(loaded?.dynamicContext).toContain("Modified: src/index.ts");
    expect(loaded?.dynamicContext).toContain("Untracked: notes.md");
    expect(loaded?.dynamicContext).toContain("Git diff summary:");
    expect(loaded?.compactInstructions).toContain("Keep the active task");
    expect(loaded?.compactInstructions).toContain("Preserve local overrides");
    expect(loaded?.compactInstructions).toContain("Retain the active task and user-specific defaults.");
    expect(runCommand).toHaveBeenCalledTimes(6);

    const session = await store.getSession("agent:main:main");
    expect(session.projectContext?.branch).toBe("main");
    expect(session.projectContext?.headSha).toBe("abc1234");
    expect(
      session.projectContext?.sources.some(
        (source) => source.kind === "userOpenclawMd" && source.present,
      ),
    ).toBe(true);
    expect(
      session.projectContext?.sources.some(
        (source) => source.kind === "openclawMd" && source.present,
      ),
    ).toBe(true);
    expect(session.projectContext?.stablePrefixPreview).toContain("User defaults from ~/.openclaw/OPENCLAW.md");
    expect(session.projectContext?.compactInstructionsPreview).toContain("Keep the active task");
    expect(session.projectContext?.gitDiffSummary[0]).toContain("src/index.ts");
  });

  it("marks only files with Compact Instructions as usedForCompaction", async () => {
    const { dir, homeDir, manager } = await createHarness();
    await fs.writeFile(
      path.join(homeDir, ".openclaw", "OPENCLAW.md"),
      ["# User Defaults", "", "## Compact Instructions", "Keep user defaults stable."].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "OPENCLAW.md"),
      ["# Project Guide", "Prompt rules only."].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, "OPENCLAW.local.md"),
      ["# Local Guide", "", "## Compact Instructions", "Preserve local validation notes."].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      workspaceDir: dir,
    });

    const sourcesByKind = new Map(loaded?.snapshot.sources.map((source) => [source.kind, source]));
    expect(sourcesByKind.get("userOpenclawMd")?.usedForCompaction).toBe(true);
    expect(sourcesByKind.get("openclawMd")?.usedForCompaction).toBe(false);
    expect(sourcesByKind.get("openclawLocalMd")?.usedForCompaction).toBe(true);
  });

  it("loads matched path-scoped rules into dynamic context and compaction instructions", async () => {
    const { dir, homeDir, manager } = await createHarness();
    await fs.mkdir(path.join(homeDir, ".openclaw", "rules", "packages"), { recursive: true });
    await fs.mkdir(path.join(dir, ".openclaw", "rules", "src"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".openclaw", "rules", "packages", "api.md"),
      [
        "# User Path Rule",
        "Prefer minimal API changes.",
      ].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      [
        "# Project Path Rule",
        "Preserve exported context-engine interfaces.",
        "",
        "## Compact Instructions",
        "Retain src/index.ts API changes and unresolved validation steps.",
      ].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      workspaceDir: dir,
      relevantFiles: ["packages/api/router.ts", "src/index.ts"],
    });

    expect(loaded?.dynamicContext).toContain("Matched path-scoped OPENCLAW rules");
    expect(loaded?.dynamicContext).toContain("Path scope: packages/api");
    expect(loaded?.dynamicContext).toContain("Path scope: src/index.ts");
    expect(loaded?.compactInstructions).toContain(
      "Retain src/index.ts API changes and unresolved validation steps.",
    );
    expect(
      loaded?.snapshot.sources.filter((source) => source.kind === "pathRule").map((source) => source.path),
    ).toEqual(
      expect.arrayContaining([
        path.join(homeDir, ".openclaw", "rules", "packages", "api.md"),
        path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      ]),
    );
  });

  it("matches path-scoped rules from absolute workspace paths", async () => {
    const { dir, manager } = await createHarness();
    await fs.mkdir(path.join(dir, ".openclaw", "rules", "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      [
        "# Project Path Rule",
        "Prefer stable src/index.ts edits.",
      ].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      workspaceDir: dir,
      relevantFiles: [path.join(dir, "src", "index.ts")],
    });

    expect(loaded?.dynamicContext).toContain("Path scope: src/index.ts");
    expect(loaded?.snapshot.activeRuleMatches?.[0]).toMatchObject({
      origin: "workspace",
      scope: "src/index.ts",
      matchedBy: ["legacy"],
    });
  });

  it("prioritizes workspace rules and can match them from error-path scope signals", async () => {
    const { dir, homeDir, manager } = await createHarness();
    await fs.mkdir(path.join(homeDir, ".openclaw", "rules", "src"), { recursive: true });
    await fs.mkdir(path.join(dir, ".openclaw", "rules", "src"), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, ".openclaw", "rules", "src", "index.ts.md"),
      ["# User Rule", "User-level src/index.ts guidance."].join("\n"),
      "utf-8",
    );
    await fs.writeFile(
      path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      ["# Workspace Rule", "Workspace-level src/index.ts guidance."].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      workspaceDir: dir,
      scopeSignals: [
        {
          path: "src/index.ts",
          source: "error",
          messageIndex: 9,
        },
      ],
    });

    expect(loaded?.dynamicContext).toContain("matched by error");
    expect(loaded?.snapshot.activeRuleMatches?.[0]).toMatchObject({
      origin: "workspace",
      scope: "src/index.ts",
      matchedBy: ["error"],
    });
  });

  it("matches scope signals provided as absolute workspace paths", async () => {
    const { dir, manager } = await createHarness();
    await fs.mkdir(path.join(dir, ".openclaw", "rules", "src"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".openclaw", "rules", "src", "index.ts.md"),
      ["# Workspace Rule", "Workspace-level src/index.ts guidance."].join("\n"),
      "utf-8",
    );

    const loaded = await manager.load({
      workspaceDir: dir,
      scopeSignals: [
        {
          path: path.join(dir, "src", "index.ts"),
          source: "edit",
          messageIndex: 7,
        },
      ],
    });

    expect(loaded?.snapshot.activeRuleMatches?.[0]).toMatchObject({
      origin: "workspace",
      scope: "src/index.ts",
      matchedBy: ["edit"],
    });
  });
});
