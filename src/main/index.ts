import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, safeStorage, session, shell } from "electron";
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
import { isSamePath } from "./application/path-utils.js";

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
const pool = new LlmWorkerPool(1);
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
  configureExternalNavigation(mainWindow);

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(RENDERER_INDEX_FILE);
}

function configureExternalNavigation(window: BrowserWindow): void {
  // Renderer markdown can request new windows, but main owns the security
  // boundary: external http(s) URLs leave Electron, everything else is denied.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
  });
}

function openExternalUrl(url: string): void {
  void shell.openExternal(url).catch((error) => {
    console.error("[main] open external URL failed:", error);
  });
}

function isExternalHttpUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    if (!isInvalidUrlError(error)) throw error;
    return false;
  }
}

function isAllowedAppNavigation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (process.env.ELECTRON_RENDERER_URL) {
      const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
      return url.origin === rendererUrl.origin;
    }

    return url.protocol === "file:" && isSamePath(fileURLToPath(url), RENDERER_INDEX_FILE);
  } catch (error) {
    if (!isInvalidUrlError(error)) throw error;
    return false;
  }
}

function isInvalidUrlError(error: unknown): boolean {
  // Navigation URLs are attacker-controlled input; parse failures are expected,
  // while non-TypeError failures should stay visible to the main process.
  return error instanceof TypeError;
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
// Dev-only: surface uncaught errors in the main process log for postmortem.
// ---------------------------------------------------------------------------

setImmediate(() => {
  process.on("uncaughtException", (error) => {
    console.error("[main] uncaughtException:", error);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[main] unhandledRejection:", reason);
  });
});
