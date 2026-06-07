import { join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { AgentRunner } from "./application/agent-runner";
import { echoTool } from "./application/tools/echo-tool";
import { InMemoryToolRegistry } from "./application/tools/in-memory-tool-registry";
import { MiniMaxGateway } from "./infrastructure/minimax/minimax-gateway";
import { AGENT_RUN_CHANNEL } from "../shared/ipc";
import type { AgentRunRequest, AgentRunResponse } from "../shared/agent-contracts";

const runner = new AgentRunner(new MiniMaxGateway(), new InMemoryToolRegistry([echoTool]));

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f6f3ed",
    title: "Agent Pyramid Runtime",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
    return;
  }

  void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
}

ipcMain.handle(
  AGENT_RUN_CHANNEL,
  async (_event, request: AgentRunRequest): Promise<AgentRunResponse> => {
    try {
      validateRunRequest(request);
      return await runner.run(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      return {
        status: "failed",
        output: message,
        trace: [
          {
            stage: "act",
            title: "Agent run failed",
            detail: message,
            timestamp: new Date().toISOString()
          }
        ]
      };
    }
  }
);

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

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

  if (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2) {
    throw new Error("temperature must be between 0 and 2.");
  }
}
