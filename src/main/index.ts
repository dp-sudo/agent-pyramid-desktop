import { join } from "node:path";
import { app, BrowserWindow, session } from "electron";
import { JsonlThreadStore } from "./persistence/index.js";
import { AttachmentStore } from "./persistence/attachment-store.js";
import { ModelConfigStore } from "./persistence/model-config-store.js";
import { RuntimeEventBus } from "./event-bus.js";
import { LlmWorkerPool } from "./infrastructure/llm-worker/worker-pool.js";
import { AgentRuntime } from "./application/agent-runtime.js";
import { MiniMaxGateway } from "./infrastructure/minimax/minimax-gateway.js";
import { echoTool } from "./application/tools/echo-tool.js";
import { createPlanTool } from "./application/tools/create-plan-tool.js";
import { createGoalTools } from "./application/tools/goal-tools.js";
import { createWorkspaceTools } from "./application/tools/workspace-tools.js";
import { InMemoryToolRegistry } from "./application/tools/in-memory-tool-registry.js";
import { registerThreadHandlers } from "./ipc/threads-handlers.js";
import { registerTurnHandlers } from "./ipc/turns-handlers.js";
import { registerSseHandlers } from "./ipc/sse-handlers.js";
import { registerApprovalHandlers } from "./ipc/approvals-handlers.js";
import { registerAttachmentHandlers } from "./ipc/attachments-handlers.js";
import { registerGoalHandlers } from "./ipc/goals-handlers.js";
import { registerUsageHandlers } from "./ipc/usage-handlers.js";
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers.js";
import { registerWriteHandlers } from "./ipc/write-handlers.js";
import { registerModelConfigHandlers } from "./ipc/model-config-handlers.js";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const userDataDir = app.getPath("userData");
const store = new JsonlThreadStore(userDataDir);
const attachmentStore = new AttachmentStore(userDataDir);
const modelConfigStore = new ModelConfigStore(userDataDir);
const bus = new RuntimeEventBus();
bus.setMaxListeners(50);
const pool = new LlmWorkerPool(1);
const registry = new InMemoryToolRegistry([]);
const runtime = new AgentRuntime({
  store,
  attachmentStore,
  modelConfigStore,
  pool,
  bus,
  registry,
});
registry.register(echoTool);
registry.register(createPlanTool);
for (const tool of createWorkspaceTools()) {
  registry.register(tool);
}
for (const tool of createGoalTools({
  updateGoal: async (threadId, update) => {
    await runtime.updateThreadGoal(threadId, update);
  },
})) {
  registry.register(tool);
}

let mainWindow: BrowserWindow | null = null;
const debugErrors: unknown[] = [];

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f5f7fa",
    title: "Agent Workbench",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  installContentSecurityPolicy();

  try {
    await store.init();
    await attachmentStore.init();
    await modelConfigStore.init();
  } catch (error) {
    console.error("[main] persistence init failed:", error);
  }
  try {
    await pool.start();
  } catch (error) {
    console.error("[main] worker pool start failed:", error);
  }

  registerThreadHandlers(store, runtime);
  registerTurnHandlers(runtime, store);
  registerSseHandlers(bus);
  registerApprovalHandlers(runtime);
  registerAttachmentHandlers(attachmentStore);
  registerGoalHandlers(runtime);
  registerUsageHandlers(store);
  registerWorkspaceHandlers();
  registerWriteHandlers();
  registerModelConfigHandlers(modelConfigStore);

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function installContentSecurityPolicy(): void {
  const isDev = Boolean(process.env.ELECTRON_RENDERER_URL);
  const policy = isDev
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self' ws: http://localhost:* http://127.0.0.1:*",
      ].join("; ")
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
      ].join("; ");

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [policy],
      },
    });
  });
}

app.on("window-all-closed", () => {
  void pool.destroy().finally(() => {
    if (process.platform !== "darwin") app.quit();
  });
});

app.on("before-quit", () => {
  void pool.destroy();
});

// ---------------------------------------------------------------------------
// 3.16 Dev-only: surface uncaught errors into the index file for postmortem.
// ---------------------------------------------------------------------------

setImmediate(() => {
  process.on("uncaughtException", (error) => {
    console.error("[main] uncaughtException:", error);
    debugErrors.push({ kind: "uncaughtException", message: error.message, stack: error.stack });
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[main] unhandledRejection:", reason);
    debugErrors.push({ kind: "unhandledRejection", message: String(reason) });
  });
});

// Re-export the MiniMaxGateway only to keep tree-shaking honest when
// tools start importing MiniMax types via gateway constructors.
export { MiniMaxGateway };
