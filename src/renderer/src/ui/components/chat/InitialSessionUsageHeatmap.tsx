import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { UsageDailyBucket } from "../../../../../shared/agent-contracts";

export function InitialSessionUsageHeatmap(): ReactElement {
  const { t } = useTranslation();
  const [buckets, setBuckets] = useState<UsageDailyBucket[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await window.agentApi.usage.daily({ days: 35 });
      if (!cancelled && result.ok) {
        setBuckets(result.value);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const maxTotal = Math.max(1, ...buckets.map((bucket) => bucket.totalTokens));
  return (
    <div className="ds-empty-session">
      <div className="ds-empty-session-title">{t("empty.title")}</div>
      <div className="ds-empty-session-subtitle">{t("empty.subtitle")}</div>
      <div className="ds-usage-heatmap" aria-label={t("usage.heatmap")}>
        {buckets.map((bucket) => (
          <div
            key={bucket.date}
            className="ds-usage-cell"
            title={`${bucket.date}: ${bucket.totalTokens} tokens`}
            style={{ opacity: 0.18 + 0.82 * (bucket.totalTokens / maxTotal) }}
          />
        ))}
      </div>
      <div className="ds-usage-legend">
        <span>{t("usage.less")}</span>
        <span>{t("usage.more")}</span>
      </div>
    </div>
  );
}
