import path from "node:path";

export const SESSION_SOURCES = Object.freeze(["codex", "claude"]);

export function normalizeSource(value) {
  return value === "claude" ? "claude" : "codex";
}

export function sourceLabel(source) {
  return normalizeSource(source) === "claude" ? "Claude Code" : "Codex";
}

export function runtimeDirectory(projectRoot, source = "codex") {
  return normalizeSource(source) === "codex"
    ? path.join(projectRoot, "runtime")
    : path.join(projectRoot, "runtime", "claude");
}

export function tasksPath(projectRoot, source = "codex") {
  return path.join(runtimeDirectory(projectRoot, source), "tasks.json");
}

export function classificationsPath(projectRoot, source = "codex") {
  return path.join(runtimeDirectory(projectRoot, source), "classifications.jsonl");
}

export function runsDirectory(projectRoot, source = "codex") {
  return path.join(runtimeDirectory(projectRoot, source), "runs");
}

export function runDirectory(projectRoot, source, runId) {
  return path.join(runsDirectory(projectRoot, source), runId);
}
