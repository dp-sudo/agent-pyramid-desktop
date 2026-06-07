import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { JsonlThreadStore } from "./persistence/index.js";
import { RuntimeEventBus } from "./event-bus.js";
import { LlmWorkerPool } from "./infrastructure/llm-worker/worker-pool.js";
import { AgentRuntime } from "./application/agent-runtime.js";
import { LegacyRunAdapter } from "./application/legacy-run-adapter.js";
import { MiniMaxGateway } from "./infrastructure/minimax/minimax-gateway.js";
import { echoTool } from "./application/tools/echo-tool.js";
import { InMemoryToolRegistry } from "./application/tools/in-memory-tool-registry.js";
import { registerThreadHandlers } from "./ipc/threads-handlers.js";
import { registerTurnHandlers } from "./ipc/turns-handlers.js";
import { registerSseHandlers } from "./ipc/sse-handlers.js";
import { registerApprovalHandlers } from "./ipc/approvals-handlers.js";
import { registerWriteHandlers } from "./ipc/write-handlers.js";
import { AGENT_RUN_CHANNEL } from "../shared/ipc.js";
import type {
  AgentRunRequest,
  AgentRunResponse,
  IpcResult,
} from "../shared/agent-contracts.js";
import { ok, err } from "../shared/agent-contracts.js";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const userDataDir = app.getPath("userData");
const store = new JsonlThreadStore(userDataDir);
const bus = new RuntimeEventBus();
bus.setMaxListeners(50);
const pool = new LlmWorkerPool(1);
const registry = new InMemoryToolRegistry([echoTool]);
const runtime = new AgentRuntime({ store, pool, bus, registry });
const legacy = new LegacyRunAdapter(runtime, store, bus, pool);

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
      preload: join(__dirname, "../preload/index.mjs"),
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
  try {
    await store.init();
  } catch (error) {
    console.error("[main] store init failed:", error);
  }
  try {
    await pool.start();
  } catch (error) {
    console.error("[main] worker pool start failed:", error);
  }

  registerThreadHandlers(store);
  registerTurnHandlers(runtime, store);
  registerSseHandlers(bus);
  registerApprovalHandlers(runtime);
  registerWriteHandlers();

  ipcMain.handle(AGENT_RUN_CHANNEL, async (_event, request: AgentRunRequest) => {
    try {
      validateRunRequest(request);
      const result = await legacy.runOnce(request);
      return ok(result) satisfies IpcOk;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err("AGENT_RUN_FAILED", message) satisfies IpcResult<AgentRunResponse>;
    }
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface IpcOk {
  ok: true;
  value: AgentRunResponse;
}

function validateRunRequest(request: AgentRunRequest): void {
  if (!request.goal.trim()) {
    throw new Error("Task goal is required.");
  }
  if (!request.apiKey.trim()) {
    throw new Error("MiniMax API key is required.");
  }
  if (!request.model.trim()) {
    throw new Error("Model is required.");
  }
  if (!Number.isFinite(request.maxTokens) || request.maxTokens < 1) {
    throw new Error("maxTokens must be greater than 0.");
  }
  if (
    !Number.isFinite(request.temperature) ||
    request.temperature < 0 ||
    request.temperature > 2
  ) {
    throw new Error("temperature must be between 0 and 2.");
  }
}

// Re-export the MiniMaxGateway only to keep tree-shaking honest when
// tools start importing MiniMax types via gateway constructors.
export { MiniMaxGateway };
