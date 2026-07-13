#!/usr/bin/env node
/**
 * Stopgap patch for the official `codex-cli-wakatime` plugin so its AI heartbeats
 * carry the active model in the User-Agent — letting a WakaTime-compatible server
 * (e.g. CloudTime) attribute `openai` + a concrete model instead of bucketing every
 * Codex heartbeat as `openai`/unknown. See docs/codex-model-attribution.md.
 *
 * Why this is needed: `claude-code-wakatime` already puts the model in the UA
 * (`... opus/4-8 claude-code/...`), but `codex-cli-wakatime` (<= 1.0.0) does not.
 * This patch prepends a `<model>/<effort>` token to the plugin's `--plugin` value,
 * read from the codex hook `input` (falling back to `config.toml`).
 *
 * Properties:
 *   - Idempotent: the patched file is always regenerated from a pristine `.orig`
 *     backup, so re-running (or upgrading an older patch) yields the same result.
 *   - Reversible: `--revert` restores the `.orig` backup.
 *   - Version-guarded / upstream-aware: only a recognized pristine `--plugin`
 *     line is patched. If the vendor changes that line (e.g. adds model support
 *     upstream), the anchor no longer matches and the script refuses to patch —
 *     so a future fixed release is left untouched.
 *
 * Usage:
 *   node scripts/patch-codex-wakatime.mjs            # discover + apply
 *   node scripts/patch-codex-wakatime.mjs --dry-run  # report, change nothing
 *   node scripts/patch-codex-wakatime.mjs --revert   # restore from .orig
 *   node scripts/patch-codex-wakatime.mjs --path <file>   # target a specific file
 *
 * No dependencies; Node >= 16. Exit 0 on success/no-op, 1 on error.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "cloudtime-model-passthrough";

// Exact pristine line to anchor the injection (codex-cli-wakatime bin, <= 1.0.0).
const ANCHOR = "const plugin = `codex-cli/${codexVersion || 'unknown'} ${PLUGIN_NAME}/${VERSION}`;";
const PATCHED =
  "const plugin = `${cloudtimeResolveModelToken(input)}codex-cli/${codexVersion || 'unknown'} ${PLUGIN_NAME}/${VERSION}`; // " +
  MARKER;

// Injected helpers. NOTE: regex character classes are written with `\\s` so the
// emitted file contains `\s` — a bare `\s` inside a JS string collapses to `s`
// (which is the very bug this catalog of escapes avoids).
const HELPERS = [
  "",
  "",
  `// --- ${MARKER} (local patch by scripts/patch-codex-wakatime.mjs; reversible via .orig backup) ---`,
  "// Prepend the active model as a `<model>/<effort>` token so a WakaTime-compatible",
  "// server can attribute provider/model (mirrors how claude-code UAs carry opus/4-8).",
  "function cloudtimeResolveModelToken(input) {",
  "  try {",
  "    let model = input && typeof input.model === 'string' ? input.model.trim() : '';",
  "    let effort = input && typeof input.model_reasoning_effort === 'string' ? input.model_reasoning_effort.trim() : '';",
  "    if (!model || !effort) {",
  "      const cfg = cloudtimeReadCodexConfig();",
  "      if (!model) model = cfg.model;",
  "      if (!effort) effort = cfg.effort;",
  "    }",
  "    if (!model) return '';",
  "    model = model.replace(/[\\s/]+/g, '-');",
  "    effort = (effort || 'unknown').replace(/[\\s/]+/g, '-');",
  "    return `${model}/${effort} `;",
  "  } catch (_) { return ''; }",
  "}",
  "function cloudtimeReadCodexConfig() {",
  "  const candidates = [];",
  "  if (process.env.CODEX_HOME) candidates.push(path.join(process.env.CODEX_HOME, 'config.toml'));",
  "  candidates.push(path.join(os.homedir(), '.codex', 'config.toml'));",
  "  for (const cfgPath of candidates) {",
  "    try {",
  "      const txt = fs.readFileSync(cfgPath, 'utf8');",
  '      const m = txt.match(/^\\s*model\\s*=\\s*"([^"]+)"/m);',
  '      const e = txt.match(/^\\s*model_reasoning_effort\\s*=\\s*"([^"]+)"/m);',
  "      if (m || e) return { model: m ? m[1].trim() : '', effort: e ? e[1].trim() : '' };",
  "    } catch (_) { /* try next candidate */ }",
  "  }",
  "  return { model: '', effort: '' };",
  "}",
  "",
].join("\n");

