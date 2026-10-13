export interface UsageWindow {
  used_percent: number | null;
  remaining_percent: number | null;
  window_minutes: number | null;
  resets_at: number | null;
}
export interface HarnessUsage {
  available: boolean;
  harness: string;
  source: string;
  observed_at: string;
  reason?: string;
  ordinary_usage_allowed?: boolean | null;
  limits?: Array<{
    id: string | null;
    name: string | null;
    plan: string | null;
    primary: UsageWindow | null;
    secondary: UsageWindow | null;
    individual: UsageWindow | null;
    credits: {
      has_credits: boolean | null;
      unlimited: boolean | null;
      balance: string | null;
      unit: 'credits';
      currency: null;
    } | null;
    spend_control_reached: boolean | null;
    reached_type: string | null;
  }>;
}
const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const string = (v: unknown) => (typeof v === 'string' ? v : null);
const boolean = (v: unknown) => (typeof v === 'boolean' ? v : null);
function window(v: any): UsageWindow | null {
  if (!v || typeof v !== 'object') return null;
  const used = number(v.usedPercent);
  return {
    used_percent: used,
    remaining_percent: used === null ? null : Math.max(0, Math.min(100, 100 - used)),
    window_minutes: number(v.windowDurationMins),
    resets_at: number(v.resetsAt),
  };
}
// Select only usage fields. Account IDs, login tokens and reset-credit IDs are
// intentionally absent; this endpoint cannot spend credits or consume resets.
export function codexUsage(raw: any, observedAt = new Date().toISOString()): HarnessUsage {
  const multi = raw?.rateLimitsByLimitId;
  const buckets: Array<[string | null, any]> =
    multi && typeof multi === 'object' && Object.keys(multi).length
      ? Object.entries(multi)
      : raw?.rateLimits
        ? [[null, raw.rateLimits]]
        : [];
  return {
    available: buckets.length > 0,
    harness: 'codex',
    source: 'account/rateLimits/read',
    observed_at: observedAt,
    ordinary_usage_allowed: boolean(raw?.ordinaryUsageAllowed),
    ...(buckets.length ? {} : { reason: 'The account service returned no usage-limit metrics.' }),
    limits: buckets.map(([key, v]) => ({
      id: string(v?.limitId) ?? key,
      name: string(v?.limitName),
      plan: string(v?.planType),
      primary: window(v?.primary),
      secondary: window(v?.secondary),
      individual: window(v?.individualLimit),
      credits: v?.credits
        ? {
            has_credits: boolean(v.credits.hasCredits),
            unlimited: boolean(v.credits.unlimited),
            balance: string(v.credits.balance),
            unit: 'credits',
            currency: null,
          }
        : null,
      spend_control_reached: boolean(v?.spendControlReached),
      reached_type: string(v?.rateLimitReachedType),
    })),
  };
}
