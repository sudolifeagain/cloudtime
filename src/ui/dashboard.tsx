import { DataTable, EmptyState, MetricCard, Notice, Panel, ProgressRow } from "./components";
import { RankedBarChart, VerticalBarChart, type ChartDatum } from "./charts";
import type { EmbedSettings } from "../utils/embed-settings";
import type { components } from "../types/generated";
import { detectUnattributedTools, type AttributionStatus } from "../utils/ai/attribution";

export type AiUsageSummary = components["schemas"]["AIUsageSummary"];
export type AiTokenTotals = components["schemas"]["AITokenTotals"];

export type ProviderLink = {
  provider: string;
  username: string | null;
  email: string | null;
};

export type ProjectSummary = {
  name: string;
  totalSeconds: number;
  lastHeartbeatAt: number | null;
};

export type CategorySummary = {
  name: string;
  totalSeconds: number;
};

export type DailySummary = {
  date: string;
  totalSeconds: number;
};

export type AiProjectSummary = {
  name: string;
  heartbeatCount: number;
  lastHeartbeatAt: number | null;
};

export type RecentHeartbeat = {
  entity: string;
  type: string;
  time: number;
  project: string | null;
  language: string | null;
  category: string | null;
  editor: string | null;
  machine: string | null;
  isWrite: boolean;
};

export type AiCodingOverview = {
  totalHeartbeats: number;
  lastHeartbeatAt: number | null;
  projects: AiProjectSummary[];
  recentHeartbeats: RecentHeartbeat[];
  /** Token/cost summary from the `ai_daily_usage` rollup over the trailing window. */
  usage: AiUsageSummary;
};

export type DashboardData = {
  user: {
    username: string;
    displayName: string | null;
    email: string | null;
    timezone: string;
    timeout: number;
  };
  today: {
    date: string;
    totalSeconds: number;
  };
  last30DaysSeconds: number;
  allTimeSeconds: number;
  heartbeatCount: number;
  aiCoding: AiCodingOverview;
  activeSessionCount: number;
  machineCount: number;
  userAgentCount: number;
  apiBaseUrl: string;
  embedSettings: EmbedSettings;
  providers: ProviderLink[];
  dailySummaries: DailySummary[];
  projects: ProjectSummary[];
  categories: CategorySummary[];
  recentHeartbeats: RecentHeartbeat[];
};

export type LoginProvider = {
  id: string;
  label: string;
  href: string;
};

export function LoginView({ providers }: { providers: LoginProvider[] }) {
  return (
    <div class="grid min-h-[calc(100vh-9rem)] place-items-center">
      <Panel class="w-full max-w-md">
        <div class="space-y-5">
          <div>
            <h1 class="text-2xl font-semibold tracking-normal">CloudTime</h1>
            <p class="mt-2 text-sm text-base-content/60">
              Sign in to manage your coding activity.
            </p>
          </div>
          {providers.length > 0 ? (
            <div class="grid gap-2">
              {providers.map((provider) => (
                <a class="btn btn-primary w-full" href={provider.href}>
                  Continue with {provider.label}
                </a>
              ))}
            </div>
          ) : (
            <Notice tone="warning">No OAuth provider is configured.</Notice>
          )}
        </div>
      </Panel>
    </div>
  );
}

