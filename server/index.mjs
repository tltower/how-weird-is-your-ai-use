import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisRunner } from "./analysis-runner.mjs";
import { chooseAgentProvider, detectAgentProviders } from "./agent-providers.mjs";
import { computeProfile } from "./metrics.mjs";
import { normalizeSource, sourceLabel } from "./runtime-paths.mjs";
import { importTasks, loadTasks, scopeRecentTasks } from "./tasks.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(MODULE_PATH), "..");
const DEFAULT_PUBLIC_DIR = path.join(DEFAULT_ROOT, "public");
const DEFAULT_PORT = Number(process.env.AI_USE_PROFILE_PORT || 4178);
const RECENT_COHORT_SIZE = Number(process.env.AI_USE_PROFILE_SESSION_LIMIT || 250);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": MIME_TYPES[".json"] });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function taskImportView(allTasks, tasks) {
  return {
    importedAt: allTasks.importedAt,
    source: allTasks.source,
    platform: allTasks.platform,
    counts: allTasks.counts,
    excludedIndexOnly: allTasks.excludedIndexOnly || 0,
    cohort: { ...tasks.scope, counts: tasks.counts },
    warning: allTasks.appServerError
      || (allTasks.failedFiles ? `${allTasks.failedFiles} Claude session files could not be read.` : null),
  };
}

export async function startAppServer({
  projectRoot = DEFAULT_ROOT,
  publicDir = DEFAULT_PUBLIC_DIR,
  port = DEFAULT_PORT,
  host = "127.0.0.1",
} = {}) {
  const runner = new AnalysisRunner(projectRoot);

  async function bootstrap(source) {
    const normalizedSource = normalizeSource(source);
    const allTasks = await loadTasks(projectRoot, normalizedSource);
    const tasks = scopeRecentTasks(allTasks, RECENT_COHORT_SIZE);
    const profile = await computeProfile(projectRoot, tasks, normalizedSource);
    const agentProviders = await detectAgentProviders();
    const agentProvider = chooseAgentProvider(normalizedSource, agentProviders);
    return {
      status: "ready",
      source: normalizedSource,
      sourceLabel: sourceLabel(normalizedSource),
      agentProviders,
      agentProvider,
      agentProviderLabel: sourceLabel(agentProvider),
      taskImport: taskImportView(allTasks, tasks),
      profile,
      activeJob: runner.getActiveJob(),
      jobs: runner.listJobs().slice(-5).reverse(),
    };
  }

  async function serveStatic(requestUrl, response) {
    const relative = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const candidate = path.resolve(publicDir, relative);
    if (!candidate.startsWith(`${publicDir}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const metadata = await stat(candidate);
      if (!metadata.isFile()) throw new Error("Not a file");
      const body = await readFile(candidate);
      response.writeHead(200, {
        "content-type": MIME_TYPES[path.extname(candidate)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end("Not found");
    }
  }

  const server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && requestUrl.pathname === "/api/bootstrap") {
        sendJson(response, 200, await bootstrap(requestUrl.searchParams.get("source")));
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/tasks/refresh") {
        const body = await readJsonBody(request);
        const source = normalizeSource(body.source);
        const allTasks = await importTasks({ projectRoot, source, useAppServer: source === "codex" });
        const tasks = scopeRecentTasks(allTasks, RECENT_COHORT_SIZE);
        sendJson(response, 200, { source, taskImport: taskImportView(allTasks, tasks) });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/analyze") {
        const body = await readJsonBody(request);
        const source = normalizeSource(body.source);
        const agentProviders = await detectAgentProviders();
        const agentProvider = body.agentProvider
          ? normalizeSource(body.agentProvider)
          : chooseAgentProvider(source, agentProviders);
        if (!agentProviders[agentProvider]) {
          throw new Error(`No signed-in local ${sourceLabel(agentProvider)} CLI was found.`);
        }
        const tasks = scopeRecentTasks(await loadTasks(projectRoot, source), RECENT_COHORT_SIZE);
        const job = await runner.createJob(tasks, {
          source,
          agentProvider,
          limit: body.limit ?? 12,
          taskIds: body.taskIds ?? null,
        });
        sendJson(response, 202, { job });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/api/job/cancel") {
        const job = runner.cancel();
        sendJson(response, job ? 200 : 409, job ? { job } : { error: "No active job." });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/job") {
        sendJson(response, 200, { activeJob: runner.getActiveJob(), jobs: runner.listJobs().slice(-5).reverse() });
        return;
      }
      await serveStatic(requestUrl, response);
    } catch (error) {
      sendJson(response, 500, { error: error.message || "Unexpected error" });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const resolvedPort = typeof address === "object" && address ? address.port : port;
  return {
    server,
    runner,
    url: `http://${host}:${resolvedPort}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === MODULE_PATH) {
  const instance = await startAppServer();
  console.log(`AI Use Profile ready at ${instance.url}`);
}
