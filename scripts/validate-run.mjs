import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateRun } from "../server/validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runIndex = process.argv.indexOf("--run");
const runId = runIndex >= 0 ? process.argv[runIndex + 1] : null;
const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "codex";

if (!runId) {
  console.error("Usage: node scripts/validate-run.mjs --run <run-id> [--source codex|claude]");
  process.exit(2);
}

const result = await validateRun(ROOT, runId, source);
console.log(JSON.stringify({ ...result, classifications: undefined }, null, 2));
if (!result.valid) process.exit(1);