export function DashboardView({
  data,
  generatedApiKey,
}: {
  data: DashboardData;
  generatedApiKey?: string;
}) {
  const displayName = data.user.displayName || data.user.username;
  const maxProjectSeconds = Math.max(...data.projects.map((p) => p.totalSeconds), 0);
  const maxCategorySeconds = Math.max(...data.categories.map((c) => c.totalSeconds), 0);
  const aiProjectChartData: ChartDatum[] = data.aiCoding.projects.map((project) => ({
    label: project.name,
    value: project.heartbeatCount,
    text: formatHeartbeatCount(project.heartbeatCount),
  }));
  const dailyChartData: ChartDatum[] = data.dailySummaries.map((day) => ({
    label: day.date.slice(5),
    value: day.totalSeconds,
    text: formatSeconds(day.totalSeconds),
  }));
  const projectChartData: ChartDatum[] = data.projects.map((project) => ({
    label: project.name,
    value: project.totalSeconds,
    text: formatSeconds(project.totalSeconds),
  }));

  return (
    <>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">Dashboard</p>
          <h1 class="mt-1 text-3xl font-semibold tracking-normal">{displayName}</h1>
          <p class="mt-2 text-sm text-base-content/60">
            {data.user.timezone} / {data.user.timeout} min timeout
          </p>
        </div>
        <a class="btn btn-outline btn-sm" href="/api/v1/health">
          API health
        </a>
      </div>

      <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={`Today (${data.today.date})`}
          value={formatSeconds(data.today.totalSeconds)}
          detail="Aggregated coding time"
        />
        <MetricCard
          label="Last 30 days"
          value={formatSeconds(data.last30DaysSeconds)}
          detail="From daily summaries"
        />
        <MetricCard
          label="All time"
          value={formatSeconds(data.allTimeSeconds)}
          detail={`${data.heartbeatCount.toLocaleString()} heartbeats`}
        />
        <MetricCard
          label="AI coding"
          value={data.aiCoding.totalHeartbeats.toLocaleString()}
          detail={
            data.aiCoding.lastHeartbeatAt
              ? `Last seen ${formatDateTime(data.aiCoding.lastHeartbeatAt, data.user.timezone)}`
              : "No AI coding heartbeats yet"
          }
        />
      </section>

      <div class="grid gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <Panel title="API key">
          <div class="space-y-4">
            {generatedApiKey ? (
              <Notice tone="success">A new API key was generated.</Notice>
            ) : null}
            <div class="rounded-lg bg-base-200 p-4">
              <pre class="ct-mono whitespace-pre-wrap break-all">
                {generatedApiKey
                  ? generatedApiKey
                  : `[settings]\napi_url = ${data.apiBaseUrl}\napi_key = <regenerate to reveal>`}
              </pre>
            </div>
            <a class="btn btn-primary" href="/app/api-key/confirm">
              Regenerate API key
            </a>
          </div>
        </Panel>

        <Panel title="Account">
          <dl class="grid gap-3 text-sm">
            <InfoRow label="Email" value={data.user.email ?? "Not set"} />
            <InfoRow label="Providers" value={data.providers.length.toString()} />
            <InfoRow label="Active sessions" value={data.activeSessionCount.toString()} />
            <InfoRow label="Machines" value={data.machineCount.toString()} />
            <InfoRow label="Clients" value={data.userAgentCount.toString()} />
          </dl>
        </Panel>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <Panel title="Daily activity">
          <VerticalBarChart
            id="daily-activity-chart"
            title="Daily coding activity"
            description="Coding time by day for the last 14 days."
            data={dailyChartData}
            empty="No daily summaries yet."
          />
        </Panel>

        <Panel title="Project distribution">
          <RankedBarChart
            data={projectChartData}
            empty="No project summaries yet."
          />
        </Panel>
      </div>

      <div class="grid gap-6 lg:grid-cols-2">
        <Panel title="Projects">
          {data.projects.length > 0 ? (
            <div class="space-y-4">
              {data.projects.map((project) => (
                <ProgressRow
                  label={project.name}
                  value={formatSeconds(project.totalSeconds)}
                  percent={maxProjectSeconds > 0 ? (project.totalSeconds / maxProjectSeconds) * 100 : 0}
                />
              ))}
            </div>
          ) : (
            <EmptyState>No project summaries yet.</EmptyState>
          )}
        </Panel>

        <Panel title="Categories">
          {data.categories.length > 0 ? (
            <div class="space-y-4">
              {data.categories.map((category) => (
                <ProgressRow
                  label={category.name}
                  value={formatSeconds(category.totalSeconds)}
                  percent={maxCategorySeconds > 0 ? (category.totalSeconds / maxCategorySeconds) * 100 : 0}
                />
              ))}
            </div>
          ) : (
            <EmptyState>No category summaries yet.</EmptyState>
          )}
        </Panel>
      </div>

      <Panel
        title="AI coding activity"
        action={
          <a class="btn btn-outline btn-sm" href="/app/ai/prices">
            Manage AI pricing
          </a>
        }
      >
        <div class="space-y-6">
          <AiUsageSummarySection usage={data.aiCoding.usage} />
          <div class="grid gap-6 xl:grid-cols-[minmax(240px,0.75fr)_minmax(0,1.25fr)]">
            <div class="space-y-5">
              <dl class="grid gap-3 text-sm">
                <InfoRow label="Stored heartbeats" value={formatHeartbeatCount(data.aiCoding.totalHeartbeats)} />
                <InfoRow
                  label="Last seen"
                  value={
                    data.aiCoding.lastHeartbeatAt
                      ? formatDateTime(data.aiCoding.lastHeartbeatAt, data.user.timezone)
                      : "Never"
                  }
                />
              </dl>
              <RankedBarChart
                data={aiProjectChartData}
                empty="No AI coding project activity in the last 30 days."
              />
            </div>
            <DataTable
              headers={["Time", "Entity", "Project", "Language", "Client"]}
              empty="No AI coding heartbeats received yet."
              rows={data.aiCoding.recentHeartbeats.map((heartbeat) => [
                formatDateTime(heartbeat.time, data.user.timezone),
                <div class="min-w-56">
                  <div class="truncate font-medium">{heartbeat.entity}</div>
                  <div class="text-xs text-base-content/50">
                    {heartbeat.type}
                    {heartbeat.isWrite ? " / write" : ""}
                  </div>
                </div>,
                heartbeat.project ?? "Unknown",
                heartbeat.language ?? "Unknown",
                <div>
                  <div>{heartbeat.editor ?? "Unknown"}</div>
                  <div class="text-xs text-base-content/50">{heartbeat.machine ?? "No machine"}</div>
                </div>,
              ])}
            />
          </div>
        </div>
      </Panel>

      <Panel title="Recent heartbeats">
        <DataTable
          headers={["Time", "Entity", "Project", "Language", "Category", "Client"]}
          empty="No heartbeats received yet."
          rows={data.recentHeartbeats.map((heartbeat) => [
            formatDateTime(heartbeat.time, data.user.timezone),
            <div class="min-w-56">
              <div class="truncate font-medium">{heartbeat.entity}</div>
              <div class="text-xs text-base-content/50">
                {heartbeat.type}
                {heartbeat.isWrite ? " / write" : ""}
              </div>
            </div>,
            heartbeat.project ?? "Unknown",
            heartbeat.language ?? "Unknown",
            heartbeat.category ?? "coding",
            <div>
              <div>{heartbeat.editor ?? "Unknown"}</div>
              <div class="text-xs text-base-content/50">{heartbeat.machine ?? "No machine"}</div>
            </div>,
          ])}
        />
      </Panel>

      <Panel title="Linked providers">
        <DataTable
          headers={["Provider", "Username", "Email"]}
          empty="No linked providers."
          rows={data.providers.map((provider) => [
            provider.provider,
            provider.username ?? "Unknown",
            provider.email ?? "Not shared",
          ])}
        />
      </Panel>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-4 border-b border-base-200 pb-2 last:border-b-0 last:pb-0">
      <dt class="text-base-content/60">{label}</dt>
      <dd class="min-w-0 truncate font-medium">{value}</dd>
    </div>
  );
}

