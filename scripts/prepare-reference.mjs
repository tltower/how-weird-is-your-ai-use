import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCsv, asNumber } from "../server/csv.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = path.join(ROOT, "data", "source");
const OUTPUT_DIR = path.join(ROOT, "data", "reference");

const stanford = parseCsv(await readFile(path.join(SOURCE_DIR, "stanford_clusters.csv"), "utf8"));
const metr = parseCsv(await readFile(path.join(SOURCE_DIR, "metr_clusters.csv"), "utf8"));

function clusters(rows, facetId, level = 0) {
  return rows
    .filter((row) => row.facet_id === facetId && asNumber(row.level) === level)
    .map((row) => ({
      id: row.cluster_id,
      name: row.cluster_name,
      description: row.cluster_description,
      ratio: asNumber(row.ratio, 0),
      records: asNumber(row.num_records, 0),
      lower95: asNumber(row.ratio_95ci_lower),
      upper95: asNumber(row.ratio_95ci_upper),
    }))
    .sort((left, right) => right.ratio - left.ratio);
}

function facetReference(rows, facetId) {
  return rows
    .filter((row) => row.facet_id === facetId && asNumber(row.level) === 0)
    .map((row) => ({
      id: row.cluster_id,
      value: row.cluster_id.split(":").at(-1),
      name: row.cluster_name,
      description: row.cluster_description,
      ratio: asNumber(row.ratio, 0),
      records: asNumber(row.num_records, 0),
    }))
    .sort((left, right) => right.ratio - left.ratio);
}

const frictionQuality = facetReference(stanford, "friction_quality");
const frictionCoverage = frictionQuality.reduce((sum, row) => sum + row.ratio, 0);

const reference = {
  version: 1,
  generatedAt: new Date().toISOString(),
  release: {
    name: "Anthropic enabling-independent-research",
    datasetUrl: "https://huggingface.co/datasets/Anthropic/enabling-independent-research",
    window: "April–May 2026",
    license: "CC BY 4.0",
    sourceHashes: {
      stanford_clusters_csv: "b18fa38b6dfb43b63d981ce9d233cae71ebdca28e9c488adc4fc8b2172579a91",
      metr_clusters_csv: "69b0d3e4ae956dbdf8fe14a603c70d5871884adcb589d0e78c62700e891e01bb",
    },
  },
  taxonomies: {
    general: {
      id: "stanford_request",
      label: "Stanford mixed-use requests",
      facetId: "request",
      sample: "249,834 Claude.ai and Claude Code conversations",
      clusters: clusters(stanford, "request"),
    },
    coding: {
      id: "metr_task_description",
      label: "METR Claude Code tasks",
      facetId: "task_description",
      sample: "Claude Code conversations in the METR study",
      clusters: clusters(metr, "task_description"),
    },
  },
  rubricBaselines: {
    task_criticality: facetReference(stanford, "task_criticality"),
    human_agency_level: facetReference(stanford, "human_agency_level"),
    engagement_with_output: facetReference(stanford, "engagement_with_output"),
    friction_quality_conditional: frictionQuality.map((row) => ({
      ...row,
      ratio: frictionCoverage ? row.ratio / frictionCoverage : 0,
    })),
    friction_occurrence: [
      { value: "present", name: "Friction present", ratio: frictionCoverage },
      { value: "absent", name: "No observed friction", ratio: Math.max(0, 1 - frictionCoverage) },
    ],
  },
};

await writeFile(path.join(OUTPUT_DIR, "anthropic-reference.json"), `${JSON.stringify(reference, null, 2)}\n`);
console.log(`Prepared ${reference.taxonomies.general.clusters.length} general clusters and ${reference.taxonomies.coding.clusters.length} coding clusters.`);
