import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runDirectory } from "./runtime-paths.mjs";

const ENUMS = {
  task_criticality: new Set(["ephemeral", "operational", "consequential", "high_stakes", "not_applicable"]),
  human_agency_level: new Set(["ai_handles_alone", "minimal_human_input", "equal_partnership", "human_leads_ai_assists", "complete_human_involvement", "not_applicable"]),
  engagement_with_output: new Set(["direct_use", "understand", "adapt", "critique", "reject", "not_applicable"]),
  friction_occurrence: new Set(["present", "absent", "unknown"]),
  friction_quality: new Set(["productive", "unproductive", "mixed", "not_applicable"]),
  cluster_confidence: new Set(["low", "medium", "high"]),
  rubric_confidence: new Set(["low", "medium", "high"]),
};

export async function validateRun(projectRoot, runId, source = "codex") {
  const runDir = runDirectory(projectRoot, source, runId);
  const reference = JSON.parse(await readFile(path.join(projectRoot, "data", "reference", "anthropic-reference.json"), "utf8"));
  const generalIds = new Set(reference.taxonomies.general.clusters.map((cluster) => cluster.id));
  const codingIds = new Set(reference.taxonomies.coding.clusters.map((cluster) => cluster.id));
  const manifest = JSON.parse(await readFile(path.join(runDir, "manifest.json"), "utf8"));
  const expected = new Set(manifest.taskIds);
  const seen = new Set();
  const classifications = [];
  const errors = [];

  const files = (await readdir(path.join(runDir, "shards")))
    .filter((file) => file.endsWith("-output.json"))
    .sort();

  for (const file of files) {
    let payload;
    try {
      payload = JSON.parse(await readFile(path.join(runDir, "shards", file), "utf8"));
    } catch (error) {
      errors.push(`${file}: invalid JSON (${error.message})`);
      continue;
    }
    if (!Array.isArray(payload.classifications)) {
      errors.push(`${file}: classifications must be an array`);
      continue;
    }

    for (const record of payload.classifications) {
      const prefix = `${file}:${record?.task_id || "missing-task-id"}`;
      if (!expected.has(record?.task_id)) errors.push(`${prefix}: task_id is not in the run manifest`);
      if (seen.has(record?.task_id)) errors.push(`${prefix}: duplicate task_id`);
      seen.add(record?.task_id);
      if (!generalIds.has(record?.general_cluster_id)) errors.push(`${prefix}: unknown general_cluster_id`);
      if (!codingIds.has(record?.coding_cluster_id)) errors.push(`${prefix}: unknown coding_cluster_id`);
      for (const [field, allowed] of Object.entries(ENUMS)) {
        if (!allowed.has(record?.[field])) errors.push(`${prefix}: invalid ${field}`);
      }
      if (record?.friction_occurrence === "present" && record?.friction_quality === "not_applicable") {
        errors.push(`${prefix}: present friction requires a quality label`);
      }
      if (record?.friction_occurrence !== "present" && record?.friction_quality !== "not_applicable") {
        errors.push(`${prefix}: absent or unknown friction requires not_applicable quality`);
      }
      if (typeof record?.rationale !== "string" || !record.rationale.trim() || record.rationale.length > 400) {
        errors.push(`${prefix}: rationale must contain 1–400 characters`);
      }
      classifications.push(record);
    }
  }

  for (const taskId of expected) {
    if (!seen.has(taskId)) errors.push(`missing classification for ${taskId}`);
  }

  return {
    valid: errors.length === 0,
    expected: expected.size,
    received: classifications.length,
    outputFiles: files.length,
    errors,
    classifications,
  };
}
