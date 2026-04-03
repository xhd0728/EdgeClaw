import type { IndexedToolResult, PressureStage } from "./types.js";

function readStringArg(args: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!args) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function countApproxLines(text: string): number {
  const explicit = text.split(/\r?\n/).filter((line) => line.trim()).length;
  if (explicit > 1) return explicit;
  return Math.max(1, Math.round(text.length / 80));
}

function truncateInline(value: string, maxLength: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return "";
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 1)}…` : trimmed;
}

function countResultItems(text: string): number {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
}

function summarizeRead(entry: IndexedToolResult, detailMode: "short" | "medium"): string {
  const target = entry.path ?? "unknown path";
  const lineCount = countApproxLines(entry.text);
  if (detailMode === "short") {
    return `[tool output compacted: read ${target} (${entry.text.length} chars)]`;
  }
  return `[tool output compacted: read ${target} (${entry.text.length} chars, ~${lineCount} lines)]`;
}

function summarizeGrepLike(
  entry: IndexedToolResult,
  detailMode: "short" | "medium",
  toolName: "grep" | "glob",
): string {
  const query =
    toolName === "grep"
      ? readStringArg(entry.args, ["pattern", "query", "search", "regex", "match"])
      : readStringArg(entry.args, ["pattern", "glob", "query"]);
  const target = entry.path ?? readStringArg(entry.args, ["cwd", "root", "path"]);
  const count = countResultItems(entry.text);
  const labelParts = [toolName, query ? `"${truncateInline(query, 48)}"` : "", target ?? ""]
    .filter(Boolean)
    .join(" ");
  const noun = toolName === "grep" ? "hits" : "matches";
  if (detailMode === "short") {
    return `[tool output compacted: ${labelParts} (${count} ${noun})]`;
  }
  return `[tool output compacted: ${labelParts} (${count} ${noun}, ${entry.text.length} chars)]`;
}

function parseExitLabel(entry: IndexedToolResult): string {
  const match = /exit(?:ed)?(?: with)? code[:= ]+(\d+)/i.exec(entry.text);
  if (match?.[1]) return `exit ${match[1]}`;
  return entry.isError ? "error" : "ok";
}

function summarizeCommand(entry: IndexedToolResult, detailMode: "short" | "medium"): string {
  const command = readStringArg(entry.args, ["command", "cmd", "script", "shellCommand"]);
  const exitLabel = parseExitLabel(entry);
  const preview = entry.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, detailMode === "short" ? 1 : 2)
    .map((line) => truncateInline(line, detailMode === "short" ? 56 : 72))
    .join(" | ");
  const label = [entry.toolName, command ? truncateInline(command, detailMode === "short" ? 48 : 72) : ""]
    .filter(Boolean)
    .join(" ");
  if (!preview) {
    return `[tool output compacted: ${label} (${exitLabel})]`;
  }
  return `[tool output compacted: ${label} (${exitLabel}) ${preview}]`;
}

function summarizeWeb(entry: IndexedToolResult, detailMode: "short" | "medium"): string {
  const target = readStringArg(entry.args, ["url", "query", "q", "search", "title"]) ?? entry.path;
  const preview = entry.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  const resultCount = countResultItems(entry.text);
  const targetLabel = target ? truncateInline(target, detailMode === "short" ? 52 : 72) : entry.toolName;
  const previewLabel = preview ? truncateInline(preview, detailMode === "short" ? 56 : 72) : "";
  if (detailMode === "short") {
    return `[tool output compacted: ${entry.toolName} ${targetLabel} (${resultCount} lines)]`;
  }
  if (!previewLabel) {
    return `[tool output compacted: ${entry.toolName} ${targetLabel} (${resultCount} lines)]`;
  }
  return `[tool output compacted: ${entry.toolName} ${targetLabel} ${previewLabel}]`;
}

export function summarizeCompactedToolOutput(
  entry: IndexedToolResult,
  stage: PressureStage,
): string {
  const detailMode = stage === "critical" ? "short" : "medium";
  if (entry.toolName === "read") {
    return summarizeRead(entry, detailMode);
  }
  if (entry.toolName === "grep") {
    return summarizeGrepLike(entry, detailMode, "grep");
  }
  if (entry.toolName === "glob") {
    return summarizeGrepLike(entry, detailMode, "glob");
  }
  if (
    entry.toolName === "bash" ||
    entry.toolName === "exec"
  ) {
    return summarizeCommand(entry, detailMode);
  }
  if (
    entry.toolName === "web_fetch" ||
    entry.toolName === "web_search" ||
    entry.toolName === "search" ||
    entry.toolName === "fetch"
  ) {
    return summarizeWeb(entry, detailMode);
  }
  const label = entry.path ? `${entry.toolName} ${entry.path}` : entry.toolName;
  return `[tool output compacted: ${label}]`;
}
