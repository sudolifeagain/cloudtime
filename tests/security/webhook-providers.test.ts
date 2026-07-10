/**
 * Unit tests for the pure webhook provider adapters (Issue #146,
 * specs/146-git-webhook-adapter/): signature verification (GitHub HMAC over the
 * raw body, GitLab token — both constant-time) and payload → CommitInput
 * mapping. No D1 — these exercise the adapter logic in isolation.
 */
import { describe, expect, it } from "vitest";
import {
  detectEvent,
  extractRepo,
  isPushEvent,
  isSupportedProvider,
  mapCommits,
  verify,
} from "../../src/utils/webhooks/providers";

const SECRET = "It is a secret to everybody";

/** Raw UTF-8 bytes of a string, as an ArrayBuffer (what the receiver HMACs). */
function toBuffer(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

/** Compute a GitHub `sha256=<hex>` signature over the raw body (reference impl). */
async function githubSignature(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return `sha256=${Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function githubPush(): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    repository: { full_name: "octo/hello" },
    commits: [
      {
        id: "a".repeat(40),
        message: "first commit",
        author: { name: "Ada", email: "ada@example.test" },
        committer: { name: "Grace", email: "grace@example.test" },
        timestamp: "2026-07-01T12:00:00Z",
        url: "https://github.test/octo/hello/commit/aaa",
      },
    ],
  };
}

describe("isSupportedProvider", () => {
  it("accepts github and gitlab, rejects anything else", () => {
    expect(isSupportedProvider("github")).toBe(true);
    expect(isSupportedProvider("gitlab")).toBe(true);
    expect(isSupportedProvider("bitbucket")).toBe(false);
    expect(isSupportedProvider("")).toBe(false);
    expect(isSupportedProvider(undefined)).toBe(false);
  });
});

describe("detectEvent / isPushEvent", () => {
  it("reads the provider event header; missing/empty → null", () => {
    expect(detectEvent("github", new Headers({ "X-GitHub-Event": "push" }))).toBe("push");
    expect(detectEvent("gitlab", new Headers({ "X-Gitlab-Event": "Push Hook" }))).toBe("Push Hook");
    expect(detectEvent("github", new Headers())).toBeNull();
    expect(detectEvent("github", new Headers({ "X-GitHub-Event": "" }))).toBeNull();
    // A GitLab header does not satisfy a GitHub delivery.
    expect(detectEvent("github", new Headers({ "X-Gitlab-Event": "Push Hook" }))).toBeNull();
  });

  it("classifies only the provider's push event as a push", () => {
    expect(isPushEvent("github", "push")).toBe(true);
    expect(isPushEvent("github", "ping")).toBe(false);
    expect(isPushEvent("gitlab", "Push Hook")).toBe(true);
    expect(isPushEvent("gitlab", "Tag Push Hook")).toBe(false);
    // Cross-provider event names do not count.
    expect(isPushEvent("github", "Push Hook")).toBe(false);
  });
});

describe("extractRepo", () => {
  it("reads the provider repository identity from the payload", () => {
    expect(extractRepo("github", { repository: { full_name: "octo/hello" } })).toBe("octo/hello");
    expect(extractRepo("gitlab", { project: { path_with_namespace: "grp/proj" } })).toBe("grp/proj");
  });

  it("returns null when the repository field is absent or empty", () => {
    expect(extractRepo("github", { repository: {} })).toBeNull();
    expect(extractRepo("github", { repository: { full_name: "" } })).toBeNull();
    expect(extractRepo("github", {})).toBeNull();
    expect(extractRepo("gitlab", { project: null })).toBeNull();
    expect(extractRepo("github", "not-an-object")).toBeNull();
  });
});

describe("verify — GitHub HMAC over the raw body", () => {
  it("accepts a valid signature over the exact raw bytes", async () => {
    const raw = JSON.stringify(githubPush());
    const sig = await githubSignature(raw, SECRET);
    const headers = new Headers({ "X-Hub-Signature-256": sig });
    expect(await verify("github", toBuffer(raw), headers, SECRET)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, and missing signature", async () => {
    const raw = JSON.stringify(githubPush());
    const sig = await githubSignature(raw, SECRET);

    // Same signature, but a different body → HMAC of the sent bytes differs.
    const tampered = raw.replace("first commit", "evil commit");
    expect(
      await verify("github", toBuffer(tampered), new Headers({ "X-Hub-Signature-256": sig }), SECRET),
    ).toBe(false);

    // Right body, wrong secret.
    expect(
      await verify("github", toBuffer(raw), new Headers({ "X-Hub-Signature-256": sig }), "wrong-secret"),
    ).toBe(false);

    // No signature header at all.
    expect(await verify("github", toBuffer(raw), new Headers(), SECRET)).toBe(false);
  });

  it("fails when even one whitespace byte differs from the signed body", async () => {
    // Signature computed over `raw`, verification run over `raw + " "` — a
    // re-serialized body would drift like this and must NOT verify.
    const raw = JSON.stringify(githubPush());
    const sig = await githubSignature(raw, SECRET);
    expect(
      await verify("github", toBuffer(`${raw} `), new Headers({ "X-Hub-Signature-256": sig }), SECRET),
    ).toBe(false);
  });
});

describe("verify — GitLab token header", () => {
  it("accepts a matching token and rejects a wrong or missing one", async () => {
    const raw = JSON.stringify({ project: { path_with_namespace: "grp/proj" }, commits: [] });
    expect(
      await verify("gitlab", toBuffer(raw), new Headers({ "X-Gitlab-Token": SECRET }), SECRET),
    ).toBe(true);
    expect(
      await verify("gitlab", toBuffer(raw), new Headers({ "X-Gitlab-Token": "nope" }), SECRET),
    ).toBe(false);
    expect(await verify("gitlab", toBuffer(raw), new Headers(), SECRET)).toBe(false);
  });
});

describe("mapCommits", () => {
  it("maps a GitHub push with ref from the top level and committer fields", () => {
    const { received, commits } = mapCommits("github", githubPush());
    expect(received).toBe(1);
    expect(commits).toHaveLength(1);
    const c = commits[0];
    expect(c.hash).toBe("a".repeat(40));
    expect(c.message).toBe("first commit");
    expect(c.author_name).toBe("Ada");
    expect(c.author_email).toBe("ada@example.test");
    expect(c.committer_name).toBe("Grace");
    expect(c.ref).toBe("refs/heads/main");
    expect(c.author_date).toBe("2026-07-01 12:00:00");
    expect(c.total_seconds).toBeNull();
  });

  it("omits committer fields for GitLab (not present in the payload)", () => {
    const payload = {
      ref: "refs/heads/dev",
      project: { path_with_namespace: "grp/proj" },
      commits: [
        {
          id: "b".repeat(40),
          message: "gitlab commit",
          author: { name: "Lin", email: "lin@example.test" },
          committer: { name: "ShouldBeIgnored", email: "nope@example.test" },
          timestamp: "2026-07-02T09:30:00Z",
          url: "https://gitlab.test/grp/proj/-/commit/bbb",
        },
      ],
    };
    const { commits } = mapCommits("gitlab", payload);
    expect(commits[0].committer_name).toBeNull();
    expect(commits[0].committer_email).toBeNull();
    expect(commits[0].author_name).toBe("Lin");
    expect(commits[0].ref).toBe("refs/heads/dev");
  });

  it("clamps an over-long message, omits an unparseable date, drops a no-id object", () => {
    const payload = {
      ref: "refs/heads/main",
      repository: { full_name: "octo/hello" },
      commits: [
        { id: "c".repeat(40), message: "x".repeat(5000), timestamp: "not-a-date" },
        { message: "no id here" }, // dropped — no usable hash
      ],
    };
    const { received, commits } = mapCommits("github", payload);
    expect(received).toBe(2); // both objects counted
    expect(commits).toHaveLength(1); // only the one with an id maps
    expect(commits[0].message).toHaveLength(4096); // clamped to the CommitInput cap
    expect(commits[0].author_date).toBeNull(); // unparseable timestamp omitted
  });

  it("returns zero commits for a payload with none", () => {
    const { received, commits } = mapCommits("github", { repository: { full_name: "octo/hello" } });
    expect(received).toBe(0);
    expect(commits).toHaveLength(0);
  });
});
