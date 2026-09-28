import { describe, expect, it, vi } from "vitest";

import type { ClaudeRun } from "@/lib/claude";

import { fetchRunProgress } from "./claude";

function githubFetch(handlers: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const body = handlers[url.pathname + url.search];
    if (body === undefined) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    return Response.json(body);
  }) as unknown as typeof fetch;
}

const run: ClaudeRun = {
  repo: "acme/notes",
  number: 6,
  state: "requested",
  requestedAt: "2026-09-28T09:45:42.389Z",
  updatedAt: "2026-09-28T09:45:42.389Z",
  commentUrl: "https://github.com/acme/notes/issues/6#issuecomment-1",
};
const comments = `/repos/acme/notes/issues/6/comments?since=${encodeURIComponent(run.requestedAt)}&per_page=100`;
const refs = "/repos/acme/notes/git/matching-refs/heads/claude/issue-6-";
const pulls = (branch: string) => `/repos/acme/notes/pulls?head=${encodeURIComponent(`acme:${branch}`)}&state=all&per_page=1`;

describe("fetchRunProgress", () => {
  const auth = { token: "t" };

  it("finds Claude's comment and this run's branch, not an older run's", async () => {
    globalThis.fetch = githubFetch({
      [comments]: [{ user: { login: "you" } }, { user: { login: "claude[bot]" } }],
      [refs]: [{ ref: "refs/heads/claude/issue-6-20260901-1200" }, { ref: "refs/heads/claude/issue-6-20260928-0945" }],
      [pulls("claude/issue-6-20260928-0945")]: [],
    });
    expect(await fetchRunProgress(auth, run)).toEqual([
      { kind: "working", repo: "acme/notes", number: 6 },
      { kind: "branch", repo: "acme/notes", number: 6, branch: "claude/issue-6-20260928-0945" },
    ]);
  });

  it("only looks for a PR once the branch is known", async () => {
    const branch = "claude/issue-6-20260928-0946";
    const fetchMock = githubFetch({ [pulls(branch)]: [{ html_url: "https://github.com/acme/notes/pull/7" }] });
    globalThis.fetch = fetchMock;
    expect(await fetchRunProgress(auth, { ...run, state: "branch", branch })).toEqual([
      { kind: "pr", repo: "acme/notes", number: 6, url: "https://github.com/acme/notes/pull/7" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
