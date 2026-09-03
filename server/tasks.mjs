import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { CodexAppServer } from "./codex-app-server.mjs";
import { normalizeSource, tasksPath } from "./runtime-paths.mjs";

const LOCAL_CODEX_DIR = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const SESSION_INDEX = path.join(LOCAL_CODEX_DIR, "session_index.jsonl");
const SUMMARY_DB = path.join(LOCAL_CODEX_DIR, "sqlite", "codex-thread-summaries-dev.db");
const LOCAL_CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
const CLAUDE_PROJECTS_DIR = path.join(LOCAL_CLAUDE_DIR, "projects");

async function readIndex() {
  const lines = (await readFile(SESSION_INDEX, "utf8")).split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

function readCachedSummaries() {
  try {
    const output = execFileSync("sqlite3", [
      "-json",
      SUMMARY_DB,
      "select thread_id, summary, compact_summary, revision, updated_at from thread_turn_summaries",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(output || "[]");
  } catch {
    return [];
  }
}

export function cleanText(value, maxLength = 600) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function summarizeTasks(tasks) {
  return {
    tasks: tasks.length,
    withContext: tasks.filter((task) => task.summarySource && task.summarySource !== "none").length,
    cachedSummaries: tasks.filter((task) => task.summarySource === "cached_summary").length,
    compactSummaries: tasks.filter((task) => task.summarySource === "compact_summary").length,
    initialPreviews: tasks.filter((task) => task.summarySource === "initial_preview").length,
    userTurnOutlines: tasks.filter((task) => task.summarySource === "user_turn_outline").length,
    titleOnly: tasks.filter((task) => task.summarySource === "none").length,
  };
}

export function scopeRecentTasks(payload, limit = 250) {
  const numericLimit = Math.max(1, Math.floor(Number(limit) || 250));
  const tasks = (payload?.tasks || []).slice(0, numericLimit);
  return {
    ...payload,
    counts: summarizeTasks(tasks),
    scope: {
      kind: "most_recent",
      limit: numericLimit,
      available: payload?.tasks?.length || 0,
    },
    tasks,
  };
}

async function importCodexTasks({ projectRoot, useAppServer = true } = {}) {
  const index = await readIndex();
  const summaries = new Map(readCachedSummaries().map((record) => [record.thread_id, record]));
  let appThreads = [];
  let appServerError = null;

  if (useAppServer) {
    const client = new CodexAppServer();
    try {
      await client.start();
      appThreads = await client.listProfileableThreads();
    } catch (error) {
      appServerError = error.message;
    } finally {
      await client.close();
    }
  }

  const appById = new Map(appThreads.map((thread) => [thread.id, thread]));
  // When app-server is available, its filtered list is authoritative. The raw
  // index can also contain temporary exec/coordinator sessions and other
  // internals that should not enter a user-level profile. Both active and
  // user-archived app-server tasks are included in the authoritative list.
  const allIds = useAppServer && !appServerError
    ? new Set(appById.keys())
    : new Set(index.map((record) => record.id));
  const indexById = new Map(index.map((record) => [record.id, record]));

  const tasks = [...allIds].map((id) => {
    const indexed = indexById.get(id);
    const thread = appById.get(id);
    const cached = summaries.get(id);
    const title = cleanText(indexed?.thread_name || thread?.name || thread?.preview, 180) || "Untitled task";
    const cachedSummary = cleanText(cached?.summary);
    const preview = cleanText(thread?.preview);
    const summary = cachedSummary || (preview && preview !== title ? preview : null);
    const summarySource = cachedSummary ? "cached_summary" : summary ? "initial_preview" : "none";
    const updatedAt = indexed?.updated_at || (thread?.updatedAt ? new Date(thread.updatedAt * 1000).toISOString() : null);

    return {
      id,
      platform: "codex",
      title,
      summary,
      summarySource,
      updatedAt,
      createdAt: thread?.createdAt ? new Date(thread.createdAt * 1000).toISOString() : null,
      evidence: summary ? `${title}\n\n${summary}` : title,
    };
  }).sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));

  const payload = {
    version: 1,
    importedAt: new Date().toISOString(),
    platform: "codex",
    source: useAppServer && !appServerError ? "codex_app_server_profileable_threads" : "local_index_fallback",
    appServerError,
    counts: summarizeTasks(tasks),
    excludedIndexOnly: useAppServer && !appServerError
      ? index.filter((record) => !appById.has(record.id)).length
      : 0,
    tasks,
  };

  if (projectRoot) {
    const target = tasksPath(projectRoot, "codex");
    const runtime = path.dirname(target);
    await mkdir(runtime, { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  return payload;
}

async function findClaudeSessionFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return files;
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      // Claude stores child-agent transcripts under `subagents/`; those are
      // implementation details of a top-level session, not separate user tasks.
      if (entry.isDirectory() && entry.name !== "subagents") pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(candidate);
    }
  }
  return files;
}

export function cleanClaudeUserText(value) {
  if (typeof value !== "string") return null;
  const withoutInjectedContext = value.replace(
    /<(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|in-app-browser-context|command-name|command-message|command-args)\b[^>]*>[\s\S]*?<\/(?:system-reminder|local-command-caveat|ide_opened_file|ide_selection|in-app-browser-context|command-name|command-message|command-args)>/gi,
    " ",
  );
  return cleanText(withoutInjectedContext, 2_000);
}

export function sampleTrajectory(turns, limit = 24) {
  const usable = turns.filter(Boolean);
  if (usable.length <= limit) return usable;
  const indices = new Set();
  for (let index = 0; index < limit; index += 1) {
    indices.add(Math.round(index * (usable.length - 1) / (limit - 1)));
  }
  return [...indices].sort((left, right) => left - right).map((index) => usable[index]);
}

function trajectorySummary(turns) {
  if (!turns.length) return null;
  if (turns.length === 1) return cleanText(`Request: ${turns[0]}`);
  return cleanText(`Initial request: ${turns[0]} Latest request: ${turns.at(-1)}`);
}

async function readClaudeMetadata(file) {
  const metadata = await stat(file);
  let sessionId = path.basename(file, ".jsonl");
  let title = null;
  let compactSummary = null;
  const userTurns = [];
  let latestTimestamp = null;
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const isMetadata = record?.type === "ai-title" || record?.type === "last-prompt";
    const isPlainUserTurn = record?.type === "user"
      && record?.message?.role === "user"
      && typeof record?.message?.content === "string"
      && !record?.isSidechain;
    if (!isMetadata && !isPlainUserTurn) continue;
    sessionId = cleanText(record.sessionId, 180) || sessionId;
    const timestamp = cleanText(record.timestamp, 80);
    if (timestamp && (!latestTimestamp || timestamp > latestTimestamp)) latestTimestamp = timestamp;
    if (record.type === "ai-title") title = cleanText(record.aiTitle, 180) || title;
    if (isPlainUserTurn) {
      const text = cleanClaudeUserText(record.message.content);
      if (record.isCompactSummary) compactSummary = cleanText(text, 3_000) || compactSummary;
      else if (text) userTurns.push(cleanText(text, 500));
    }
  }

  const sampledTurns = sampleTrajectory(userTurns, 24);
  const fallbackTitle = sampledTurns[0] ? cleanText(sampledTurns[0], 180) : null;
  const resolvedTitle = title || fallbackTitle || "Untitled Claude session";
  const outline = trajectorySummary(sampledTurns);
  const summary = compactSummary || outline;
  const summarySource = compactSummary ? "compact_summary" : outline ? "user_turn_outline" : "none";
  const evidenceSections = [resolvedTitle];
  if (compactSummary) evidenceSections.push(`Claude compact summary:\n${compactSummary}`);
  if (sampledTurns.length) {
    evidenceSections.push(`Human request trajectory (${userTurns.length} total turns; ${sampledTurns.length} sampled):\n${sampledTurns.map((turn, index) => `${index + 1}. ${turn}`).join("\n")}`);
  }
  return {
    id: `claude:${sessionId}`,
    platform: "claude",
    title: resolvedTitle,
    summary,
    summarySource,
    userTurnCount: userTurns.length,
    updatedAt: latestTimestamp || metadata.mtime.toISOString(),
    createdAt: metadata.birthtime?.toISOString() || null,
    evidence: evidenceSections.join("\n\n").slice(0, 10_000),
  };
}

