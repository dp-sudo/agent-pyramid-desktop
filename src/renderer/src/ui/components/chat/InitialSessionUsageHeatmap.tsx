import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { UsageDailyBucket } from "../../../../../shared/agent-contracts";

const HEATMAP_DAYS = 35;
const USAGE_LOAD_DELAY_MS = 300;

export function InitialSessionUsageHeatmap(): ReactElement {
  const { t } = useTranslation();
  const [buckets, setBuckets] = useState<UsageDailyBucket[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setStatus("loading");
      void (async () => {
        try {
          const result = await window.agentApi.usage.daily({ days: HEATMAP_DAYS });
          if (cancelled) return;
          if (result.ok) {
            setBuckets(result.value);
            setStatus("ready");
          } else {
            setStatus("error");
          }
        } catch (error) {
          console.warn("[usage] failed to load daily usage:", error);
          if (!cancelled) setStatus("error");
        }
      })();
    }, USAGE_LOAD_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.totalTokens));
  const cacheHitTokens = buckets.reduce((sum, bucket) => sum + bucket.cacheHitTokens, 0);
  const cacheMissTokens = buckets.reduce((sum, bucket) => sum + bucket.cacheMissTokens, 0);
  const cacheTotal = cacheHitTokens + cacheMissTokens;
  const cacheHitRate = cacheTotal > 0 ? cacheHitTokens / cacheTotal : null;
  const cacheSummary =
    cacheHitRate === null
      ? t("usage.cacheUnavailable")
      : t("usage.cacheHitRate", { rate: formatPercent(cacheHitRate) });
  const cells =
    buckets.length > 0
      ? buckets.map((bucket) => ({
          key: bucket.date,
          title:
            bucket.cacheHitRate === null
              ? `${bucket.date}: ${bucket.totalTokens} tokens`
              : t("usage.cacheTooltip", {
                  date: bucket.date,
                  total: bucket.totalTokens,
                  rate: formatPercent(bucket.cacheHitRate),
                  hit: bucket.cacheHitTokens,
                  cacheTotal: bucket.cacheHitTokens + bucket.cacheMissTokens,
                }),
          opacity: 0.18 + 0.82 * (bucket.totalTokens / maxTotal),
        }))
      : Array.from({ length: HEATMAP_DAYS }, (_, index) => ({
          key: `placeholder-${index}`,
          title: t("usage.loading"),
          opacity: 0.18,
        }));

  return (
    <div className="ds-empty-session">
      <div className="ds-empty-session-title">{t("empty.title")}</div>
      <div className="ds-empty-session-subtitle">{t("empty.subtitle")}</div>
      <div className="ds-usage-heatmap" role="img" aria-label={t("usage.heatmap")}>
        {cells.map((cell) => (
          <div
            key={cell.key}
            className="ds-usage-cell"
            aria-hidden="true"
            title={cell.title}
            style={{ opacity: cell.opacity }}
          />
        ))}
      </div>
      {status === "ready" ? <div className="ds-usage-cache">{cacheSummary}</div> : null}
      {status === "error" ? (
        <div className="ds-usage-status" role="status">
          {t("usage.unavailable")}
        </div>
      ) : null}
      <div className="ds-usage-legend">
        <span>{t("usage.less")}</span>
        <span>{t("usage.more")}</span>
      </div>
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
