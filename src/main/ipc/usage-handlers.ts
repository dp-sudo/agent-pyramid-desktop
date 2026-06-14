import { ipcMain } from "electron";
import { USAGE_DAILY_CHANNEL } from "../../shared/ipc.js";
import { IPC_ERROR_CODES } from "../../shared/ipc-errors.js";
import type {
  RuntimeEvent,
  UsageDailyBucket,
  UsageDailyRequest,
} from "../../shared/agent-contracts.js";
import { err, ok } from "../../shared/agent-contracts.js";
import {
  DEFAULT_USAGE_DAYS,
  MAX_USAGE_DAYS,
  USAGE_CACHE_TTL_MS,
} from "../application/constants.js";
import type { JsonlThreadStore } from "../persistence/index.js";
import { messageOfIpcError as messageOf } from "./ipc-result-handler.js";

interface UsageCacheEntry {
  expiresAt: number;
  promise: Promise<UsageDailyBucket[]>;
}

const usageCache = new WeakMap<JsonlThreadStore, Map<number, UsageCacheEntry>>();

export function registerUsageHandlers(store: JsonlThreadStore): void {
  ipcMain.handle(USAGE_DAILY_CHANNEL, async (_event, request?: unknown) => {
    try {
      return ok(await collectCachedDailyUsage(store, parseUsageDailyRequest(request).days));
    } catch (error) {
      return err(IPC_ERROR_CODES.USAGE_DAILY_FAILED, messageOf(error));
    }
  });
}

// Usage aggregation defaults are intentional only for omitted requests. Bad
// renderer payloads fail at the IPC boundary so malformed state is not reported
// as a successful default-window query.
export function parseUsageDailyRequest(request: unknown): UsageDailyRequest {
  if (request === undefined) return {};
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Usage daily request must be an object.");
  }
  const days = (request as Record<string, unknown>).days;
  if (days === undefined) return {};
  if (typeof days !== "number" || !Number.isInteger(days)) {
    throw new Error("Usage daily days must be an integer.");
  }
  if (days < 1) {
    throw new Error("Usage daily days must be at least 1.");
  }
  return { days };
}

export async function collectCachedDailyUsage(
  store: JsonlThreadStore,
  daysInput: number | undefined,
): Promise<UsageDailyBucket[]> {
  const days = clampDays(daysInput);
  const now = Date.now();
  const storeCache = getUsageCacheForStore(store);
  const cached = storeCache.get(days);
  if (cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = collectDailyUsageForDays(store, days).catch((error: unknown) => {
    if (storeCache.get(days)?.promise === promise) {
      storeCache.delete(days);
    }
    throw error;
  });
  storeCache.set(days, {
    expiresAt: now + USAGE_CACHE_TTL_MS,
    promise,
  });
  return promise;
}

function getUsageCacheForStore(store: JsonlThreadStore): Map<number, UsageCacheEntry> {
  const existing = usageCache.get(store);
  if (existing) return existing;
  const next = new Map<number, UsageCacheEntry>();
  usageCache.set(store, next);
  return next;
}

export async function collectDailyUsage(
  store: JsonlThreadStore,
  daysInput: number | undefined,
): Promise<UsageDailyBucket[]> {
  return collectDailyUsageForDays(store, clampDays(daysInput));
}

async function collectDailyUsageForDays(
  store: JsonlThreadStore,
  days: number,
): Promise<UsageDailyBucket[]> {
  const start = shiftLocalDate(startOfLocalDay(Date.now()), -(days - 1));
  const buckets = new Map<string, UsageDailyBucket>();
  for (let offset = 0; offset < days; offset += 1) {
    const date = formatLocalDate(shiftLocalDate(start, offset));
    buckets.set(date, {
      date,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      cacheHitRate: null,
      turns: 0,
    });
  }

  const threads = await store.listThreads({
    include: ["primary", "fork", "side"],
    includeArchived: true,
  });
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
  bucket.cacheHitTokens += event.usage.cacheHitTokens ?? 0;
  bucket.cacheMissTokens += event.usage.cacheMissTokens ?? 0;
  const cacheTotal = bucket.cacheHitTokens + bucket.cacheMissTokens;
  bucket.cacheHitRate = cacheTotal > 0 ? bucket.cacheHitTokens / cacheTotal : null;
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

function shiftLocalDate(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
