# Codex model attribution (stopgap plugin patch)

CloudTime derives `ai_provider` / `ai_model` for `ai coding` heartbeats from the
client User-Agent (see [AI usage → Deriving provider and model](ai-usage.md#deriving-provider-and-model-from-the-user-agent)).
Anthropic's `claude-code-wakatime` plugin already includes the model in the UA
(`... opus/4-8 claude-code/2.1.205 claude-code-wakatime/4.1.0`), so Claude Code
usage attributes to a concrete model with no extra setup.

OpenAI's `codex-cli-wakatime` plugin (through v1.0.0) does **not** put the model
in the UA — it sends `... codex-cli/<ver> codex-cli-wakatime/<ver>`. CloudTime can
still tell the heartbeat came from Codex (→ `openai`), but the **model is
`null`**, so all Codex usage rolls up under `openai` / unknown model and cannot be
split by `gpt-5.6-sol` vs `gpt-5.6-terra`, etc.

## The stopgap

`scripts/patch-codex-wakatime.mjs` patches the installed plugin to prepend the
active model as a `<model>/<effort>` token, mirroring how `claude-code-wakatime`
carries `opus/4-8`. The model is read from the Codex hook `input`, falling back
to `config.toml` (`$CODEX_HOME/config.toml`, then `~/.codex/config.toml`).

After patching, a Codex heartbeat's User-Agent looks like:

```
wakatime/<cli-ver> (<os>) <runtime> gpt-5.6-sol/high codex-cli/<ver> codex-cli-wakatime/<ver>
```

which CloudTime resolves to `openai` / `gpt-5.6-sol`.

### Apply

```sh
node scripts/patch-codex-wakatime.mjs            # discover the plugin and patch
node scripts/patch-codex-wakatime.mjs --dry-run  # report what it would do, change nothing
node scripts/patch-codex-wakatime.mjs --path <bin/codex-cli-wakatime.js>   # target a specific file
```

The script auto-discovers the plugin under `$CODEX_HOME`, `~/.codex`, and
`%LOCALAPPDATA%/OpenAI/CodexHome`. Node >= 16, no dependencies. Restart Codex (or
start a new session) so the patched plugin is loaded.

### Revert

```sh
node scripts/patch-codex-wakatime.mjs --revert
```

Restores the `.orig` backup the patch writes on first apply.

## Properties

- **Idempotent** — the patched file is regenerated from the pristine `.orig`
  backup on every run, so re-running (or upgrading an older patch) is a no-op or a
  clean re-apply, never a double patch.
- **Reversible** — `--revert` restores `.orig`; the pristine file is never lost.
  (If the plugin was patched by hand with no `.orig`, the script refuses rather
  than guess the pristine source — reinstall the plugin first.)
- **Version-guarded / upstream-aware** — only the recognized pristine `--plugin`
  line is patched. If a future plugin release changes that line — including one
  that adds model passthrough upstream — the anchor no longer matches and the
  script leaves the file untouched (`SKIP`). Re-run after any plugin update.

## Upstream

This is a stopgap, not a fork. The proper fix is for the plugin to include the
model itself; track or request it at
<https://github.com/wakatime/codex-cli-wakatime>. Once a release ships model
passthrough, revert the patch (or let the version guard skip it) and drop this
step.
