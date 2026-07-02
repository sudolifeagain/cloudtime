import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../types";
import { rateLimitMiddleware } from "../middleware/rate-limit";
import { startOAuthLogin } from "./auth/login";
import { sha256Hex } from "../utils/crypto";
import { rotateApiKey } from "../utils/api-key";
import {
  clearSessionCookie,
  getSessionTokenFromCookie,
  validateSession,
  invalidateOtherSessions,
  invalidateSession,
} from "../utils/session";
import { addDays, formatDate, getToday } from "../utils/time-format";
import { type UserRow, USER_COLUMNS } from "../utils/user";
import { NoProfileFieldsError, updateUserProfile, validateProfileInput } from "../utils/profile";
import {
  loadEmbedSettings,
  prepareEmbedSettingsUpdate,
  saveEmbedSettings,
  type EmbedSettingsUpdate,
} from "../utils/embed-settings";
import { AppLayout } from "../ui/components";
import {
  DashboardView,
  LoginView,
  type AiCodingOverview,
  type AiProjectSummary,
  type CategorySummary,
  type DailySummary,
  type DashboardData,
  type LoginProvider,
  type ProjectSummary,
  type RecentHeartbeat,
} from "../ui/dashboard";
import { SettingsView, timezoneOptions } from "../ui/settings";
import { ApiKeyConfirmView } from "../ui/api-key";

type WebEnv = {
  Bindings: Env;
};

type AppSession = {
  userId: string;
  sessionId: string;
  tokenHash: string;
};

const web = new Hono<WebEnv>();
const appOAuthInitiateRateLimit = rateLimitMiddleware(
  (env) => env.RATE_LIMIT_OAUTH_INITIATE,
  "oauth-initiate",
  "RATE_LIMIT_OAUTH_INITIATE",
);

web.get("/", (c) => c.redirect("/app", 302));

web.get("/app/login/:provider", appOAuthInitiateRateLimit, async (c) => {
  return startOAuthLogin(c, c.req.param("provider"), "/app");
});

web.get("/app", async (c) => {
  const session = await readSession(c);
  if (!session) return renderLogin(c);

  const data = await loadDashboardData(c, session.userId);
  if (!data) return renderLogin(c);

  return renderDashboard(c, data);
});

web.get("/app/settings", async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect("/app", 303);

  const data = await loadDashboardData(c, session.userId);
  if (!data) return c.redirect("/app", 303);

  return renderSettings(c, data);
});

web.post("/app/settings", async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect("/app", 303);

  const form = await c.req.formData();
  const timezone = String(form.get("timezone") ?? "");
  const timeoutRaw = String(form.get("timeout") ?? "");
  const timeout = Number(timeoutRaw);
  const input = { timezone, timeout };
  const validationError = validateProfileInput(input);

  if (validationError) {
    const data = await loadDashboardData(c, session.userId);
    if (!data) return c.redirect("/app", 303);
    return renderSettings(c, data, { error: validationError, status: 400 });
  }

  try {
    await updateUserProfile(c.env.DB, session.userId, input);
  } catch (err) {
    const data = await loadDashboardData(c, session.userId);
    if (!data) return c.redirect("/app", 303);
    const message = err instanceof NoProfileFieldsError ? "No fields to update" : "Unable to save settings";
    return renderSettings(c, data, { error: message, status: 400 });
  }

  const data = await loadDashboardData(c, session.userId);
  if (!data) return c.redirect("/app", 303);
  return renderSettings(c, data, { saved: true });
});

web.post("/app/settings/embed-cards", async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect("/app", 303);

  const form = await c.req.formData();
  const body: EmbedSettingsUpdate = {
    enabled: form.get("enabled") === "on",
    freshness_minutes: Number(String(form.get("freshness_minutes") ?? "")),
    default_theme: String(form.get("default_theme") ?? ""),
  };

  const current = await loadEmbedSettings(c.env.DB, session.userId);
  const prepared = prepareEmbedSettingsUpdate(current, body);
  if (!prepared.ok) {
    const data = await loadDashboardData(c, session.userId);
    if (!data) return c.redirect("/app", 303);
    return renderSettings(c, data, { embedError: prepared.error, status: 400 });
  }

  await saveEmbedSettings(c.env.DB, session.userId, prepared.next);

  const data = await loadDashboardData(c, session.userId);
  if (!data) return c.redirect("/app", 303);
  return renderSettings(c, data, { embedSaved: true });
});

