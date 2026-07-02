import { DataTable, EmptyState, MetricCard, Notice, Panel, ProgressRow } from "./components";
import { RankedBarChart, VerticalBarChart, type ChartDatum } from "./charts";

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

      <Panel title="AI coding activity">
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
