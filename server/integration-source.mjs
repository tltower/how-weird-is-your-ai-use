import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SESSION_SOURCES } from "./runtime-paths.mjs";

function explicitSource(value, setting) {
  if (value == null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "claude" || normalized === "claude-code") return "claude";
  if (normalized === "codex") return "codex";
  throw new Error(`${setting} must be one of: ${SESSION_SOURCES.join(", ")}.`);
}

function hasValue(value) {
  if (value == null) return false;
  return !["", "0", "false", "no", "off"].includes(String(value).trim().toLowerCase());
}

export function sourceArgument(argv = process.argv) {
  const inline = argv.find((argument) => argument.startsWith("--source="));
  if (inline) return explicitSource(inline.slice("--source=".length), "--source");
  const index = argv.indexOf("--source");
  if (index < 0) return null;
  if (argv[index + 1] == null || argv[index + 1].startsWith("--")) {
    throw new Error("--source requires codex or claude.");
  }
  return explicitSource(argv[index + 1], "--source");
}

export function sourceFromEnvironment(env = process.env) {
  const configured = env.AI_USE_PROFILE_SOURCE ?? env.AI_USE_PROFILE_INTEGRATION;
  if (configured != null && String(configured).trim() !== "") {
    return { source: explicitSource(configured, "AI_USE_PROFILE_SOURCE"), selectedBy: "integration_config" };
  }
  if (hasValue(env.CLAUDECODE) || hasValue(env.CLAUDE_CODE_ENTRYPOINT)) {
    return { source: "claude", selectedBy: "claude_launcher" };
  }
  if (hasValue(env.CODEX_THREAD_ID) || hasValue(env.CODEX_SANDBOX)) {
    return { source: "codex", selectedBy: "codex_launcher" };
  }
  return null;
}

async function readable(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasCodexHistory(directory) {
  const index = path.join(directory, "session_index.jsonl");
  if (!await readable(index)) return false;
  try {
    return (await stat(index)).size > 0;
  } catch {
    return false;
  }
}

async function hasClaudeHistory(directory) {
  const pending = [path.join(directory, "projects")];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EACCES") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return true;
      if (entry.isDirectory() && entry.name !== "subagents") pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

export async function detectSessionSources({ env = process.env, homeDirectory = homedir() } = {}) {
  const codexDirectory = env.CODEX_HOME || path.join(homeDirectory, ".codex");
  const claudeDirectory = env.CLAUDE_CONFIG_DIR || path.join(homeDirectory, ".claude");
  const [codex, claude] = await Promise.all([
    hasCodexHistory(codexDirectory),
    hasClaudeHistory(claudeDirectory),
  ]);
  return { codex, claude };
}

export async function resolveIntegrationSource({
  requestedSource = null,
  env = process.env,
  agentProviders = {},
  sessionSources = null,
  homeDirectory,
} = {}) {
  const requested = explicitSource(requestedSource, "source");
  if (requested) return { source: requested, selectedBy: "startup_option" };

  const environmentSelection = sourceFromEnvironment(env);
  if (environmentSelection) return environmentSelection;

  if (Boolean(agentProviders.codex) !== Boolean(agentProviders.claude)) {
    return {
      source: agentProviders.claude ? "claude" : "codex",
      selectedBy: "available_agent",
    };
  }

  const histories = sessionSources || await detectSessionSources({ env, homeDirectory });
  if (Boolean(histories.codex) !== Boolean(histories.claude)) {
    return {
      source: histories.claude ? "claude" : "codex",
      selectedBy: "available_history",
    };
  }

  return { source: "codex", selectedBy: "default" };
}
