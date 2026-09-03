import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { classifierDescriptor, coordinatorInvocation, coordinatorPromptFile, parseCoordinatorEvent } from "./agent-providers.mjs";
import { buildSearchIndex, retrieveCandidates } from "./retrieval.mjs";
import { CodexAppServer } from "./codex-app-server.mjs";
import { loadClassifications } from "./metrics.mjs";
import { classificationsPath, normalizeSource, runDirectory, sourceLabel } from "./runtime-paths.mjs";
import { validateRun } from "./validation.mjs";

function splitIntoShards(records) {
  if (records.length <= 12) {
    const shardCount = Math.min(3, records.length);
    const size = Math.ceil(records.length / shardCount);
    return Array.from({ length: shardCount }, (_, index) => records.slice(index * size, (index + 1) * size)).filter((shard) => shard.length);
  }
  const size = 24;
  const shards = [];
  for (let index = 0; index < records.length; index += size) shards.push(records.slice(index, index + size));
  return shards;
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function coordinatorStatus(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  // Codex JSON event streams can include patch/JSON payload fragments. Keep the
  // dashboard status line to ordinary coordinator prose only.
  if (/^(?:[+\-]\s*)?[{[]/.test(value) || /"task_id"\s*:/.test(value) || value.startsWith("```")) return null;
  return value.slice(0, 240);
}

export class AnalysisRunner extends EventEmitter {
  constructor(projectRoot) {
    super();
    this.projectRoot = projectRoot;
    this.jobs = new Map();
    this.activeJobId = null;
  }

  listJobs() {
    return [...this.jobs.values()].map((job) => this.publicJob(job));
  }

  getActiveJob() {
    return this.activeJobId ? this.publicJob(this.jobs.get(this.activeJobId)) : null;
  }

  publicJob(job) {
    if (!job) return null;
    const { process: _process, ...safe } = job;
    return safe;
  }

  async createJob(tasksPayload, { limit = 12, taskIds = null, source = "codex", agentProvider = source } = {}) {
    if (this.activeJobId) throw new Error("An analysis run is already active.");
    const normalizedSource = normalizeSource(source);
    const normalizedProvider = normalizeSource(agentProvider);
    const existing = new Set((await loadClassifications(this.projectRoot, normalizedSource)).map((record) => record.task_id));
    let records = tasksPayload.tasks.filter((task) => !existing.has(task.id));
    if (Array.isArray(taskIds) && taskIds.length) {
      const selected = new Set(taskIds);
      records = tasksPayload.tasks.filter((task) => selected.has(task.id));
    } else if (limit !== "all") {
      const numericLimit = Math.max(1, Math.min(Number(limit) || 12, 240));
      records = records.slice(0, numericLimit);
    }
    if (!records.length) throw new Error("No unclassified tasks match this run.");

    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const runDir = runDirectory(this.projectRoot, normalizedSource, runId);
    const shardDir = path.join(runDir, "shards");
    await mkdir(shardDir, { recursive: true });

    const reference = JSON.parse(await readFile(path.join(this.projectRoot, "data", "reference", "anthropic-reference.json"), "utf8"));
    const generalIndex = buildSearchIndex(reference.taxonomies.general.clusters);
    const codingIndex = buildSearchIndex(reference.taxonomies.coding.clusters);
    const shards = splitIntoShards(records);
    const shardManifest = [];

    for (let index = 0; index < shards.length; index += 1) {
      const id = `shard-${String(index + 1).padStart(3, "0")}`;
      const inputName = `${id}-input.json`;
      const outputName = `${id}-output.json`;
      const inputPath = path.join(shardDir, inputName);
      const outputPath = path.join(shardDir, outputName);
      const payload = {
        runId,
        shardId: id,
        outputPath: path.relative(this.projectRoot, outputPath),
        records: shards[index].map((task) => ({
          id: task.id,
          title: task.title,
          summary: task.summary,
          summarySource: task.summarySource,
          evidence: task.evidence,
          generalCandidates: retrieveCandidates(generalIndex, task.evidence),
          codingCandidates: retrieveCandidates(codingIndex, task.evidence),
        })),
      };
      await writeJsonAtomic(inputPath, payload);
      shardManifest.push({
        id,
        count: payload.records.length,
        inputPath: path.relative(this.projectRoot, inputPath),
        outputPath: path.relative(this.projectRoot, outputPath),
      });
    }

    const manifest = {
      version: 1,
      runId,
      createdAt: new Date().toISOString(),
      source: normalizedSource,
      agentProvider: normalizedProvider,
      classifier: classifierDescriptor(normalizedProvider),
      taskIds: records.map((record) => record.id),
      totalTasks: records.length,
      shards: shardManifest,
    };
    await writeJsonAtomic(path.join(runDir, "manifest.json"), manifest);

    const job = {
      id: runId,
      source: normalizedSource,
      sourceLabel: sourceLabel(normalizedSource),
      agentProvider: normalizedProvider,
      agentProviderLabel: sourceLabel(normalizedProvider),
      status: "starting",
      phase: `Preparing ${sourceLabel(normalizedProvider)} coordinator`,
      createdAt: manifest.createdAt,
      startedAt: null,
      completedAt: null,
      totalTasks: records.length,
      totalShards: shards.length,
      activeWorkers: 0,
      completedWorkers: 0,
      outputRecords: 0,
      lastMessage: "Run files prepared.",
      errors: [],
      codexThreadId: null,
      coordinatorSessionId: null,
      process: null,
    };
    this.jobs.set(runId, job);
    this.activeJobId = runId;
    void this.start(job).catch((error) => this.failStart(job, error));
    return this.publicJob(job);
  }

  async failStart(job, error) {
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.phase = "Needs attention";
    job.errors.push(error.message);
    job.completedAt = new Date().toISOString();
    job.process = null;
    if (this.activeJobId === job.id) this.activeJobId = null;
    await this.archiveCoordinator(job);
    this.emit("job", this.publicJob(job));
  }

  async start(job) {
    const promptTemplate = await readFile(path.join(this.projectRoot, "docs", coordinatorPromptFile(job.agentProvider)), "utf8");
    const runRelativePath = path.relative(this.projectRoot, runDirectory(this.projectRoot, job.source, job.id));
    const prompt = promptTemplate
      .replaceAll("{{RUN_ID}}", job.id)
      .replaceAll("{{RUN_RELATIVE_PATH}}", runRelativePath);
    const { binary, args } = await coordinatorInvocation(job.agentProvider, this.projectRoot, prompt);

    job.process = spawn(binary, args, {
      cwd: this.projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    job.status = "running";
    job.phase = "Coordinator active";
    job.startedAt = new Date().toISOString();
    this.emit("job", this.publicJob(job));

    const progressTimer = setInterval(async () => {
      try {
        const files = await readdir(path.join(runDirectory(this.projectRoot, job.source, job.id), "shards"));
        job.completedWorkers = files.filter((file) => file.endsWith("-output.json")).length;
        if (job.completedWorkers > 0) job.phase = "Classifier subagents active";
        this.emit("job", this.publicJob(job));
      } catch {
        // The exit-time validator provides the authoritative result.
      }
    }, 1200);

    const reader = readline.createInterface({ input: job.process.stdout });
    reader.on("line", (line) => {
      const event = parseCoordinatorEvent(job.agentProvider, line);
      if (!event) return;
      if (event.sessionId) {
        job.coordinatorSessionId = event.sessionId;
        if (job.agentProvider === "codex") job.codexThreadId = event.sessionId;
      }
      if (event.workerStarted) {
        job.activeWorkers += 1;
        job.phase = "Classifier subagents active";
      }
      if (event.workerDispatched) job.lastMessage = "A classifier worker was dispatched.";
      if (event.workerUpdate) job.lastMessage = "Coordinator received a worker update.";
      if (event.message) {
        const message = coordinatorStatus(event.message);
        if (message) job.lastMessage = message;
      }
      this.emit("job", this.publicJob(job));
    });

    job.process.stderr.setEncoding("utf8");
    job.process.stderr.on("data", (chunk) => {
      const safe = String(chunk).split("\n").filter(Boolean).at(-1);
      if (safe) job.lastMessage = safe.slice(0, 240);
    });

    let settled = false;
    const finish = async (code, signal, processError = null) => {
      if (settled) return;
      settled = true;
      try {
        if (job.status === "cancelled") return;
        if (processError) throw processError;
        if (code !== 0) throw new Error(`${sourceLabel(job.agentProvider)} coordinator exited with ${code ?? signal}.`);
        job.phase = "Validating classifications";
        const validation = await validateRun(this.projectRoot, job.id, job.source);
        if (!validation.valid) {
          job.errors = validation.errors.slice(0, 30);
          throw new Error(`Validation failed with ${validation.errors.length} error(s).`);
        }
        await this.merge(job.source, job.id, validation.classifications);
        job.status = "completed";
        job.phase = "Complete";
        job.outputRecords = validation.classifications.length;
        job.completedWorkers = validation.outputFiles;
        job.lastMessage = `${validation.classifications.length} classifications validated and saved.`;
      } catch (error) {
        job.status = "failed";
        job.phase = "Needs attention";
        job.errors.push(error.message);
      } finally {
        clearInterval(progressTimer);
        job.completedAt = new Date().toISOString();
        job.process = null;
        this.activeJobId = null;
        await this.archiveCoordinator(job);
        this.emit("job", this.publicJob(job));
      }
    };
    job.process.once("error", (error) => void finish(null, null, error));
    job.process.once("exit", (code, signal) => void finish(code, signal));
  }

  async archiveCoordinator(job) {
    if (job.agentProvider !== "codex" || !job.codexThreadId) return;
    const client = new CodexAppServer();
    try {
      await client.start();
      await client.request("thread/archive", { threadId: job.codexThreadId }, 30_000);
    } catch (error) {
      job.errors.push(`Could not archive coordinator task: ${error.message}`);
    } finally {
      await client.close();
    }
  }

  async merge(source, runId, records) {
    const target = classificationsPath(this.projectRoot, source);
    await mkdir(path.dirname(target), { recursive: true });
    const existing = await loadClassifications(this.projectRoot, source);
    const merged = new Map(existing.map((record) => [record.task_id, record]));
    const classifiedAt = new Date().toISOString();
    for (const record of records) merged.set(record.task_id, { ...record, run_id: runId, classified_at: classifiedAt });
    const contents = [...merged.values()].map((record) => JSON.stringify(record)).join("\n");
    const temporary = `${target}.tmp`;
    await writeFile(temporary, `${contents}${contents ? "\n" : ""}`, { mode: 0o600 });
    await rename(temporary, target);
  }

  cancel() {
    if (!this.activeJobId) return null;
    const job = this.jobs.get(this.activeJobId);
    job.status = "cancelled";
    job.phase = "Cancelled";
    job.completedAt = new Date().toISOString();
    job.lastMessage = `The local ${sourceLabel(job.agentProvider)} coordinator was stopped.`;
    job.process?.kill("SIGTERM");
    job.process = null;
    this.activeJobId = null;
    this.emit("job", this.publicJob(job));
    return this.publicJob(job);
  }
}