type TokenClassKey =
  | "input_tokens"
  | "cached_input_tokens"
  | "output_tokens"
  | "reasoning_output_tokens"
  | "cache_write_tokens"
  | "cache_read_tokens";

const TOKEN_CLASS_LABELS: Array<[TokenClassKey, string]> = [
  ["input_tokens", "Input"],
  ["cached_input_tokens", "Cached input"],
  ["output_tokens", "Output"],
  ["reasoning_output_tokens", "Reasoning"],
  ["cache_write_tokens", "Cache write"],
  ["cache_read_tokens", "Cache read"],
];

function sumTokenClasses(t: AiTokenTotals): number {
  return (
    t.input_tokens +
    t.cached_input_tokens +
    t.output_tokens +
    t.reasoning_output_tokens +
    t.cache_write_tokens +
    t.cache_read_tokens
  );
}

function formatTokens(count: number): string {
  return count.toLocaleString();
}

/**
 * Render an estimated cost as `CODE 1,234.5678`. The summary currency is an
 * arbitrary `^[A-Z]{3}$` owner-typed code (not always a real ISO 4217 code), so
 * a numeric formatter is used rather than `Intl` currency style, which throws on
 * unknown codes. `null` means the usage could not be priced (never a silent 0).
 */
function formatCost(value: number | null, currency: string): string {
  if (value === null) return "—";
  return `${currency} ${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

function UsageTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div class="rounded-lg border border-base-200 bg-base-200/40 p-3">
      <div class="text-xs text-base-content/60">{label}</div>
      <div class="mt-1 break-words text-lg font-semibold text-base-content">{value}</div>
      <div class="mt-1 text-xs text-base-content/50">{detail}</div>
    </div>
  );
}

/**
 * Actionable, non-intrusive setup guidance shown when recent AI usage is
 * attributed to a known provider but an unknown model (Issue #201). It is an
 * advisory `role="note"` (not an interrupting `alert`): it names the cause, gives
 * the exact one-time local command for tools with tailored guidance (else generic
 * troubleshooting), and links to the canonical instructions. It self-resolves —
 * once no such usage remains in the window, `detectUnattributedTools` returns
 * nothing and this renders null. It never shows a secret or client configuration.
 */
function AttributionGuidance({ status }: { status: AttributionStatus }) {
  if (!status.hasUnattributed) return null;
  return (
    <div role="note" class="alert alert-info flex-col items-start gap-3 rounded-lg text-sm">
      {status.affected.map((tool) => (
        <div class="w-full space-y-1">
          <div class="font-semibold">
            {tool.tool} usage isn't attributed to a model ({formatHeartbeatCount(tool.heartbeatCount)})
          </div>
          {tool.hasTailoredGuidance && tool.command ? (
            <>
              <div>
                {tool.tool} heartbeats currently arrive without the active model, so this usage
                buckets under "unknown" and is left out of the estimated cost. Run this once on the
                machine where you use {tool.tool}, then start a new {tool.tool} session:
              </div>
              <code class="block w-full overflow-x-auto rounded bg-base-300/60 px-2 py-1 font-mono text-xs">
                {tool.command}
              </code>
            </>
          ) : (
            <div>
              These {tool.provider} heartbeats arrive without a model, so this usage buckets under
              "unknown" and is left out of the estimated cost.
            </div>
          )}
          <div class="text-xs">
            <a class="link" href={tool.docUrl} target="_blank" rel="noopener noreferrer">
              {tool.hasTailoredGuidance ? `${tool.tool} model attribution setup` : "AI attribution troubleshooting"}
            </a>{" "}
            — you run this on your own machine; CloudTime only shows the steps.
          </div>
        </div>
      ))}
    </div>
  );
}

function AiUsageSummarySection({ usage }: { usage: AiUsageSummary }) {
  const totals = usage.totals;
  const attribution = detectUnattributedTools(usage);
  const totalTokens = sumTokenClasses(totals);
  const hasUsage = totals.heartbeat_count > 0 || totalTokens > 0;

  const dailyChartData: ChartDatum[] = usage.daily.map((day) => {
    const dayTokens = sumTokenClasses(day);
    return { label: day.date.slice(5), value: dayTokens, text: formatTokens(dayTokens) };
  });

  return (
    <div class="space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">Token usage &amp; estimated cost</h3>
        <span class="text-xs text-base-content/50">
          {usage.start} to {usage.end} / {usage.timezone}
        </span>
      </div>

      {!hasUsage ? (
        <EmptyState>
          No aggregated AI token usage in this window yet. Token totals appear once the hourly
          aggregation runs over ai coding heartbeats that report token counts.
        </EmptyState>
      ) : (
        <>
          <div class="grid gap-3 sm:grid-cols-3">
            <UsageTile
              label="Estimated cost"
              value={formatCost(totals.estimated_cost, usage.currency)}
              detail="API-equivalent estimate, not a bill"
            />
            <UsageTile
              label="Priced heartbeats"
              value={formatHeartbeatCount(totals.heartbeat_count)}
              detail={`${formatTokens(totalTokens)} tokens`}
            />
            <UsageTile
              label="Avg prompt length"
              value={totals.prompt_length_avg === null ? "—" : Math.round(totals.prompt_length_avg).toLocaleString()}
              detail="Characters per reporting heartbeat"
            />
          </div>

          {totals.estimated_cost === null ? (
            <Notice tone="info">
              No enabled price row matches this usage, so the estimated cost is unavailable. Add a
              price under Manage AI pricing to see an estimate.
            </Notice>
          ) : null}
          {totals.estimated_cost !== null && totals.missing_price_count > 0 ? (
            <Notice tone="warning">
              {formatHeartbeatCount(totals.missing_price_count)} could not be priced in {usage.currency} and
              are excluded from the estimate.
            </Notice>
          ) : null}
          {usage.mixed_currency ? (
            <Notice tone="warning">
              Some priced usage is in a different currency and is excluded from the {usage.currency} total.
            </Notice>
          ) : null}
          <AttributionGuidance status={attribution} />

          <div class="grid gap-6 lg:grid-cols-2">
            <div class="space-y-3">
              <h4 class="text-xs font-semibold uppercase tracking-normal text-base-content/50">Token classes</h4>
              <dl class="grid gap-2 text-sm">
                {TOKEN_CLASS_LABELS.map(([key, label]) => (
                  <InfoRow label={label} value={formatTokens(totals[key])} />
                ))}
              </dl>
            </div>
            <div class="space-y-3">
              <h4 class="text-xs font-semibold uppercase tracking-normal text-base-content/50">Daily tokens</h4>
              <VerticalBarChart
                id="ai-token-trend-chart"
                title="Daily AI tokens"
                description="Total AI tokens aggregated per day in the selected window."
                data={dailyChartData}
                empty="No daily AI token usage yet."
              />
            </div>
          </div>

          {usage.by_model.length > 0 ? (
            <div class="space-y-3">
              <h4 class="text-xs font-semibold uppercase tracking-normal text-base-content/50">By model</h4>
              <DataTable
                headers={["Provider", "Model", "Heartbeats", "Tokens", "Est. cost"]}
                empty="No model breakdown yet."
                rows={usage.by_model.slice(0, 8).map((m) => [
                  m.provider,
                  m.model,
                  formatHeartbeatCount(m.heartbeat_count),
                  formatTokens(sumTokenClasses(m)),
                  formatCost(m.estimated_cost, usage.currency),
                ])}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function formatSeconds(totalSeconds: number): string {
  if (totalSeconds <= 0) return "0 mins";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours === 0) return `${minutes} min${minutes === 1 ? "" : "s"}`;
  if (minutes === 0) return `${hours} hr${hours === 1 ? "" : "s"}`;
  return `${hours} hr${hours === 1 ? "" : "s"} ${minutes} min${minutes === 1 ? "" : "s"}`;
}

function formatHeartbeatCount(count: number): string {
  return `${count.toLocaleString()} heartbeat${count === 1 ? "" : "s"}`;
}

function formatDateTime(epochSeconds: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochSeconds * 1000));
}
