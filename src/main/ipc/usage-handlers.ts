import { ipcMain } from "electron";
import { USAGE_DAILY_CHANNEL } from "../../shared/ipc.js";
import type {
  RuntimeEvent,
  UsageDailyBucket,
  UsageDailyRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import type { JsonlThreadStore } from "../persistence/index.js";

const DEFAULT_USAGE_DAYS = 30;
const MAX_USAGE_DAYS = 180;

export function registerUsageHandlers(store: JsonlThreadStore): void {
  ipcMain.handle(USAGE_DAILY_CHANNEL, async (_event, request?: UsageDailyRequest) => {
    try {
      return ok(await collectDailyUsage(store, request?.days));
    } catch (error) {
      return err("USAGE_DAILY_FAILED", messageOf(error));
    }
  });
}

async function collectDailyUsage(
  store: JsonlThreadStore,
  daysInput: number | undefined,
): Promise<UsageDailyBucket[]> {
  const days = clampDays(daysInput);
  const start = startOfLocalDay(Date.now() - (days - 1) * 24 * 60 * 60 * 1000);
  const buckets = new Map<string, UsageDailyBucket>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = formatLocalDate(start + offset * 24 * 60 * 60 * 1000);
    buckets.set(date, {
      date,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      turns: 0,
    });
  }

  const threads = await store.listThreads({ include: ["primary", "fork", "side"] });
  for (const thread of threads) {
    for await (const event of store.replayEvents(thread.id)) {
      addUsageEvent(buckets, event);
    }
  }
  return [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function addUsageEvent(buckets: Map<string, UsageDailyBucket>, event: RuntimeEvent): void {
  if (event.kind !== "turn_completed" || !event.usage) return;
  const date = formatLocalDate(Date.parse(event.completedAt));
  const bucket = buckets.get(date);
  if (!bucket) return;
  bucket.inputTokens += event.usage.inputTokens ?? 0;
  bucket.outputTokens += event.usage.outputTokens ?? 0;
  bucket.totalTokens += event.usage.totalTokens ?? 0;
  bucket.turns += 1;
}

function clampDays(value: unknown): number {
  if (!Number.isInteger(value)) return DEFAULT_USAGE_DAYS;
  return Math.min(MAX_USAGE_DAYS, Math.max(1, Number(value)));
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
