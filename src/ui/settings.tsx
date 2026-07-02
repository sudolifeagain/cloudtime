import { Notice, Panel } from "./components";
import type { DashboardData } from "./dashboard";

const FALLBACK_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Shanghai",
  "Asia/Singapore",
  "Australia/Sydney",
];

export function timezoneOptions(currentTimezone: string): string[] {
  const supported = typeof Intl.supportedValuesOf === "function"
    ? Intl.supportedValuesOf("timeZone")
    : [];
  return Array.from(new Set(["UTC", currentTimezone, ...supported, ...FALLBACK_TIMEZONES]))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

export function SettingsView({
  data,
  timezones,
  saved,
  error,
}: {
  data: DashboardData;
  timezones: string[];
  saved?: boolean;
  error?: string;
}) {
  return (
    <>
      <div class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p class="text-sm font-medium text-primary">Settings</p>
          <h1 class="mt-1 text-3xl font-semibold tracking-normal">Time tracking</h1>
          <p class="mt-2 text-sm text-base-content/60">
            {data.user.username}
          </p>
        </div>
        <a class="btn btn-outline btn-sm" href="/app">
          Back to dashboard
        </a>
      </div>

      <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.8fr)]">
        <Panel title="Profile timing">
          <form method="post" action="/app/settings" class="grid gap-5">
            {saved ? <Notice tone="success">Settings saved.</Notice> : null}
            {error ? <Notice tone="error">{error}</Notice> : null}

            <label class="form-control grid gap-2">
              <span class="label-text font-medium">Timezone</span>
              <select class="select select-bordered w-full" name="timezone">
                {timezones.map((timezone) => (
                  <option value={timezone} selected={timezone === data.user.timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
            </label>

            <label class="form-control grid gap-2">
              <span class="label-text font-medium">Heartbeat timeout</span>
              <div class="join w-full">
                <input
                  class="input join-item input-bordered w-full"
                  type="number"
                  name="timeout"
                  min="1"
                  max="60"
                  step="1"
                  value={data.user.timeout.toString()}
                  inputmode="numeric"
                />
                <span class="join-item flex items-center border border-base-300 bg-base-200 px-3 text-sm text-base-content/70">
                  minutes
                </span>
              </div>
            </label>

            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button class="btn btn-primary" type="submit">
                Save settings
              </button>
              <a class="btn btn-ghost" href="/app">
                Cancel
              </a>
            </div>
          </form>
        </Panel>

        <Panel title="Current effect">
          <dl class="grid gap-3 text-sm">
            <InfoRow label="Timezone" value={data.user.timezone} />
            <InfoRow label="Today" value={data.today.date} />
            <InfoRow label="Timeout" value={`${data.user.timeout} minutes`} />
          </dl>
        </Panel>
      </div>
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