function fail(msg) {
  console.error(`[patch-codex-wakatime] ERROR: ${msg}`);
  process.exit(1);
}

/** Candidate CODEX_HOME roots, most specific first. */
function codexHomes() {
  const homes = [];
  if (process.env.CODEX_HOME) homes.push(process.env.CODEX_HOME);
  homes.push(path.join(os.homedir(), ".codex"));
  homes.push(path.join(os.homedir(), "AppData", "Local", "OpenAI", "CodexHome")); // Windows
  homes.push(path.join(os.homedir(), ".local", "share", "codex")); // possible XDG
  return [...new Set(homes)];
}

/** Discover every installed codex-cli-wakatime plugin bin under known homes. */
function discover() {
  const found = [];
  for (const home of codexHomes()) {
    const base = path.join(home, "plugins", "cache", "wakatime", "codex-cli-wakatime");
    let versions;
    try {
      versions = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const ver of versions) {
      const f = path.join(base, ver, "bin", "codex-cli-wakatime.js");
      if (fs.existsSync(f)) found.push(f);
    }
  }
  return [...new Set(found)];
}

function revert(target) {
  const orig = `${target}.orig`;
  if (!fs.existsSync(orig)) {
    console.log(`[patch-codex-wakatime] no backup at ${orig}; nothing to revert: ${target}`);
    return;
  }
  fs.copyFileSync(orig, target);
  console.log(`[patch-codex-wakatime] reverted ${target} from ${orig}`);
}

function apply(target, dryRun) {
  const orig = `${target}.orig`;
  const current = fs.readFileSync(target, "utf8");

  // Establish a trustworthy pristine source.
  let pristine;
  if (fs.existsSync(orig)) {
    pristine = fs.readFileSync(orig, "utf8");
    if (pristine.includes(MARKER)) {
      return fail(`${orig} is not pristine (contains the patch marker). Remove it and reinstall the plugin.`);
    }
  } else if (current.includes(MARKER)) {
    return fail(
      `${target} is already patched but has no ${path.basename(orig)} backup, so the pristine ` +
        `source cannot be recovered. Reinstall the plugin, then re-run.`,
    );
  } else {
    pristine = current;
  }

  // Version guard: only patch a recognized pristine structure. A mismatch means
  // the vendor changed the plugin (possibly adding model support upstream) — skip.
  if (!pristine.includes(ANCHOR)) {
    console.log(
      `[patch-codex-wakatime] SKIP ${target}: the plugin's --plugin line was not found ` +
        `(vendor structure changed; upstream may already emit the model). Left untouched.`,
    );
    return;
  }

  let patched = pristine.replace(ANCHOR, PATCHED);
  if (!patched.includes("function cloudtimeResolveModelToken")) patched += HELPERS;

  if (patched === current) {
    console.log(`[patch-codex-wakatime] already up to date: ${target}`);
    return;
  }
  if (dryRun) {
    console.log(`[patch-codex-wakatime] DRY-RUN would patch ${target} (backup: ${orig})`);
    return;
  }

  if (!fs.existsSync(orig)) fs.writeFileSync(orig, pristine);
  fs.writeFileSync(target, patched);
  console.log(`[patch-codex-wakatime] patched ${target} (backup: ${orig})`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const doRevert = args.includes("--revert");
  const pathIdx = args.indexOf("--path");
  const explicit = pathIdx >= 0 ? args[pathIdx + 1] : null;

  const targets = explicit ? [explicit] : discover();
  if (targets.length === 0) {
    return fail(
      "no codex-cli-wakatime plugin found under CODEX_HOME / ~/.codex / %LOCALAPPDATA%/OpenAI/CodexHome. " +
        "Pass --path <bin/codex-cli-wakatime.js>.",
    );
  }
  for (const t of targets) {
    if (!fs.existsSync(t)) fail(`target not found: ${t}`);
    if (doRevert) revert(t);
    else apply(t, dryRun);
  }
}

main();