export async function importClaudeTasks({ projectRoot, projectsDirectory = CLAUDE_PROJECTS_DIR } = {}) {
  const files = await findClaudeSessionFiles(projectsDirectory);
  const settled = await Promise.allSettled(files.map(readClaudeMetadata));
  const tasks = settled
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  const failedFiles = settled.filter((result) => result.status === "rejected").length;
  const payload = {
    version: 1,
    importedAt: new Date().toISOString(),
    platform: "claude",
    source: "claude_code_metadata_records",
    counts: summarizeTasks(tasks),
    failedFiles,
    tasks,
  };

  if (projectRoot) {
    const target = tasksPath(projectRoot, "claude");
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
  return payload;
}

export async function importTasks({ projectRoot, source = "codex", useAppServer = true, projectsDirectory } = {}) {
  return normalizeSource(source) === "claude"
    ? importClaudeTasks({ projectRoot, projectsDirectory })
    : importCodexTasks({ projectRoot, useAppServer });
}

export async function loadTasks(projectRoot, source = "codex") {
  const normalized = normalizeSource(source);
  try {
    return JSON.parse(await readFile(tasksPath(projectRoot, normalized), "utf8"));
  } catch {
    return importTasks({ projectRoot, source: normalized, useAppServer: normalized === "codex" ? false : undefined });
  }
}
