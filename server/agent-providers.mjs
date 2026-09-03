import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { resolveCodexBinary } from "./codex-app-server.mjs";
import { normalizeSource } from "./runtime-paths.mjs";

async function firstExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next conventional install location.
    }
  }
  return null;
}

export async function resolveClaudeBinary() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  return await firstExecutable([
    path.join(homedir(), ".local", "bin", "claude"),
    path.join(homedir(), ".claude", "local", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) || "claude";
}

async function isRunnable(binary) {
  if (path.isAbsolute(binary)) {
    try {
      await access(binary, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export async function detectAgentProviders() {
  const [codexBinary, claudeBinary] = await Promise.all([resolveCodexBinary(), resolveClaudeBinary()]);
  const [codex, claude] = await Promise.all([isRunnable(codexBinary), isRunnable(claudeBinary)]);
  return { codex, claude };
}

export function chooseAgentProvider(source, availability) {
  const normalized = normalizeSource(source);
  if (availability?.[normalized]) return normalized;
  const fallback = normalized === "codex" ? "claude" : "codex";
  if (availability?.[fallback]) return fallback;
  return normalized;
}

export async function coordinatorInvocation(provider, projectRoot, prompt) {
  if (normalizeSource(provider) === "claude") {
    return {
      binary: await resolveClaudeBinary(),
      args: [
        "--print",
        prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", "Read,Glob,Grep,Agent,Bash(node scripts/validate-run.mjs:*)",
      ],
    };
  }
  return {
    binary: await resolveCodexBinary(),
    args: [
      "exec",
      "--sandbox", "workspace-write",
      "--json",
      "--cd", projectRoot,
      prompt,
    ],
  };
}

export function coordinatorPromptFile(provider) {
  return normalizeSource(provider) === "claude"
    ? "claude-coordinator-prompt.md"
    : "coordinator-prompt.md";
}

export function classifierDescriptor(provider) {
  if (normalizeSource(provider) === "claude") {
    return {
      agent: "ai-use-classifier",
      model: "inherit",
      reasoningEffort: "inherit",
      protocolVersion: 1,
    };
  }
  return {
    agent: "ai_use_classifier",
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    protocolVersion: 1,
  };
}

export function parseCoordinatorEvent(provider, line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (normalizeSource(provider) === "claude") {
    const text = event?.message?.content
      ?.filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join(" ");
    return {
      sessionId: event?.session_id || null,
      message: text || (event?.type === "result" ? event.result : null),
    };
  }
  const item = event.item;
  return {
    sessionId: event.type === "thread.started" ? event.thread_id : null,
    workerStarted: event.type === "item.started" && item?.type === "collab_tool_call" && item.tool === "spawn_agent",
    workerDispatched: event.type === "item.completed" && item?.type === "collab_tool_call" && item.tool === "spawn_agent",
    workerUpdate: event.type === "item.completed" && item?.type === "collab_tool_call" && item.tool === "wait_agent",
    message: event.type === "item.completed" && item?.type === "agent_message" ? item.text : null,
  };
}
