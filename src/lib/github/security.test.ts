import { describe, expect, it, vi } from "vitest";

import { listInstalledRepos, scanOne } from "./security";

const dependabotAlert = (repo: string) => ({
  number: 1,
  html_url: `https://github.com/${repo}/security/dependabot/1`,
  created_at: "2026-09-01T00:00:00Z",
  security_advisory: { summary: "RCE", severity: "critical" },
  dependency: { package: { name: "x", ecosystem: "npm" } },
});

function githubFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    const body = handlers[path];
    if (body === undefined) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return Response.json(body);
  }) as unknown as typeof fetch;
}

describe("scanOne", () => {
  const auth = { token: "t" };

  it("parses open alerts and flags a full page as truncated", async () => {
    const alerts = Array.from({ length: 100 }, () => dependabotAlert("acme/api"));
    globalThis.fetch = githubFetch({ "/repos/acme/api/dependabot/alerts?state=open&per_page=100": alerts });
    const res = await scanOne(auth, "acme/api", "dependabot");
    expect(res).toMatchObject({ status: "ok", truncated: true });
    expect(res.alerts).toHaveLength(100);
    expect(res.alerts[0]).toMatchObject({ repo: "acme/api", source: "dependabot", severity: "critical" });
  });

  it("treats a 404 as the scanner being off, not an error", async () => {
    globalThis.fetch = githubFetch({});
    const res = await scanOne(auth, "acme/api", "code-scanning");
    expect(res).toEqual({ status: "disabled", message: "not found", alerts: [], truncated: false });
  });

  it("treats a 403 as a missing scope, distinct from other failures", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: "Resource not accessible" }), { status: 403 }),
    ) as unknown as typeof fetch;
    const res = await scanOne(auth, "acme/api", "secret-scanning");
    expect(res.status).toBe("forbidden");
  });

  it("surfaces other statuses as a plain error", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ message: "Server error" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const res = await scanOne(auth, "acme/api", "dependabot");
    expect(res.status).toBe("error");
  });
});

describe("listInstalledRepos", () => {
  it("paginates each installation, drops forks and archived repos, and caps the result", async () => {
    const repo = (name: string, pushed: string, extra: Partial<{ archived: boolean; fork: boolean }> = {}) => ({
      full_name: name,
      archived: false,
      fork: false,
      pushed_at: pushed,
      ...extra,
    });
    globalThis.fetch = githubFetch({
      "/user/installations?per_page=100": { installations: [{ id: 1 }] },
      "/user/installations/1/repositories?per_page=100&page=1": {
        total_count: 3,
        repositories: [
          repo("acme/old", "2026-01-01T00:00:00Z"),
          repo("acme/fork", "2026-06-01T00:00:00Z", { fork: true }),
          repo("acme/new", "2026-09-01T00:00:00Z"),
        ],
      },
    });
    const repos = await listInstalledRepos({ token: "t" }, 1);
    expect(repos).toEqual(["acme/new"]);
  });
});