web.post("/app/api-key", async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect("/app", 303);

  const generatedApiKey = await rotateApiKey(c.env.DB, c.env.KV, session.userId);
  if (!generatedApiKey) return c.redirect("/app", 303);

  await invalidateOtherSessions(c.env.DB, c.env.KV, session.userId, session.tokenHash);

  const data = await loadDashboardData(c, session.userId);
  if (!data) return c.redirect("/app", 303);

  return renderDashboard(c, data, generatedApiKey);
});

web.get("/app/api-key/confirm", async (c) => {
  const session = await readSession(c);
  if (!session) return c.redirect("/app", 303);

  const data = await loadDashboardData(c, session.userId);
  if (!data) return c.redirect("/app", 303);

  return renderApiKeyConfirm(c, data);
});

web.post("/app/logout", async (c) => {
  const session = await readSession(c);
  if (session) {
    await invalidateSession(c.env.DB, c.env.KV, session.tokenHash);
  }
  clearSessionCookie(c, c.env);
  return c.redirect("/app", 303);
});

async function readSession(c: Context<WebEnv>): Promise<AppSession | null> {
  const token = getSessionTokenFromCookie(c, c.env);
  if (!token) return null;

  const tokenHash = await sha256Hex(token);
  const session = await validateSession(c.env.DB, c.env.KV, tokenHash);
  if (!session) return null;

  return {
    userId: session.userId,
    sessionId: session.sessionId,
    tokenHash,
  };
}

function renderLogin(c: Context<WebEnv>) {
  return c.html(
    <AppLayout title="CloudTime">
      <LoginView providers={configuredProviders(c.env)} />
    </AppLayout>,
    200,
    noStoreHeaders(),
  );
}

function renderDashboard(c: Context<WebEnv>, data: DashboardData, generatedApiKey?: string) {
  return c.html(
    <AppLayout title="Dashboard" username={data.user.username} activePath="dashboard">
      <DashboardView data={data} generatedApiKey={generatedApiKey} />
    </AppLayout>,
    200,
    noStoreHeaders(),
  );
}

function renderSettings(
  c: Context<WebEnv>,
  data: DashboardData,
  options: { saved?: boolean; error?: string; embedSaved?: boolean; embedError?: string; status?: 200 | 400 } = {},
) {
  return c.html(
    <AppLayout title="Settings" username={data.user.username} activePath="settings">
      <SettingsView
        data={data}
        timezones={timezoneOptions(data.user.timezone)}
        saved={options.saved}
        error={options.error}
        embedSaved={options.embedSaved}
        embedError={options.embedError}
      />
    </AppLayout>,
    options.status ?? 200,
    noStoreHeaders(),
  );
}

function renderApiKeyConfirm(c: Context<WebEnv>, data: DashboardData) {
  return c.html(
    <AppLayout title="Regenerate API Key" username={data.user.username} activePath="dashboard">
      <ApiKeyConfirmView data={data} />
    </AppLayout>,
    200,
    noStoreHeaders(),
  );
}

function configuredProviders(env: Env): LoginProvider[] {
  const providers = [
    {
      id: "github",
      label: "GitHub",
      enabled: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    },
    {
      id: "google",
      label: "Google",
      enabled: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
    {
      id: "discord",
      label: "Discord",
      enabled: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
    },
  ];

  return providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      id: provider.id,
      label: provider.label,
      href: `/app/login/${provider.id}`,
    }));
}

