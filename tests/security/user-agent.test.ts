/**
 * Unit tests for src/utils/user-agent.ts — the compatible CLI User-Agent parser.
 *
 * The compatible CLI format is:
 *   wakatime/<cli-ver> (<os>-<core>-<platform>) <runtime> <plugin>/<plugin-ver>
 */
import { describe, expect, it } from "vitest";
import { deriveAiIdentity, parseUserAgent } from "../../src/utils/user-agent";

describe("parseUserAgent (compatible CLI format)", () => {
  it("extracts os, editor, and version from the standard format", () => {
    const ua = "wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 vscode-wakatime/24.0.4";
    expect(parseUserAgent(ua)).toEqual({
      editor: "vscode-wakatime",
      version: "24.0.4",
      os: "linux",
    });
  });

  it("recognises darwin / windows OS prefixes", () => {
    expect(parseUserAgent("wakatime/v1.65.2 (darwin-23.4.0-arm64) go1.21.5 vscode-wakatime/24.0.4").os).toBe("darwin");
    expect(parseUserAgent("wakatime/v1.65.2 (windows-10-amd64) go1.21.5 vscode-wakatime/24.0.4").os).toBe("windows");
  });

  it("skips the wakatime/<cli-ver> token when picking the editor", () => {
    // No plugin segment at all; nothing else is editor-shaped.
    const ua = "wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5";
    expect(parseUserAgent(ua).editor).toBeNull();
  });

  it("picks the last plugin segment when several are present", () => {
    // Hypothetical case with both the CLI prefix and an inner plugin segment.
    const ua = "wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 jetbrains-wakatime/14.0.3";
    expect(parseUserAgent(ua)).toMatchObject({
      editor: "jetbrains-wakatime",
      version: "14.0.3",
    });
  });

  it("returns all-null parse for an unrecognised shape", () => {
    expect(parseUserAgent("Mozilla/5.0 totally-not-wakatime")).toEqual({
      editor: null,
      version: null,
      os: null,
    });
  });

  it("does not blow up on empty input", () => {
    expect(parseUserAgent("")).toEqual({ editor: null, version: null, os: null });
  });

  it("lower-cases the OS family", () => {
    expect(parseUserAgent("wakatime/v1 (DARWIN-23-arm64) go1 ed/1").os).toBe("darwin");
  });
});

describe("deriveAiIdentity (AI provider/model from a compatible AI-tool UA)", () => {
  it("derives anthropic + claude-opus-4-8 from a Claude Code UA", () => {
    const ua =
      "wakatime/v2.22.0 (windows-10.0.26200.8655-x86_64) go1.26.5 opus/4-8 claude-code/2.1.205 claude-code-wakatime/4.1.0";
    expect(deriveAiIdentity(ua)).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("normalizes other Anthropic model families (fable/5 -> claude-fable-5)", () => {
    const ua =
      "wakatime/v2.21.4 (windows-10.0.26200.8655-x86_64) go1.26.4 fable/5 claude-code/2.1.202 claude-code-wakatime/4.1.0";
    expect(deriveAiIdentity(ua)).toEqual({ provider: "anthropic", model: "claude-fable-5" });
  });

  it("attributes a codex heartbeat to openai and never cross-attributes the co-running claude model", () => {
    // `opus/4-8` is present only because Claude Code runs alongside; the
    // `-wakatime` plugin token proves codex-cli emitted this heartbeat.
    const ua =
      "wakatime/v2.22.0 (windows-10.0.26200.8655-x86_64) go1.26.5 opus/4-8 claude-code/2.1.205 codex-cli/unknown codex-cli-wakatime/1.0.0";
    expect(deriveAiIdentity(ua)).toEqual({ provider: "openai", model: null });
  });

  it("resolves a single tool from a bare token when no -wakatime plugin token is present", () => {
    const ua =
      "wakatime/v2.21.4 (windows-10.0.26200.8655-x86_64) go1.26.4 opus/4-8 claude-code/2.1.198";
    expect(deriveAiIdentity(ua)).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("leaves a co-running pair unresolved when the disambiguating plugin token is absent", () => {
    const ua =
      "wakatime/v2.21.4 (windows-10-amd64) go1.26.4 opus/4-8 claude-code/2.1.205 codex-cli/unknown";
    expect(deriveAiIdentity(ua)).toEqual({ provider: null, model: null });
  });

  it("returns the provider without a model when the Anthropic tool reports no model token", () => {
    const ua = "wakatime/v2.22.0 (windows-10-amd64) go1.26.5 claude-code/2.1.205 claude-code-wakatime/4.1.0";
    expect(deriveAiIdentity(ua)).toEqual({ provider: "anthropic", model: null });
  });

  it("returns all-null for a non-AI editor UA", () => {
    const ua = "wakatime/v1.65.2 (linux-6.5.0-amd64) go1.21.5 vscode-wakatime/24.0.4";
    expect(deriveAiIdentity(ua)).toEqual({ provider: null, model: null });
  });
});
