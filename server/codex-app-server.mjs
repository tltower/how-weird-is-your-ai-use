import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import readline from "node:readline";

const DESKTOP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

async function resolveCodexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  try {
    await access(DESKTOP_CODEX);
    return DESKTOP_CODEX;
  } catch {
    return "codex";
  }
}

export class CodexAppServer {
  constructor() {
    this.child = null;
    this.lineReader = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = [];
  }

  async start() {
    if (this.child) return;
    const binary = await resolveCodexBinary();
    this.child = spawn(binary, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr.push(chunk);
      if (this.stderr.length > 20) this.stderr.shift();
    });

    this.child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"}). ${this.stderr.join("").trim()}`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.child = null;
    });

    this.lineReader = readline.createInterface({ input: this.child.stdout });
    this.lineReader.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id == null || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "ai_use_profile",
        title: "How Weird Is Your AI Use?",
        version: "0.1.0",
      },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running."));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method, params = {}) {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async listProfileableThreads() {
    const records = new Map();
    for (const archived of [false, true]) {
      let cursor = null;
      do {
        const result = await this.request("thread/list", {
          cursor,
          limit: 100,
          sortKey: "updated_at",
          sortDirection: "desc",
          archived,
          sourceKinds: ["cli", "vscode", "appServer", "unknown"],
        }, 60_000);
        for (const record of result?.data || []) records.set(record.id, record);
        cursor = result?.nextCursor || null;
      } while (cursor);
    }
    return [...records.values()];
  }

  async close() {
    if (!this.child) return;
    this.lineReader?.close();
    this.child.kill("SIGTERM");
    this.child = null;
  }
}

export { resolveCodexBinary };
