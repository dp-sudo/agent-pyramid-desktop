import { join } from "node:path";
import { app, BrowserWindow, safeStorage } from "electron";
import { JsonlThreadStore } from "./persistence/index.js";
import { AttachmentStore } from "./persistence/attachment-store.js";
import { ModelConfigStore } from "./persistence/model-config-store.js";
import { RuntimePreferencesStore } from "./persistence/runtime-preferences-store.js";
import { CheckpointStore } from "./persistence/checkpoint-store.js";
import { SafeStorageSecretCodec } from "./persistence/secret-codec.js";
import { RuntimeEventBus } from "./event-bus.js";
import { LlmWorkerPool } from "./infrastructure/llm-worker/worker-pool.js";
import { AgentRuntime } from "./application/agent-runtime.js";
import { createPlanTool } from "./application/tools/create-plan-tool.js";
import { createGoalTools } from "./application/tools/goal-tools.js";
import { createWorkspaceTools } from "./application/tools/workspace-tools.js";
import { createCodingTools } from "./application/tools/coding-tools.js";
import { createCommandTools } from "./application/tools/command-tools.js";
import { createSkillTools } from "./application/tools/skill-tools.js";
import { InMemoryToolRegistry } from "./application/tools/in-memory-tool-registry.js";
import { SkillService } from "./skills/skill-service.js";
import { installContentSecurityPolicy } from "./infrastructure/content-security-policy.js";
import { configureExternalNavigation } from "./infrastructure/electron-window.js";
import { McpCacheStore } from "./infrastructure/mcp/cache-store.js";
import { McpHost } from "./infrastructure/mcp/host.js";
import { configureWindowsAppIdentity } from "./application/app-identity.js";
import { registerThreadHandlers } from "./ipc/threads-handlers.js";
import { registerTurnHandlers } from "./ipc/turns-handlers.js";
import { registerSseHandlers } from "./ipc/sse-handlers.js";
import { registerApprovalHandlers } from "./ipc/approvals-handlers.js";
import { registerAttachmentHandlers } from "./ipc/attachments-handlers.js";
import { registerGoalHandlers } from "./ipc/goals-handlers.js";
import { registerUsageHandlers } from "./ipc/usage-handlers.js";
import { registerCheckpointHandlers } from "./ipc/checkpoints-handlers.js";
import { registerMcpHandlers } from "./ipc/mcp-handlers.js";
import { registerSkillHandlers } from "./ipc/skills-handlers.js";
import { registerWorkspaceHandlers } from "./ipc/workspace-handlers.js";
import { registerWriteHandlers } from "./ipc/write-handlers.js";
import { registerModelConfigHandlers } from "./ipc/model-config-handlers.js";
import { registerRuntimePreferencesHandlers } from "./ipc/runtime-preferences-handlers.js";

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const userDataDir = app.getPath("userData");
configureWindowsAppIdentity(app);
const secretCodec = new SafeStorageSecretCodec(safeStorage);
const store = new JsonlThreadStore(userDataDir);
const attachmentStore = new AttachmentStore(userDataDir);
const modelConfigStore = new ModelConfigStore(userDataDir, { secretCodec });
const runtimePreferencesStore = new RuntimePreferencesStore(userDataDir, { secretCodec });
const checkpointStore = new CheckpointStore(userDataDir);
const bus = new RuntimeEventBus();
bus.setMaxListeners(50);
const pool = new LlmWorkerPool(1, undefined, ({ index, error }) => {
  bus.emit("runtime_error", {
    kind: "runtime_error",
    code: "worker_crashed",
    message: `LLM worker ${index} crashed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  });
});
const registry = new InMemoryToolRegistry([]);
const skillService = new SkillService();
const mcpCacheStore = new McpCacheStore(userDataDir);
const mcpHost = new McpHost(registry, bus, mcpCacheStore);
const runtime = new AgentRuntime({
  store,
  attachmentStore,
  modelConfigStore,
  runtimePreferencesStore,
  checkpointStore,
  pool,
  bus,
  registry,
  skillService,
});
registry.register(createPlanTool);
for (const tool of createWorkspaceTools()) {
  registry.register(tool);
}
for (const tool of createCodingTools()) {
  registry.register(tool);
}
for (const tool of createCommandTools()) {
  registry.register(tool);
}
for (const tool of createSkillTools({ skillService })) {
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
const RENDERER_INDEX_FILE = join(__dirname, "../renderer/index.html");

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
  configureExternalNavigation(mainWindow, RENDERER_INDEX_FILE);

  if (process.env.ELECTRON_RENDERER_URL) {
    // loadURL/loadFile failures otherwise become silent white screens; route
    // them to the main log so the global handler chain can observe them.
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL).catch((error) => {
      console.error("[main] loadURL failed:", error);
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  mainWindow.loadFile(RENDERER_INDEX_FILE).catch((error) => {
    console.error("[main] loadFile failed:", error);
  });
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
    await runtimePreferencesStore.init();
    await checkpointStore.init();
    await mcpCacheStore.init();
  } catch (error) {
    console.error("[main] persistence init failed:", error);
    throw error;
  }
  try {
    await pool.start();
  } catch (error) {
    console.error("[main] worker pool start failed:", error);
    throw error;
  }
  try {
    const preferences = await runtimePreferencesStore.get();
    await mcpHost.configure(preferences.mcpServers);
    void mcpHost.connectEnabled();
  } catch (error) {
    console.error("[main] MCP host startup failed:", error);
  }

  registerThreadHandlers(store, runtime, runtimePreferencesStore);
  registerTurnHandlers(runtime, store);
  registerSseHandlers(bus);
  registerApprovalHandlers(runtime);
  registerAttachmentHandlers(attachmentStore);
  registerGoalHandlers(runtime);
  registerUsageHandlers(store);
  registerCheckpointHandlers(checkpointStore, store, runtime);
  registerMcpHandlers(mcpHost);
  registerSkillHandlers(skillService, runtimePreferencesStore);
  registerWorkspaceHandlers();
  registerWriteHandlers();
  registerModelConfigHandlers(modelConfigStore);
  registerRuntimePreferencesHandlers(runtimePreferencesStore, {
    afterUpdate: async (preferences) => {
      await mcpHost.configure(preferences.mcpServers);
      await mcpHost.connectEnabled();
    },
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  void mcpHost.close();
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
// Surface uncaught main-process failures in the log and on the runtime bus so
// the renderer can observe them instead of silently degrading.
// ---------------------------------------------------------------------------

setImmediate(() => {
  process.on("uncaughtException", (error) => {
    console.error("[main] uncaughtException:", error);
    bus.emit("runtime_error", {
      kind: "runtime_error",
      code: "internal",
      message: error instanceof Error ? error.message : String(error),
    });
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[main] unhandledRejection:", reason);
    bus.emit("runtime_error", {
      kind: "runtime_error",
      code: "internal",
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
});
