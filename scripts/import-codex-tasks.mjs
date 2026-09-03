import path from "node:path";
import { fileURLToPath } from "node:url";
import { importTasks } from "../server/tasks.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const useAppServer = !process.argv.includes("--local-only");
const sourceIndex = process.argv.indexOf("--source");
const source = sourceIndex >= 0 ? process.argv[sourceIndex + 1] : "codex";
const result = await importTasks({ projectRoot: ROOT, source, useAppServer });

console.log(JSON.stringify({
  importedAt: result.importedAt,
  source: result.source,
  counts: result.counts,
  excludedIndexOnly: result.excludedIndexOnly || 0,
  warning: result.appServerError || null,
}, null, 2));
