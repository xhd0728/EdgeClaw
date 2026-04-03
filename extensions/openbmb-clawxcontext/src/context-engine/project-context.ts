import fs from "node:fs/promises";
import { homedir, platform as platformName, arch, release } from "node:os";
import path from "node:path";
import type { PluginLogger, PluginRuntime } from "openclaw/plugin-sdk";
import type { ContextDiagnosticsStore } from "../diagnostics/store.js";
import type {
  ActiveScopeSignal,
  ProjectContextSnapshot,
  ProjectContextSource,
  RuleMatchSource,
} from "./types.js";

const GIT_TIMEOUT_MS = 2_500;
const MAX_CONTEXT_CHARS = 6_000;
const MAX_PREVIEW_CHARS = 320;
const MAX_DYNAMIC_RULES = 4;
const MAX_DYNAMIC_RULE_CHARS = 3_072;
const PLUGIN_STABLE_GUIDANCE =
  "ClawXContext maintains short-term context stability for OpenClaw. Treat these OPENCLAW instructions as durable project rules, not as per-turn chat content.";

type CommandRunner = PluginRuntime["system"]["runCommandWithTimeout"];

type PathRule = {
  path: string;
  scope: string;
  origin: "user" | "workspace";
  content: string;
  matchedBy: Array<"edit" | "read" | "search" | "error" | "legacy">;
  specificity: number;
  recentRank: number;
  compactInstructions?: string;
};

export type ResolvedProjectContext = {
  snapshot: ProjectContextSnapshot;
  systemContext?: string;
  dynamicContext?: string;
  compactInstructions?: string;
};

