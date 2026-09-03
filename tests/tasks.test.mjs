import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanClaudeUserText, importClaudeTasks, scopeRecentTasks } from "../server/tasks.mjs";

test("recent task scope keeps the newest bounded cohort and recomputes evidence counts", () => {
  const tasks = [
    { id: "new", summarySource: "cached_summary" },
    { id: "middle", summarySource: "initial_preview" },
    { id: "old", summarySource: "none" },
  ];
  const scoped = scopeRecentTasks({ counts: { tasks: 3 }, tasks }, 2);

  assert.deepEqual(scoped.tasks.map((task) => task.id), ["new", "middle"]);
  assert.deepEqual(scoped.counts, {
    tasks: 2,
    withContext: 2,
    cachedSummaries: 1,
    compactSummaries: 0,
    initialPreviews: 1,
    userTurnOutlines: 0,
    titleOnly: 0,
  });
  assert.deepEqual(scoped.scope, { kind: "most_recent", limit: 2, available: 3 });
});

test("Claude importer builds bounded session evidence without assistant or tool content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-use-profile-"));
  const projects = path.join(root, "claude-projects", "project-a");
  await mkdir(projects, { recursive: true });
  const subagents = path.join(projects, "session-1", "subagents");
  await mkdir(subagents, { recursive: true });
  const sessionFile = path.join(projects, "session-1.jsonl");
  const records = [
    { type: "ai-title", sessionId: "session-1", aiTitle: "Repair the dashboard", timestamp: "2026-01-01T00:00:00Z" },
    { type: "user", sessionId: "session-1", message: { role: "user", content: "Build the chart." }, timestamp: "2026-01-01T00:00:01Z" },
    { type: "assistant", sessionId: "session-1", message: { role: "assistant", content: "ASSISTANT_SECRET" } },
    { type: "user", sessionId: "session-1", message: { role: "user", content: [{ type: "tool_result", content: "TOOL_SECRET" }] } },
    { type: "user", sessionId: "session-1", isCompactSummary: true, message: { role: "user", content: "The chart was built and needs polish." }, timestamp: "2026-01-01T00:00:02Z" },
    { type: "user", sessionId: "session-1", message: { role: "user", content: "Now tighten the bars." }, timestamp: "2026-01-01T00:00:03Z" },
  ];
  await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await writeFile(path.join(subagents, "child.jsonl"), `${JSON.stringify({ type: "user", message: { role: "user", content: "Child-agent task" } })}\n`);

  const payload = await importClaudeTasks({ projectRoot: root, projectsDirectory: path.dirname(projects) });
  assert.equal(payload.tasks.length, 1);
  assert.equal(payload.tasks[0].summarySource, "compact_summary");
  assert.match(payload.tasks[0].evidence, /Build the chart/);
  assert.match(payload.tasks[0].evidence, /Now tighten the bars/);
  assert.doesNotMatch(payload.tasks[0].evidence, /ASSISTANT_SECRET|TOOL_SECRET/);
  assert.equal(JSON.parse(await readFile(path.join(root, "runtime", "claude", "tasks.json"), "utf8")).platform, "claude");
});

test("Claude importer strips known injected UI context from human turns", () => {
  const cleaned = cleanClaudeUserText("Keep this <in-app-browser-context>private UI state</in-app-browser-context> actual request");
  assert.equal(cleaned, "Keep this actual request");
});
