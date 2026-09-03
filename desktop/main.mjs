import { app, BrowserWindow, dialog } from "electron";
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { startAppServer } from "../server/index.mjs";
import { sourceArgument } from "../server/integration-source.mjs";

let service = null;
let quitting = false;

async function preparePrivateWorkspace() {
  const appRoot = app.getAppPath();
  const workspaceRoot = path.join(app.getPath("userData"), "workspace");
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const resources = [".claude", ".codex", "data", "docs", "scripts", "server", "AGENTS.md", "package.json"];
  for (const resource of resources) {
    await cp(path.join(appRoot, resource), path.join(workspaceRoot, resource), {
      recursive: true,
      force: true,
    });
  }
  return { appRoot, workspaceRoot };
}

async function createWindow() {
  const { appRoot, workspaceRoot } = await preparePrivateWorkspace();
  service = await startAppServer({
    projectRoot: workspaceRoot,
    publicDir: path.join(appRoot, "public"),
    port: 0,
    source: sourceArgument(),
  });

  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 880,
    minHeight: 680,
    backgroundColor: "#11120f",
    title: "How Weird Is Your AI Use?",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (!targetUrl.startsWith(service.url)) event.preventDefault();
  });
  await window.loadURL(service.url);
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox("AI Use Profile could not start", error.message);
  app.quit();
});

app.on("window-all-closed", async () => {
  if (quitting) return;
  quitting = true;
  await service?.close().catch(() => {});
  app.quit();
});
