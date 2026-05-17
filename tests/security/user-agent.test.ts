/**
 * Unit tests for src/utils/user-agent.ts — the wakatime-cli User-Agent parser.
 *
 * The format that wakatime-cli emits is:
 *   wakatime/<cli-ver> (<os>-<core>-<platform>) <runtime> <plugin>/<plugin-ver>
 */
import { describe, expect, it } from "vitest";
import { parseUserAgent } from "../../src/utils/user-agent";

describe("parseUserAgent (wakatime-cli format)", () => {
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
      editor: "Mozilla",
      version: "5.0",
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
