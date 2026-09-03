import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchIndex, retrieveCandidates } from "../server/retrieval.mjs";

test("retrieval ranks task-relevant cluster descriptions", () => {
  const index = buildSearchIndex([
    { id: "a", name: "Debug database migrations", description: "Fix SQL schema and migration failures", ratio: 0.2 },
    { id: "b", name: "Write marketing copy", description: "Create promotional landing page prose", ratio: 0.4 },
    { id: "c", name: "Plan travel", description: "Build itineraries and compare destinations", ratio: 0.4 },
  ]);

  const [first] = retrieveCandidates(index, "Diagnose the failed SQLite schema migration", 2);
  assert.equal(first.id, "a");
});
