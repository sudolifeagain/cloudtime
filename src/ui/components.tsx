import type { Child, PropsWithChildren } from "hono/jsx";

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type LayoutProps = PropsWithChildren<{
  title: string;
  username?: string;
}>;

export function AppLayout({ title, username, children }: LayoutProps) {
  const pageTitle = title === "CloudTime" ? "CloudTime" : `${title} - CloudTime`;

  return (
    <html lang="en" data-theme="corporate">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{pageTitle}</title>
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body class="ct-shell">
        <header class="border-b border-base-300 bg-base-100">
          <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
            <a class="text-lg font-semibold tracking-normal text-base-content" href="/app">
              CloudTime
            </a>
            <div class="flex min-w-0 items-center gap-3">
              {username ? (
                <>
                  <span class="hidden truncate text-sm text-base-content/70 sm:inline">
                    {username}
                  </span>
                  <form method="post" action="/app/logout">
                    <button class="btn btn-ghost btn-sm" type="submit">
                      Sign out
                    </button>
                  </form>
                </>
              ) : null}
            </div>
          </div>
        </header>
        <main class="ct-page">{children}</main>
      </body>
    </html>
  );
}

export function Panel({
  title,
  action,
  children,
  class: className,
}: PropsWithChildren<{ title?: string; action?: Child; class?: string }>) {
  return (
    <section class={cx("ct-card p-4 sm:p-5", className)}>
      {title || action ? (
        <div class="mb-4 flex items-center justify-between gap-3">
          {title ? <h2 class="ct-section-title">{title}</h2> : <div />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div class="ct-card min-h-28 p-4">
      <div class="text-sm text-base-content/60">{label}</div>
      <div class="mt-3 break-words text-2xl font-semibold leading-tight text-base-content">
        {value}
      </div>
      {detail ? <div class="mt-2 text-sm text-base-content/60">{detail}</div> : null}
    </div>
  );
}

export function EmptyState({ children }: PropsWithChildren) {
  return (
    <div class="rounded-lg border border-dashed border-base-300 bg-base-200/60 px-4 py-6 text-sm text-base-content/60">
      {children}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
}: PropsWithChildren<{ tone?: "info" | "success" | "warning" | "error" }>) {
  return (
    <div
      class={cx(
        "alert rounded-lg",
        tone === "success" && "alert-success",
        tone === "warning" && "alert-warning",
        tone === "error" && "alert-error",
        tone === "info" && "alert-info",
      )}
    >
      <span>{children}</span>
    </div>
  );
}

export function DataTable({
  headers,
  rows,
  empty,
}: {
  headers: string[];
  rows: Child[][];
  empty: string;
}) {
  if (rows.length === 0) return <EmptyState>{empty}</EmptyState>;

  return (
    <div class="overflow-x-auto">
      <table class="table table-sm">
        <thead>
          <tr>
            {headers.map((header) => (
              <th class="whitespace-nowrap text-xs font-semibold uppercase tracking-normal text-base-content/50">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr>
              {row.map((cell) => (
                <td class="max-w-72 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProgressRow({
  label,
  value,
  percent,
}: {
  label: string;
  value: string;
  percent: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-3 text-sm">
        <span class="min-w-0 truncate font-medium">{label}</span>
        <span class="shrink-0 text-base-content/60">{value}</span>
      </div>
      <progress class="progress progress-primary h-2 w-full" value={clamped} max="100" />
    </div>
  );
}

