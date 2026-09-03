import { readFile } from "node:fs/promises";
import path from "node:path";
import { classificationsPath, normalizeSource } from "./runtime-paths.mjs";

const LOG2 = Math.log(2);

function entropy(probabilities, base2 = false) {
  const value = -probabilities.reduce((sum, probability) => (
    probability > 0 ? sum + probability * Math.log(probability) : sum
  ), 0);
  return base2 ? value / LOG2 : value;
}

function kl(left, right) {
  return left.reduce((sum, probability, index) => (
    probability > 0 && right[index] > 0
      ? sum + probability * Math.log2(probability / right[index])
      : sum
  ), 0);
}

function jensenShannon(left, right) {
  const midpoint = left.map((value, index) => (value + right[index]) / 2);
  return 0.5 * kl(left, midpoint) + 0.5 * kl(right, midpoint);
}

function taxonomyProfile(classifications, taxonomy, field) {
  const usable = classifications.filter((record) => taxonomy.clusters.some((cluster) => cluster.id === record[field]));
  const counts = new Map();
  for (const record of usable) counts.set(record[field], (counts.get(record[field]) || 0) + 1);
  const total = usable.length;
  const userProbabilities = taxonomy.clusters.map((cluster) => total ? (counts.get(cluster.id) || 0) / total : 0);
  const rawReference = taxonomy.clusters.map((cluster) => cluster.ratio || 0);
  const referenceTotal = rawReference.reduce((sum, value) => sum + value, 0) || 1;
  const referenceProbabilities = rawReference.map((value) => value / referenceTotal);
  const userEntropy = entropy(userProbabilities);
  const referenceEntropy = entropy(referenceProbabilities);
  const smoothing = 0.5;

  const rows = taxonomy.clusters.map((cluster, index) => {
    const count = counts.get(cluster.id) || 0;
    const userRatio = userProbabilities[index];
    const smoothedUserRatio = total
      ? (count + smoothing) / (total + smoothing * taxonomy.clusters.length)
      : 0;
    const referenceRatio = referenceProbabilities[index];
    return {
      id: cluster.id,
      name: cluster.name,
      description: cluster.description,
      count,
      userRatio,
      referenceRatio,
      deltaPercentagePoints: (userRatio - referenceRatio) * 100,
      lift: referenceRatio > 0 ? smoothedUserRatio / referenceRatio : null,
      rarityBits: referenceRatio > 0 ? -Math.log2(referenceRatio) : null,
    };
  });

  const occupied = rows.filter((row) => row.count > 0);
  const meanRarityBits = total
    ? occupied.reduce((sum, row) => sum + row.count * row.rarityBits, 0) / total
    : null;
  const jsDivergenceBits = total ? jensenShannon(userProbabilities, referenceProbabilities) : null;

  return {
    id: taxonomy.id,
    label: taxonomy.label,
    total,
    possibleClusters: taxonomy.clusters.length,
    occupiedClusters: occupied.length,
    effectiveClusters: total ? Math.exp(userEntropy) : 0,
    referenceEffectiveClusters: Math.exp(referenceEntropy),
    normalizedEntropy: taxonomy.clusters.length > 1 ? userEntropy / Math.log(taxonomy.clusters.length) : 0,
    meanRarityBits,
    jsDivergenceBits,
    uniquenessScore: jsDivergenceBits == null ? null : Math.round(jsDivergenceBits * 100),
    rows: rows.sort((left, right) => right.count - left.count || right.lift - left.lift),
    topLift: occupied
      .slice()
      .sort((left, right) => right.lift - left.lift)
      .slice(0, 12),
  };
}