async function loadDashboardData(c: Context<WebEnv>, userId: string): Promise<DashboardData | null> {
  const userRow = await c.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(userId)
    .first<UserRow>();

  if (!userRow) return null;

  const timezone = userRow.timezone;
  const today = formatDate(getToday(timezone));
  const last30Start = formatDate(addDays(getToday(timezone), -29));
  const last14Start = formatDate(addDays(getToday(timezone), -13));
  const apiBaseUrl = `${(c.env.APP_URL ?? new URL(c.req.url).origin).replace(/\/+$/, "")}/api/v1`;

  const [
    todaySeconds,
    last30Seconds,
    allTimeSeconds,
    heartbeatCount,
    aiCoding,
    activeSessionCount,
    machineCount,
    userAgentCount,
    providers,
    dailySummaries,
    projects,
    fallbackProjects,
    categories,
    recentHeartbeats,
    embedSettings,
  ] = await Promise.all([
    scalarNumber(c.env.DB, "SELECT COALESCE(SUM(total_seconds), 0) AS value FROM summaries WHERE user_id = ? AND date = ?", [userId, today]),
    scalarNumber(c.env.DB, "SELECT COALESCE(SUM(total_seconds), 0) AS value FROM summaries WHERE user_id = ? AND date >= ?", [userId, last30Start]),
    scalarNumber(c.env.DB, "SELECT COALESCE(SUM(total_seconds), 0) AS value FROM summaries WHERE user_id = ?", [userId]),
    scalarNumber(c.env.DB, "SELECT COUNT(*) AS value FROM heartbeats WHERE user_id = ?", [userId]),
    loadAiCodingOverview(c.env.DB, userId),
    scalarNumber(
      c.env.DB,
      "SELECT COUNT(*) AS value FROM sessions WHERE user_id = ? AND expires_at > datetime('now') AND last_active_at >= datetime('now', '-1 day')",
      [userId],
    ),
    scalarNumber(c.env.DB, "SELECT COUNT(*) AS value FROM machine_names WHERE user_id = ?", [userId]),
    scalarNumber(c.env.DB, "SELECT COUNT(*) AS value FROM user_agents WHERE user_id = ?", [userId]),
    loadProviders(c.env.DB, userId),
    loadDailySummaries(c.env.DB, userId, last14Start, today),
    loadProjectSummaries(c.env.DB, userId, last30Start),
    loadFallbackProjects(c.env.DB, userId),
    loadCategorySummaries(c.env.DB, userId, last30Start),
    loadRecentHeartbeats(c.env.DB, userId),
    loadEmbedSettings(c.env.DB, userId),
  ]);

  const projectData = projects.length > 0 ? projects : fallbackProjects;

  return {
    user: {
      username: userRow.username,
      displayName: userRow.display_name,
      email: userRow.email,
      timezone,
      timeout: userRow.timeout,
    },
    today: {
      date: today,
      totalSeconds: todaySeconds,
    },
    last30DaysSeconds: last30Seconds,
    allTimeSeconds,
    heartbeatCount,
    aiCoding,
    activeSessionCount,
    machineCount,
    userAgentCount,
    apiBaseUrl,
    embedSettings,
    providers,
    dailySummaries,
    projects: projectData,
    categories,
    recentHeartbeats,
  };
}

