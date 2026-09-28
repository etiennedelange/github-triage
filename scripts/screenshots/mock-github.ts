// A tiny fake GitHub API: just the GraphQL and REST calls the app makes, answered from
// fixtures.ts. The screenshot Worker points GITHUB_API_URL here.

import { createServer, type Server } from "node:http";

import { ALERTS, inbox, rateLimit, userRepos, VIEWER } from "./fixtures.ts";

const AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="8" fill="#6366f1"/><text x="8" y="11.5" font-family="system-ui" font-size="9" font-weight="600" fill="#fff" text-anchor="middle">D</text></svg>`;

function graphql(query: string): unknown {
  if (query.includes("query Inbox")) return inbox();
  if (/viewer\s*{\s*login\s*}/.test(query)) return { viewer: { login: VIEWER } };
  // Anything else (the live catch-up search, team lookups): nothing new.
  const aliases = [...query.matchAll(/(\w+):\s*search\(/g)].map((m) => m[1]);
  if (aliases.length) return Object.fromEntries(aliases.map((a) => [a, { nodes: [] }]));
  return { viewer: { organizations: { nodes: [] } } };
}

/** Fix with Claude: acme/storefront runs the Claude Action; acme/api has CI only. */
const WORKFLOWS: Record<string, Record<string, string>> = {
  "acme/storefront": {
    "ci.yml": "steps:\n  - uses: actions/checkout@v4\n",
    "claude.yml": "steps:\n  - uses: anthropics/claude-code-action@v1\n",
  },
  "acme/api": { "ci.yml": "steps:\n  - uses: actions/checkout@v4\n" },
};

function rest(path: string, method = "GET"): { status: number; body: unknown } {
  const comment = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/);
  if (comment && method === "POST")
    return { status: 201, body: { html_url: `https://github.com/${comment[1]}/issues/${comment[2]}#issuecomment-1` } };
  const wf = path.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/\.github\/workflows(?:\/(.+))?$/);
  if (wf) {
    const files = WORKFLOWS[wf[1]];
    if (!files) return { status: 404, body: { message: "Not Found" } };
    if (!wf[2]) return { status: 200, body: Object.keys(files).map((name) => ({ name, path: `.github/workflows/${name}`, type: "file" })) };
    const text = files[wf[2]];
    return text ? { status: 200, body: { content: btoa(text), encoding: "base64" } } : { status: 404, body: { message: "Not Found" } };
  }
  if (path === "/rate_limit") return { status: 200, body: rateLimit() };
  if (path === "/user/repos") return { status: 200, body: userRepos() };
  const m = path.match(/^\/repos\/([^/]+\/[^/]+)\/(dependabot|code-scanning|secret-scanning)\/alerts$/);
  if (m) {
    const alerts = ALERTS[m[1]]?.[m[2] as "dependabot"];
    return alerts ? { status: 200, body: alerts } : { status: 404, body: { message: "Not Found" } };
  }
  return { status: 404, body: { message: `Not mocked: ${path}` } };
}

export function startMockGitHub(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const send = (status: number, body: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/avatar.svg") return send(200, AVATAR, "image/svg+xml");
    if (req.method === "POST" && url.pathname === "/graphql") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => send(200, { data: graphql((JSON.parse(raw) as { query: string }).query) }));
      return;
    }
    const { status, body } = rest(url.pathname, req.method);
    send(status, body);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