function rubricProfile(classifications, field, referenceRows, {
  exclude = new Set(),
  coverageExclude = new Set(),
  conditional,
} = {}) {
  const filtered = classifications.filter((record) => {
    if (!record[field] || exclude.has(record[field])) return false;
    return conditional ? conditional(record) : true;
  });
  const coverageCount = classifications.filter((record) => {
    if (!record[field] || exclude.has(record[field]) || coverageExclude.has(record[field])) return false;
    return conditional ? conditional(record) : true;
  }).length;
  const counts = new Map();
  for (const record of filtered) counts.set(record[field], (counts.get(record[field]) || 0) + 1);
  const total = filtered.length;
  const referenceTotal = referenceRows.reduce((sum, row) => sum + row.ratio, 0) || 1;

  return {
    field,
    total,
    coverageCount,
    coverage: classifications.length ? coverageCount / classifications.length : 0,
    rows: referenceRows.map((row) => {
      const value = row.value;
      const count = counts.get(value) || 0;
      const userRatio = total ? count / total : 0;
      const referenceRatio = row.ratio / referenceTotal;
      return {
        value,
        name: row.name || value.replaceAll("_", " "),
        count,
        userRatio,
        referenceRatio,
        deltaPercentagePoints: (userRatio - referenceRatio) * 100,
        lift: referenceRatio > 0 ? userRatio / referenceRatio : null,
      };
    }),
  };
}

export async function loadClassifications(projectRoot, source = "codex") {
  try {
    const lines = (await readFile(classificationsPath(projectRoot, source), "utf8"))
      .split("\n")
      .filter(Boolean);
    const byTask = new Map();
    for (const line of lines) {
      const record = JSON.parse(line);
      byTask.set(record.task_id, record);
    }
    return [...byTask.values()];
  } catch {
    return [];
  }
}

export async function computeProfile(projectRoot, tasksPayload, source = "codex") {
  const normalizedSource = normalizeSource(source);
  const reference = JSON.parse(await readFile(path.join(projectRoot, "data", "reference", "anthropic-reference.json"), "utf8"));
  const rubricDefinitions = JSON.parse(await readFile(path.join(projectRoot, "data", "reference", "rubrics.json"), "utf8"));
  const taskById = new Map((tasksPayload?.tasks || []).map((task) => [task.id, task]));
  const classifications = (await loadClassifications(projectRoot, normalizedSource))
    .filter((record) => taskById.has(record.task_id));
  const enriched = classifications.map((record) => ({ ...record, task: taskById.get(record.task_id) || null }));
  const baselines = reference.rubricBaselines;

  return {
    generatedAt: new Date().toISOString(),
    source: normalizedSource,
    reference: reference.release,
    coverage: {
      indexed: tasksPayload?.counts?.tasks || 0,
      classified: classifications.length,
      ratio: tasksPayload?.counts?.tasks ? classifications.length / tasksPayload.counts.tasks : 0,
      byEvidence: {
        withContext: enriched.filter((record) => Boolean(record.task?.summary)).length,
        cachedSummary: enriched.filter((record) => record.task?.summarySource === "cached_summary").length,
        compactSummary: enriched.filter((record) => record.task?.summarySource === "compact_summary").length,
        initialPreview: enriched.filter((record) => record.task?.summarySource === "initial_preview").length,
        userTurnOutline: enriched.filter((record) => record.task?.summarySource === "user_turn_outline").length,
        titleOnly: enriched.filter((record) => record.task?.summarySource === "none").length,
      },
    },
    taxonomies: {
      coding: taxonomyProfile(classifications, reference.taxonomies.coding, "coding_cluster_id"),
      general: taxonomyProfile(classifications, reference.taxonomies.general, "general_cluster_id"),
    },
    rubrics: {
      task_criticality: rubricProfile(classifications, "task_criticality", baselines.task_criticality),
      human_agency_level: rubricProfile(classifications, "human_agency_level", baselines.human_agency_level),
      engagement_with_output: rubricProfile(
        classifications,
        "engagement_with_output",
        baselines.engagement_with_output,
        { coverageExclude: new Set(["not_applicable"]) },
      ),
      friction_occurrence: rubricProfile(
        classifications,
        "friction_occurrence",
        baselines.friction_occurrence,
        { exclude: new Set(["unknown"]) },
      ),
      friction_quality: rubricProfile(
        classifications,
        "friction_quality",
        baselines.friction_quality_conditional,
        { conditional: (record) => record.friction_occurrence === "present" },
      ),
    },
    rubricDefinitions: rubricDefinitions.facets,
    records: enriched
      .sort((left, right) => String(right.task?.updatedAt || "").localeCompare(String(left.task?.updatedAt || "")))
      .map((record) => ({
        ...record,
        task: record.task ? {
          title: record.task.title,
          summarySource: record.task.summarySource,
          updatedAt: record.task.updatedAt,
        } : null,
      })),
  };
}

export { entropy, jensenShannon, taxonomyProfile, rubricProfile };