async function loadAiCodingOverview(db: D1Database, userId: string): Promise<AiCodingOverview> {
  const since = Math.floor(Date.now() / 1000) - 30 * 86400;
  const [summary, projects, recentHeartbeats] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total_heartbeats, MAX(time) AS last_heartbeat_at
       FROM heartbeats
       WHERE user_id = ? AND category = 'ai coding'`,
    )
      .bind(userId)
      .first<{ total_heartbeats: number; last_heartbeat_at: number | null }>(),
    loadAiProjectSummaries(db, userId, since),
    loadRecentAiHeartbeats(db, userId),
  ]);

  return {
    totalHeartbeats: Number(summary?.total_heartbeats ?? 0),
    lastHeartbeatAt: summary?.last_heartbeat_at ?? null,
    projects,
    recentHeartbeats,
  };
}

async function loadAiProjectSummaries(
  db: D1Database,
  userId: string,
  since: number,
): Promise<AiProjectSummary[]> {
  const { results } = await db.prepare(
    `SELECT COALESCE(NULLIF(project, ''), 'Unknown') AS name,
            COUNT(*) AS heartbeat_count,
            MAX(time) AS last_heartbeat_at
     FROM heartbeats
     WHERE user_id = ? AND category = 'ai coding' AND time >= ?
     GROUP BY COALESCE(NULLIF(project, ''), 'Unknown')
     ORDER BY heartbeat_count DESC, last_heartbeat_at DESC, name ASC
     LIMIT 6`,
  )
    .bind(userId, since)
    .all<{ name: string; heartbeat_count: number; last_heartbeat_at: number | null }>();

  return results.map((row) => ({
    name: row.name,
    heartbeatCount: row.heartbeat_count,
    lastHeartbeatAt: row.last_heartbeat_at,
  }));
}

async function loadDailySummaries(
  db: D1Database,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<DailySummary[]> {
  const { results } = await db.prepare(
    `SELECT date, COALESCE(SUM(total_seconds), 0) AS total_seconds
     FROM summaries
     WHERE user_id = ? AND date >= ? AND date <= ?
     GROUP BY date
     ORDER BY date ASC`,
  )
    .bind(userId, startDate, endDate)
    .all<{ date: string; total_seconds: number }>();

  const totals = new Map(results.map((row) => [row.date, row.total_seconds]));
  const days: DailySummary[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  for (let time = start.getTime(); time <= end.getTime(); time += 86400000) {
    const date = new Date(time).toISOString().slice(0, 10);
    days.push({
      date,
      totalSeconds: totals.get(date) ?? 0,
    });
  }

  return days;
}

async function scalarNumber(db: D1Database, sql: string, binds: Array<string | number>): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ value: number | null }>();
  return Number(row?.value ?? 0);
}

async function loadProviders(db: D1Database, userId: string): Promise<DashboardData["providers"]> {
  const { results } = await db.prepare(
    "SELECT provider, provider_username, provider_email FROM oauth_accounts WHERE user_id = ? ORDER BY provider",
  )
    .bind(userId)
    .all<{ provider: string; provider_username: string | null; provider_email: string | null }>();

  return results.map((row) => ({
    provider: row.provider,
    username: row.provider_username,
    email: row.provider_email,
  }));
}

async function loadProjectSummaries(db: D1Database, userId: string, startDate: string): Promise<ProjectSummary[]> {
  const { results } = await db.prepare(
    `SELECT project AS name, COALESCE(SUM(total_seconds), 0) AS total_seconds
     FROM summaries
     WHERE user_id = ? AND date >= ? AND project IS NOT NULL
     GROUP BY project
     ORDER BY total_seconds DESC, project ASC
     LIMIT 6`,
  )
    .bind(userId, startDate)
    .all<{ name: string; total_seconds: number }>();

  return results.map((row) => ({
    name: row.name,
    totalSeconds: row.total_seconds,
    lastHeartbeatAt: null,
  }));
}

async function loadFallbackProjects(db: D1Database, userId: string): Promise<ProjectSummary[]> {
  const { results } = await db.prepare(
    `SELECT project AS name, last_heartbeat_at
     FROM user_projects
     WHERE user_id = ?
     ORDER BY last_heartbeat_at DESC, project ASC
     LIMIT 6`,
  )
    .bind(userId)
    .all<{ name: string; last_heartbeat_at: number }>();

  return results.map((row) => ({
    name: row.name,
    totalSeconds: 0,
    lastHeartbeatAt: row.last_heartbeat_at,
  }));
}

async function loadCategorySummaries(db: D1Database, userId: string, startDate: string): Promise<CategorySummary[]> {
  const { results } = await db.prepare(
    `SELECT COALESCE(category, 'coding') AS name, COALESCE(SUM(total_seconds), 0) AS total_seconds
     FROM summaries
     WHERE user_id = ? AND date >= ?
     GROUP BY COALESCE(category, 'coding')
     ORDER BY total_seconds DESC, name ASC
     LIMIT 6`,
  )
    .bind(userId, startDate)
    .all<{ name: string; total_seconds: number }>();

  return results.map((row) => ({
    name: row.name,
    totalSeconds: row.total_seconds,
  }));
}

async function loadRecentAiHeartbeats(db: D1Database, userId: string): Promise<RecentHeartbeat[]> {
  return loadRecentHeartbeats(db, userId, "ai coding", 8);
}

async function loadRecentHeartbeats(
  db: D1Database,
  userId: string,
  category: string | null = null,
  limit = 10,
): Promise<RecentHeartbeat[]> {
  const binds: Array<string | number> = [userId];
  if (category) binds.push(category);
  binds.push(limit);

  const { results } = await db.prepare(
    `SELECT entity, type, time, project, language, category, editor, machine, is_write
     FROM heartbeats
     WHERE user_id = ?${category ? " AND category = ?" : ""}
     ORDER BY time DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all<{
      entity: string;
      type: string;
      time: number;
      project: string | null;
      language: string | null;
      category: string | null;
      editor: string | null;
      machine: string | null;
      is_write: number;
    }>();

  return results.map((row) => ({
    entity: row.entity,
    type: row.type,
    time: row.time,
    project: row.project,
    language: row.language,
    category: row.category,
    editor: row.editor,
    machine: row.machine,
    isWrite: row.is_write === 1,
  }));
}

function noStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    Pragma: "no-cache",
  };
}

export default web;
