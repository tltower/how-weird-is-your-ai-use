import test from "node:test";
import assert from "node:assert/strict";
import { chooseAgentProvider, coordinatorInvocation, coordinatorPromptFile, parseCoordinatorEvent } from "../server/agent-providers.mjs";

test("Claude coordinator uses non-interactive streaming mode", async () => {
  const previous = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = "/test/claude";
  try {
    const invocation = await coordinatorInvocation("claude", "/workspace", "Classify this run");
    assert.equal(invocation.binary, "/test/claude");
    assert.deepEqual(invocation.args.slice(0, 2), ["--print", "Classify this run"]);
    assert.ok(invocation.args.includes("stream-json"));
    assert.ok(invocation.args.some((value) => value.includes("Agent")));
    assert.equal(coordinatorPromptFile("claude"), "claude-coordinator-prompt.md");
  } finally {
    if (previous == null) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous;
  }
});

test("classifier provider follows the source when available and falls back locally", () => {
  assert.equal(chooseAgentProvider("claude", { claude: true, codex: true }), "claude");
  assert.equal(chooseAgentProvider("claude", { claude: false, codex: true }), "codex");
});

test("Claude stream events expose session id and ordinary status text", () => {
  const parsed = parseCoordinatorEvent("claude", JSON.stringify({
    type: "assistant",
    session_id: "abc",
    message: { content: [{ type: "text", text: "Workers are active." }] },
  }));
  assert.deepEqual(parsed, { sessionId: "abc", message: "Workers are active." });
});
