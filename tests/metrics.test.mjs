import test from "node:test";
import assert from "node:assert/strict";
import { jensenShannon, rubricProfile, taxonomyProfile } from "../server/metrics.mjs";

test("Jensen-Shannon divergence is zero for identical distributions", () => {
  assert.equal(jensenShannon([0.25, 0.75], [0.25, 0.75]), 0);
});

test("taxonomy profile calculates rarity, lift, and diversity", () => {
  const taxonomy = {
    id: "demo",
    label: "Demo",
    clusters: [
      { id: "common", name: "Common", description: "", ratio: 0.9 },
      { id: "rare", name: "Rare", description: "", ratio: 0.1 },
    ],
  };
  const profile = taxonomyProfile([
    { cluster: "rare" },
    { cluster: "rare" },
  ], taxonomy, "cluster");

  assert.equal(profile.total, 2);
  assert.equal(profile.occupiedClusters, 1);
  assert.equal(profile.effectiveClusters, 1);
  assert.ok(profile.meanRarityBits > 3);
  assert.equal(profile.topLift[0].id, "rare");
  assert.ok(profile.jsDivergenceBits > 0);
  assert.equal(profile.uniquenessScore, Math.round(profile.jsDivergenceBits * 100));
});

test("rubric coverage can exclude not-applicable evidence without hiding its distribution", () => {
  const profile = rubricProfile([
    { engagement: "not_applicable" },
    { engagement: "direct_use" },
  ], "engagement", [
    { value: "not_applicable", ratio: 0.3 },
    { value: "direct_use", ratio: 0.7 },
  ], { coverageExclude: new Set(["not_applicable"]) });

  assert.equal(profile.total, 2);
  assert.equal(profile.coverageCount, 1);
  assert.equal(profile.coverage, 0.5);
  assert.equal(profile.rows.find((row) => row.value === "not_applicable").count, 1);
});
