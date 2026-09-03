import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveIntegrationSource,
  sourceArgument,
  sourceFromEnvironment,
} from "../server/integration-source.mjs";

test("startup option is the integration authority", async () => {
  const result = await resolveIntegrationSource({
    requestedSource: "claude-code",
    env: { CODEX_THREAD_ID: "codex-task" },
    agentProviders: { codex: true, claude: false },
    sessionSources: { codex: true, claude: false },
  });
  assert.deepEqual(result, { source: "claude", selectedBy: "startup_option" });
});

test("launcher environment identifies Claude Code or Codex integration", () => {
  assert.deepEqual(sourceFromEnvironment({ CLAUDECODE: "1" }), {
    source: "claude",
    selectedBy: "claude_launcher",
  });
  assert.deepEqual(sourceFromEnvironment({ CODEX_THREAD_ID: "task-123" }), {
    source: "codex",
    selectedBy: "codex_launcher",
  });
});

test("explicit integration setting wins over launcher signals", () => {
  assert.deepEqual(sourceFromEnvironment({
    AI_USE_PROFILE_SOURCE: "codex",
    CLAUDECODE: "1",
  }), { source: "codex", selectedBy: "integration_config" });
});

test("a sole local agent or history source configures the app", async () => {
  assert.deepEqual(await resolveIntegrationSource({
    env: {},
    agentProviders: { codex: false, claude: true },
    sessionSources: { codex: true, claude: false },
  }), { source: "claude", selectedBy: "available_agent" });

  assert.deepEqual(await resolveIntegrationSource({
    env: {},
    agentProviders: { codex: false, claude: false },
    sessionSources: { codex: false, claude: true },
  }), { source: "claude", selectedBy: "available_history" });
});

test("source arguments support either common CLI form", () => {
  assert.equal(sourceArgument(["--source=claude"]), "claude");
  assert.equal(sourceArgument(["--source", "codex"]), "codex");
  assert.equal(sourceArgument([]), null);
});

test("invalid explicit source fails instead of silently selecting Codex", () => {
  assert.throws(() => sourceFromEnvironment({ AI_USE_PROFILE_SOURCE: "other" }), /must be one of/);
  assert.throws(() => sourceArgument(["--source=other"]), /must be one of/);
  assert.throws(() => sourceArgument(["--source"]), /requires codex or claude/);
});
