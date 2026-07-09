import { EmptyState, Notice, Panel } from "./components";
import type { DashboardData } from "./dashboard";
import { buildProfileBadgeSnippets, buildProfileCardSnippets } from "../utils/cards/snippets";
import { THEMES } from "../utils/cards/render";

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
  embedSaved,
  embedError,
}: {
  data: DashboardData;
  timezones: string[];
  saved?: boolean;
  error?: string;
  embedSaved?: boolean;
  embedError?: string;
}) {
  const snippets = buildProfileCardSnippets({
    apiBaseUrl: data.apiBaseUrl,
    username: data.user.username,
    theme: data.embedSettings.default_theme,
  });
  const badgeSnippets = buildProfileBadgeSnippets({
    apiBaseUrl: data.apiBaseUrl,
    username: data.user.username,
    theme: data.embedSettings.default_theme,
  });
  const themeOptions = Object.keys(THEMES);
  const cacheBusterValue = data.today.date.replace(/-/g, "");

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

      <div class="grid gap-6 xl:grid-cols-[minmax(320px,0.75fr)_minmax(0,1.25fr)]">
        <Panel title="GitHub profile cards">
          <form method="post" action="/app/settings/embed-cards" class="grid gap-5">
            {embedSaved ? <Notice tone="success">Card settings saved.</Notice> : null}
            {embedError ? <Notice tone="error">{embedError}</Notice> : null}

            <label class="label cursor-pointer justify-start gap-3 p-0">
              <input
                class="toggle toggle-primary"
                type="checkbox"
                name="enabled"
                checked={data.embedSettings.enabled}
              />
              <span class="label-text font-medium">Public cards</span>
              <span class={data.embedSettings.enabled ? "badge badge-success" : "badge badge-neutral"}>
                {data.embedSettings.enabled ? "On" : "Off"}
              </span>
            </label>

            <label class="form-control grid gap-2">
              <span class="label-text font-medium">Default theme</span>
              <select class="select select-bordered w-full" name="default_theme">
                {themeOptions.map((theme) => (
                  <option value={theme} selected={data.embedSettings.default_theme === theme}>
                    {theme}
                  </option>
                ))}
              </select>
            </label>

            <label class="form-control grid gap-2">
              <span class="label-text font-medium">Freshness window</span>
              <div class="join w-full">
                <input
                  class="input join-item input-bordered w-full"
                  type="number"
                  name="freshness_minutes"
                  min="1"
                  max="1440"
                  step="1"
                  value={data.embedSettings.freshness_minutes.toString()}
                  inputmode="numeric"
                />
                <span class="join-item flex items-center border border-base-300 bg-base-200 px-3 text-sm text-base-content/70">
                  minutes
                </span>
              </div>
            </label>

            <button class="btn btn-primary" type="submit">
              Save card settings
            </button>
          </form>
        </Panel>

        <Panel title="README snippets">
          <div class="space-y-4">
            {!data.embedSettings.enabled ? (
              <Notice tone="warning">Public cards are off. Enable them before using these snippets.</Notice>
            ) : null}

            <div class="grid gap-2 text-sm">
              <InfoRow label="Base URL" value={data.apiBaseUrl} />
              <InfoRow label="Theme" value={data.embedSettings.default_theme} />
              <InfoRow label="Cache-busting value" value={`v=${cacheBusterValue}`} />
            </div>

            <div class="divide-y divide-base-200">
              {snippets.map((snippet, index) => (
                <SnippetBlock
                  key={snippet.cardType}
                  snippetId={`profile-card-snippet-${snippet.cardType}`}
                  label={snippet.label}
                  markdown={snippet.markdown}
                  previewUrl={snippet.url}
                  previewAlt={snippet.altText}
                  previewEnabled={data.embedSettings.enabled}
                  first={index === 0}
                />
              ))}
              {badgeSnippets.map((snippet) => (
                <SnippetBlock
                  key={snippet.badgeType}
                  snippetId={`profile-badge-snippet-${snippet.badgeType}`}
                  label={snippet.label}
                  markdown={snippet.markdown}
                  previewUrl={snippet.url}
                  previewAlt={snippet.altText}
                  previewEnabled={data.embedSettings.enabled}
                  first={false}
                />
              ))}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}

function SnippetBlock({
  snippetId,
  label,
  markdown,
  previewUrl,
  previewAlt,
  previewEnabled,
  first,
}: {
  snippetId: string;
  label: string;
  markdown: string;
  previewUrl: string;
  previewAlt: string;
  previewEnabled: boolean;
  first: boolean;
}) {
  return (
    <section class={first ? "pb-4" : "py-4"}>
      <div class="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h3 class="text-sm font-semibold">{label}</h3>
        <button class="btn btn-outline btn-xs" type="button" data-copy-target={snippetId}>
          Copy Markdown
        </button>
      </div>
      <textarea
        id={snippetId}
        class="textarea textarea-bordered ct-mono min-h-20 w-full resize-y"
        readonly
      >
        {markdown}
      </textarea>
      <div class="mt-3">
        {previewEnabled ? (
          <img
            class="max-w-full rounded border border-base-300 bg-base-100"
            src={previewUrl}
            alt={previewAlt}
            loading="lazy"
          />
        ) : (
          <EmptyState>Enable public cards to preview {label.toLowerCase()}.</EmptyState>
        )}
      </div>
    </section>
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