function truncateInline(value: string, maxLength = MAX_PREVIEW_CHARS): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function truncateBlock(value: string, maxLength = MAX_CONTEXT_CHARS): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function summarizePlatform(): string {
  return `${platformName()} ${arch()} (${release()})`;
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    const value = await fs.readFile(filePath, "utf-8");
    return value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

async function listMarkdownFiles(rootDir: string): Promise<string[]> {
  const queue = [rootDir];
  const files: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        files.push(nextPath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function normalizeScopePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function relativizeScopePath(candidatePath: string, workspaceDir: string | undefined): string {
  const normalized = normalizeScopePath(candidatePath);
  if (!workspaceDir || !path.isAbsolute(candidatePath)) {
    return normalized;
  }
  const relative = path.relative(workspaceDir, candidatePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return normalized;
  }
  return normalizeScopePath(relative);
}

function deriveRuleScope(rootDir: string, filePath: string): string {
  const relative = normalizeScopePath(path.relative(rootDir, filePath));
  return relative.replace(/\.md$/i, "");
}

function pathRuleMatches(scope: string, candidatePath: string): boolean {
  const normalizedScope = normalizeScopePath(scope);
  if (!normalizedScope) return false;
  const normalizedCandidate = normalizeScopePath(candidatePath);
  return (
    normalizedCandidate === normalizedScope ||
    normalizedCandidate.startsWith(`${normalizedScope}/`)
  );
}

function deriveScopeSignals(
  relevantFiles: string[],
  scopeSignals: ActiveScopeSignal[] | undefined,
  workspaceDir: string | undefined,
): ActiveScopeSignal[] {
  if (scopeSignals && scopeSignals.length > 0) {
    return scopeSignals.map((signal) => ({
      ...signal,
      path: relativizeScopePath(signal.path, workspaceDir),
    }));
  }
  return relevantFiles
    .map((value, index) => ({
      path: relativizeScopePath(value, workspaceDir),
      source: "legacy" as const,
      messageIndex: Math.max(0, relevantFiles.length - index),
    }))
    .filter((signal) => Boolean(signal.path));
}

function trimMatchedRules(pathRules: PathRule[]): PathRule[] {
  const selected: PathRule[] = [];
  let usedChars = 0;
  for (const rule of pathRules) {
    const cost = Math.min(rule.content.trim().length, 1_800);
    if (selected.length >= MAX_DYNAMIC_RULES) break;
    if (selected.length > 0 && usedChars + cost > MAX_DYNAMIC_RULE_CHARS) break;
    selected.push(rule);
    usedChars += cost;
  }
  return selected;
}

async function loadMatchedPathRules(params: {
  rootDir: string;
  relevantFiles: string[];
  scopeSignals?: ActiveScopeSignal[];
  workspaceDir?: string;
  origin: "user" | "workspace";
}): Promise<PathRule[]> {
  const signals = deriveScopeSignals(params.relevantFiles, params.scopeSignals, params.workspaceDir);
  if (signals.length === 0) return [];
  const ruleFiles = await listMarkdownFiles(params.rootDir);
  const matches: PathRule[] = [];
  for (const filePath of ruleFiles) {
    const scope = deriveRuleScope(params.rootDir, filePath);
    const matchingSignals = signals.filter((signal) => pathRuleMatches(scope, signal.path));
    if (matchingSignals.length === 0) continue;
    const content = await readOptionalFile(filePath);
    if (!content?.trim()) continue;
    const compactInstructions = extractMarkdownSection(content, "compact instructions");
    matches.push({
      path: filePath,
      scope,
      origin: params.origin,
      content,
      matchedBy: [...new Set(matchingSignals.map((signal) => signal.source))],
      specificity: scope.split("/").length,
      recentRank: Math.max(...matchingSignals.map((signal) => signal.messageIndex)),
      ...(compactInstructions ? { compactInstructions } : {}),
    });
  }
  return trimMatchedRules(
    matches.sort((left, right) => {
      if (left.origin !== right.origin) return left.origin === "workspace" ? -1 : 1;
      if (left.specificity !== right.specificity) return right.specificity - left.specificity;
      if (left.recentRank !== right.recentRank) return right.recentRank - left.recentRank;
      return left.scope.localeCompare(right.scope);
    }),
  );
}

function toRuleMatchSource(rule: PathRule): RuleMatchSource {
  return {
    path: rule.path,
    scope: rule.scope,
    origin: rule.origin,
    specificity: rule.specificity,
    matchedBy: rule.matchedBy,
    summary: truncateInline(rule.content),
    usedForCompaction: Boolean(rule.compactInstructions?.trim()),
  };
}

function summarizeRuleMatch(rule: PathRule): string {
  return `Path scope: ${rule.scope} (matched by ${rule.matchedBy.join(", ")})\n${truncateBlock(rule.content, 1_800)}`;
}

function renderRuleMatches(pathRules: PathRule[]): string | undefined {
  if (pathRules.length === 0) return undefined;
  return pathRules
    .map((rule) => summarizeRuleMatch(rule))
    .join("\n\n");
}

function extractMarkdownSection(content: string, headingLabel: string): string | undefined {
  const lines = content.split(/\r?\n/);
  const normalizedHeading = headingLabel.trim().toLowerCase();
  for (let index = 0; index < lines.length; index++) {
    const match = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const level = match[1]!.length;
    const heading = match[2]!.trim().replace(/[:：]\s*$/, "").toLowerCase();
    if (heading !== normalizedHeading) continue;
    const sectionLines: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const nextHeading = /^(#{1,6})\s+(.*\S)\s*$/.exec(lines[cursor] ?? "");
      if (nextHeading && nextHeading[1]!.length <= level) {
        break;
      }
      sectionLines.push(lines[cursor] ?? "");
    }
    const section = sectionLines.join("\n").trim();
    return section || undefined;
  }
  return undefined;
}

async function runGitCommand(
  runCommand: CommandRunner,
  cwd: string,
  argv: string[],
): Promise<string | undefined> {
  try {
    const result = await runCommand(argv, {
      cwd,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed) {
      return undefined;
    }
    const stdout = result.stdout.trim();
    return stdout || undefined;
  } catch {
    return undefined;
  }
}

function summarizeItems(prefix: string, values: string[], limit = 3): string | undefined {
  if (values.length === 0) return undefined;
  const head = values.slice(0, limit);
  const suffix = values.length > limit ? ` +${values.length - limit} more` : "";
  return `${prefix}: ${head.join(", ")}${suffix}`;
}

function parseGitStatusSummary(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const summary: string[] = [];
  const modified: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  const renamed: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      summary.push(`Branch state: ${line.slice(3).trim()}`);
      continue;
    }

    const status = line.slice(0, 2);
    const filePath = line.slice(3).trim();
    if (!filePath) continue;
    if (status === "??") {
      untracked.push(filePath);
      continue;
    }
    if (status.includes("U")) {
      conflicted.push(filePath);
      continue;
    }
    if (status.includes("R")) {
      renamed.push(filePath);
      continue;
    }
    if (status.includes("D")) {
      deleted.push(filePath);
      continue;
    }
    if (status.includes("A")) {
      added.push(filePath);
      continue;
    }
    modified.push(filePath);
  }

  for (const line of [
    summarizeItems("Modified", modified),
    summarizeItems("Added", added),
    summarizeItems("Deleted", deleted),
    summarizeItems("Renamed", renamed),
    summarizeItems("Untracked", untracked),
    summarizeItems("Conflicted", conflicted),
  ]) {
    if (line) summary.push(line);
  }

  if (summary.length === 0) {
    return ["Working tree clean"];
  }
  return summary;
}

function parseGitDiffSummary(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5);
}

async function resolveWorkspaceDirFromSessionFile(sessionFile: string | undefined): Promise<string | undefined> {
  if (!sessionFile) return undefined;
  try {
    const raw = await fs.readFile(sessionFile, "utf-8");
    const firstLine = raw.split(/\r?\n/, 1)[0]?.trim();
    if (!firstLine) return undefined;
    const parsed = JSON.parse(firstLine) as { cwd?: unknown };
    return typeof parsed.cwd === "string" && parsed.cwd.trim() ? parsed.cwd.trim() : undefined;
  } catch {
    return undefined;
  }
}

function renderStaticProjectContext(params: {
  userOpenclawMd: string | undefined;
  openclawMd: string | undefined;
  openclawLocalMd: string | undefined;
  platformSummary: string;
}): string | undefined {
  const sections: string[] = [];
  sections.push(`Runtime platform: ${params.platformSummary}`);
  sections.push(`ClawXContext policy:\n${PLUGIN_STABLE_GUIDANCE}`);
  if (params.userOpenclawMd?.trim()) {
    sections.push(
      `User defaults from ~/.openclaw/OPENCLAW.md:\n${truncateBlock(params.userOpenclawMd)}`,
    );
  }
  if (params.openclawMd?.trim()) {
    sections.push(`Project instructions from OPENCLAW.md:\n${truncateBlock(params.openclawMd)}`);
  }
  if (params.openclawLocalMd?.trim()) {
    sections.push(
      `Local overrides from OPENCLAW.local.md:\n${truncateBlock(params.openclawLocalMd)}`,
    );
  }
  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function renderDynamicProjectContext(params: {
  branch: string | undefined;
  headSha: string | undefined;
  recentCommits: string[];
  gitStatusSummary: string[];
  gitDiffSummary: string[];
  pathRules: PathRule[];
}): string | undefined {
  const sections: string[] = [];
  if (params.branch) {
    sections.push(`Current git branch: ${params.branch}`);
  }
  if (params.headSha) {
    sections.push(`HEAD: ${params.headSha}`);
  }
  if (params.recentCommits.length > 0) {
    sections.push(`Recent commits:\n- ${params.recentCommits.join("\n- ")}`);
  }
  if (params.gitStatusSummary.length > 0) {
    sections.push(`Git status summary:\n- ${params.gitStatusSummary.join("\n- ")}`);
  }
  if (params.gitDiffSummary.length > 0) {
    sections.push(`Git diff summary:\n- ${params.gitDiffSummary.join("\n- ")}`);
  }
  if (params.pathRules.length > 0) {
    const renderedRules = renderRuleMatches(params.pathRules);
    if (renderedRules) {
      sections.push(`Matched path-scoped OPENCLAW rules:\n${renderedRules}`);
    }
  }
  if (sections.length === 0) return undefined;
  return `Project state maintained by ClawXContext.\n\n${sections.join("\n\n")}`;
}

function buildSources(params: {
  userOpenclawMdPath: string;
  userOpenclawMd: string | undefined;
  userCompactInstructions: string | undefined;
  openclawMdPath: string;
  openclawMd: string | undefined;
  openclawCompactInstructions: string | undefined;
  openclawLocalMdPath: string;
  openclawLocalMd: string | undefined;
  openclawLocalCompactInstructions: string | undefined;
  pathRules: PathRule[];
  gitAvailable: boolean;
  gitRoot: string | undefined;
}): ProjectContextSource[] {
  return [
    {
      kind: "userOpenclawMd",
      present: Boolean(params.userOpenclawMd?.trim()),
      path: params.userOpenclawMdPath,
      ...(params.userOpenclawMd ? { summary: truncateInline(params.userOpenclawMd) } : {}),
      usedForPrompt: Boolean(params.userOpenclawMd?.trim()),
      usedForCompaction: Boolean(params.userCompactInstructions?.trim()),
    },
    {
      kind: "openclawMd",
      present: Boolean(params.openclawMd?.trim()),
      path: params.openclawMdPath,
      ...(params.openclawMd ? { summary: truncateInline(params.openclawMd) } : {}),
      usedForPrompt: Boolean(params.openclawMd?.trim()),
      usedForCompaction: Boolean(params.openclawCompactInstructions?.trim()),
    },
    {
      kind: "openclawLocalMd",
      present: Boolean(params.openclawLocalMd?.trim()),
      path: params.openclawLocalMdPath,
      ...(params.openclawLocalMd ? { summary: truncateInline(params.openclawLocalMd) } : {}),
      usedForPrompt: Boolean(params.openclawLocalMd?.trim()),
      usedForCompaction: Boolean(params.openclawLocalCompactInstructions?.trim()),
    },
    ...params.pathRules.map((rule) => ({
      kind: "pathRule" as const,
      present: true,
      path: rule.path,
      summary: `scope ${rule.scope}: ${truncateInline(rule.content)}`,
      usedForPrompt: true,
      usedForCompaction: Boolean(rule.compactInstructions?.trim()),
    })),
    {
      kind: "git",
      present: params.gitAvailable,
      ...(params.gitRoot ? { path: params.gitRoot } : {}),
      ...(params.gitAvailable
        ? { summary: "git branch / recent commits / status available" }
        : {}),
      usedForPrompt: params.gitAvailable,
      usedForCompaction: false,
    },
  ];
}

export class ProjectContextManager {
  constructor(
    private readonly runCommand: CommandRunner,
    private readonly store: ContextDiagnosticsStore,
    private readonly logger?: PluginLogger,
  ) {}

  async load(params: {
    sessionKey?: string;
    workspaceDir?: string;
    sessionFile?: string;
    persist?: boolean;
    relevantFiles?: string[];
    scopeSignals?: ActiveScopeSignal[];
  }): Promise<ResolvedProjectContext | undefined> {
    const workspaceDir =
      params.workspaceDir?.trim() || (await resolveWorkspaceDirFromSessionFile(params.sessionFile));
    if (!workspaceDir) {
      return undefined;
    }

    const userOpenclawMdPath = path.join(homedir(), ".openclaw", "OPENCLAW.md");
    const openclawMdPath = path.join(workspaceDir, "OPENCLAW.md");
    const openclawLocalMdPath = path.join(workspaceDir, "OPENCLAW.local.md");
    const [userOpenclawMd, openclawMd, openclawLocalMd] = await Promise.all([
      readOptionalFile(userOpenclawMdPath),
      readOptionalFile(openclawMdPath),
      readOptionalFile(openclawLocalMdPath),
    ]);

    const userCompactInstructions = userOpenclawMd
      ? extractMarkdownSection(userOpenclawMd, "compact instructions")
      : undefined;
    const openclawCompactInstructions = openclawMd
      ? extractMarkdownSection(openclawMd, "compact instructions")
      : undefined;
    const openclawLocalCompactInstructions = openclawLocalMd
      ? extractMarkdownSection(openclawLocalMd, "compact instructions")
      : undefined;
    const compactInstructionsBlocks = [
      userCompactInstructions,
      openclawCompactInstructions,
      openclawLocalCompactInstructions,
    ].filter((value): value is string => Boolean(value?.trim()));

    const relevantFiles = (params.relevantFiles ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
    const [userPathRules, workspacePathRules] = await Promise.all([
      loadMatchedPathRules({
        rootDir: path.join(homedir(), ".openclaw", "rules"),
        relevantFiles,
        workspaceDir,
        origin: "user",
        ...(params.scopeSignals ? { scopeSignals: params.scopeSignals } : {}),
      }),
      loadMatchedPathRules({
        rootDir: path.join(workspaceDir, ".openclaw", "rules"),
        relevantFiles,
        workspaceDir,
        origin: "workspace",
        ...(params.scopeSignals ? { scopeSignals: params.scopeSignals } : {}),
      }),
    ]);
    const matchedPathRules = trimMatchedRules(
      [...workspacePathRules, ...userPathRules].sort((left, right) => {
        if (left.origin !== right.origin) return left.origin === "workspace" ? -1 : 1;
        if (left.specificity !== right.specificity) return right.specificity - left.specificity;
        if (left.recentRank !== right.recentRank) return right.recentRank - left.recentRank;
        return left.scope.localeCompare(right.scope);
      }),
    );
    for (const rule of matchedPathRules) {
      if (rule.compactInstructions?.trim()) {
        compactInstructionsBlocks.push(rule.compactInstructions.trim());
      }
    }
    const compactInstructions =
      compactInstructionsBlocks.length > 0 ? compactInstructionsBlocks.join("\n\n") : undefined;

    const gitRoot = await runGitCommand(this.runCommand, workspaceDir, [
      "git",
      "rev-parse",
      "--show-toplevel",
    ]);
    const gitAvailable = Boolean(gitRoot);
    const [branch, headSha, recentCommitsRaw, statusRaw, diffRaw] = gitAvailable
      ? await Promise.all([
          runGitCommand(this.runCommand, workspaceDir, ["git", "branch", "--show-current"]),
          runGitCommand(this.runCommand, workspaceDir, ["git", "rev-parse", "--short", "HEAD"]),
          runGitCommand(this.runCommand, workspaceDir, [
            "git",
            "log",
            "--pretty=format:%h %s",
            "-n",
            "5",
            "--no-show-signature",
          ]),
          runGitCommand(this.runCommand, workspaceDir, [
            "git",
            "status",
            "--porcelain=v1",
            "--branch",
          ]),
          runGitCommand(this.runCommand, workspaceDir, [
            "git",
            "diff",
            "--stat",
            "--compact-summary",
            "HEAD",
          ]),
        ])
      : [undefined, undefined, undefined, undefined, undefined];

    const recentCommits = recentCommitsRaw
      ? recentCommitsRaw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];
    const gitStatusSummary = parseGitStatusSummary(statusRaw);
    const gitDiffSummary = parseGitDiffSummary(diffRaw);
    const platformSummary = summarizePlatform();

    const systemContext = renderStaticProjectContext({
      userOpenclawMd,
      openclawMd,
      openclawLocalMd,
      platformSummary,
    });
    const dynamicContext = renderDynamicProjectContext({
      branch,
      headSha,
      recentCommits,
      gitStatusSummary,
      gitDiffSummary,
      pathRules: matchedPathRules,
    });
    const snapshot: ProjectContextSnapshot = {
      workspaceDir,
      platform: platformSummary,
      ...(branch ? { branch } : {}),
      ...(headSha ? { headSha } : {}),
      recentCommits,
      gitStatusSummary,
      gitDiffSummary,
      sources: buildSources({
        userOpenclawMdPath,
        userOpenclawMd,
        userCompactInstructions,
        openclawMdPath,
        openclawMd,
        openclawCompactInstructions,
        openclawLocalMdPath,
        openclawLocalMd,
        openclawLocalCompactInstructions,
        pathRules: matchedPathRules,
        gitAvailable,
        gitRoot,
      }),
      ...(systemContext ? { stablePrefixPreview: truncateInline(systemContext) } : {}),
      ...(systemContext ? { staticContextPreview: truncateInline(systemContext) } : {}),
      ...(dynamicContext ? { dynamicContextPreview: truncateInline(dynamicContext) } : {}),
      ...(compactInstructions
        ? { compactInstructionsPreview: truncateInline(compactInstructions) }
        : {}),
      ...(matchedPathRules.length > 0
        ? { activeRuleMatches: matchedPathRules.map((rule) => toRuleMatchSource(rule)) }
        : {}),
      lastLoadedAt: new Date().toISOString(),
    };

    if (params.persist && params.sessionKey) {
      try {
        await this.store.updateProjectContext(params.sessionKey, snapshot);
      } catch (error) {
        void error;
        this.logger?.warn?.("ClawXContext failed to persist project context");
      }
    }

    return {
      snapshot,
      ...(systemContext ? { systemContext } : {}),
      ...(dynamicContext ? { dynamicContext } : {}),
      ...(compactInstructions ? { compactInstructions } : {}),
    };
  }
}
