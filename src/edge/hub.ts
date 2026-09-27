import { DurableObject } from "cloudflare:workers";

import { GitHubError, mapLimit, type GitHubAuth } from "@/lib/github/http";
import { fetchInbox, fetchRateLimits, fetchViewerLogin, type Inbox, type RateLimits } from "@/lib/github/inbox";
import { asResult, MissingTokenError, ScanPendingError, type Result } from "@/lib/github/result";
import { listInstalledRepos, listOwnedRepos, scanOne, SCANNERS, type SecurityReport } from "@/lib/github/security";
import { sectionsFor, type AlertSource, type Issue, type PullRequest, type ScannerStatus, type SectionContext } from "@/lib/triage";

import { splitList, type EdgeEnv } from "./env";
import { changesFor, type SubjectKey } from "./events";
import { clientHello, type ServerMessage } from "./protocol";
import { fetchAlert, fetchOpenPrs, fetchRecentlyUpdated, fetchSubjects, fetchTeams, subjectUrls } from "./refetch";
import { TokenKeeper, type StoredTokens } from "./tokens";

/** Coalesce bursts (a check-suite storm, a PR opened with labels and reviewers) into one fetch. */
const DEBOUNCE_MS = 1_500;
/** Mergeability is computed lazily after a push; look again once GitHub has worked it out. */
const MERGEABLE_RECHECK_MS = 30_000;
/** Catch-up search for repos without the App, only while a tab is open. */
const POLL_MS = 120_000;
/** Search indexing lags; overlap windows so nothing slips between polls. Duplicates are harmless. */
const POLL_OVERLAP_MS = 5 * 60_000;
const TEAMS_TTL_MS = 24 * 3_600_000;
/** The stored inbox is served for this long; Refresh and webhook events end it early. */
const INBOX_MAX_AGE_MS = 60_000;
const DELIVERIES_KEPT = 200;

/** A security scan is redone once the last one is this old. */
const SECURITY_SCAN_INTERVAL_MS = 15 * 60_000;
/** Repo/scanner calls done per alarm tick: bounded well under any Workers subrequest cap. */
const SECURITY_SCAN_CHUNK = 15;
const SECURITY_SCAN_TICK_MS = 2_000;

/** Checkpoint for a scan in progress: resumed one bounded chunk at a time across alarm ticks. */
type SecurityJob = {
  repos: string[];
  sources: AlertSource[];
  index: number;
  alerts: SecurityReport["alerts"];
  repoScanners: Record<string, Record<AlertSource, { status: ScannerStatus; message?: string }>>;
  truncated: string[];
};

/** Queue keys: a subject ("o/r#12"), or every open PR in a repo ("prs:o/r", rechecked once as "prs2:o/r"). */
type QueueKey = SubjectKey | `prs:${string}` | `prs2:${string}`;

type Distribute<T> = T extends unknown ? Omit<T, "seq"> : never;
type Outgoing = Distribute<ServerMessage>;

/**
 * One per deployment (single user). Owns the OAuth tokens, the browsers' WebSockets
 * (hibernatable, so idle tabs cost nothing) and the change pipeline:
 * webhook/poll → debounced queue → one batched GraphQL read → per-item deltas.
 * With no tab connected it only notes that something changed.
 */
export class Hub extends DurableObject<EdgeEnv> {
  private readonly tokens: TokenKeeper;
  /** Broadcast counter, mirrored to storage so it survives hibernation without gaps. */
  private seq = 0;

  constructor(ctx: DurableObjectState, env: EdgeEnv) {
    super(ctx, env);
    const storage = ctx.storage;
    void ctx.blockConcurrencyWhile(async () => {
      this.seq = (await storage.get<number>("seq")) ?? 0;
    });
    this.tokens = new TokenKeeper(
      {
        get: () => storage.get<StoredTokens>("tokens"),
        put: (t) => storage.put("tokens", t),
        delete: async () => void (await storage.delete("tokens")),
      },
      { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    );
  }

  // ---------- RPC: tokens (the Worker's OAuth handlers store them; only the Hub reads them) ----------

  async saveTokens(tokens: StoredTokens): Promise<void> {
    await this.ctx.storage.put("tokens", tokens);
    await this.ctx.storage.delete("teams");
  }

  async signOut(): Promise<void> {
    await this.ctx.storage.delete(["tokens", "teams", "inbox"]);
    for (const ws of this.ctx.getWebSockets()) ws.close(4001, "Signed out");
  }

  // ---------- RPC: webhooks ----------

  async webhook(delivery: string, event: string, payload: unknown): Promise<void> {
    const seen = (await this.ctx.storage.get<string[]>("deliveries")) ?? [];
    if (delivery && seen.includes(delivery)) return;
    await this.ctx.storage.put("deliveries", [...seen.slice(-(DELIVERIES_KEPT - 1)), delivery]);

    const changes = changesFor(event, payload);
    if (!changes.length) return;
    const at = Date.now();
    await this.ctx.storage.put("lastEventAt", at);
    // The stored inbox may now be out of date: the next page load refetches it.
    await this.ctx.storage.delete("inbox");
    // Nobody watching: a tab that opens later sees lastEventAt and resyncs once.
    if (!this.ctx.getWebSockets().length) return;

    const keys: QueueKey[] = [];
    for (const c of changes) {
      if (c.kind === "subject") keys.push(c.key);
      else if (c.kind === "repo-prs") keys.push(`prs:${c.repo}`);
      else if (c.kind === "alert") this.broadcast({ type: "alert", at, alert: c.alert });
      else if (c.kind === "alert-gone") this.broadcast({ type: "alert-gone", at, url: c.url });
      else if (c.kind === "resync") this.broadcast({ type: "resync" });
      else if (c.kind === "alert-refetch") {
        const alert = await this.withAuth((auth) => fetchAlert(auth, c.repo, c.source, c.number)).catch(() => undefined);
        if (alert) this.broadcast({ type: "alert", at, alert });
      }
    }
    if (keys.length) await this.enqueue(keys, DEBOUNCE_MS);
  }

  // ---------- RPC: dashboard data (the Hub is the app's only cache) ----------

  /**
   * The inbox, from storage while it's under a minute old; `force` (Refresh) refetches.
   * Concurrent callers may each refetch: sharing one in-flight promise across requests is
   * exactly what hangs on Workers, and a duplicate GraphQL call is cheap.
   */
  getInbox(force = false): Promise<Result<Inbox>> {
    return asResult(async () => {
      const cached = await this.ctx.storage.get<Inbox>("inbox");
      if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < INBOX_MAX_AGE_MS) return cached;
      const viewer = await this.viewerLogin();
      const inbox = await this.withAuth((auth) => fetchInbox(auth, [viewer, ...splitList(this.env.TRIAGE_OWNERS)]));
      await this.ctx.storage.put("inbox", inbox);
      return inbox;
    });
  }

  /** Live, uncached: `/rate_limit` costs nothing against either budget. */
  getRateLimits(): Promise<Result<RateLimits>> {
    return asResult(() => this.withAuth(fetchRateLimits));
  }

  /** Latest completed scan, kicking off a new one in the background if there isn't a fresh enough one. */
  getSecurity(): Promise<Result<SecurityReport>> {
    return asResult(async () => {
      const report = await this.ctx.storage.get<SecurityReport>("securityReport");
      const job = await this.ctx.storage.get<SecurityJob>("securityJob");
      const stale = !report || Date.now() - Date.parse(report.scannedAt) > SECURITY_SCAN_INTERVAL_MS;
      if (stale && !job) await this.startSecurityScan();
      if (!report) throw new ScanPendingError();
      return report;
    });
  }

  private async startSecurityScan(): Promise<void> {
    const max = Number(this.env.TRIAGE_MAX_REPOS) || 50;
    const owners = [await this.viewerLogin(), ...splitList(this.env.TRIAGE_OWNERS)];
    const repos = await this.withAuth((auth) => (this.localMode ? listOwnedRepos(auth, owners, max) : listInstalledRepos(auth, max))).catch(
      () => [] as string[],
    );
    if (!repos.length) return;
    const job: SecurityJob = { repos, sources: Object.keys(SCANNERS) as AlertSource[], index: 0, alerts: [], repoScanners: {}, truncated: [] };
    await this.ctx.storage.put("securityJob", job);
    await this.schedule();
  }

  /** One bounded batch of repo/scanner calls, resumed from `job.index` on the next tick if not done. */
  private async continueSecurityScan(job: SecurityJob): Promise<void> {
    const jobs = job.repos.flatMap((repo) => job.sources.map((source) => ({ repo, source })));
    const end = Math.min(job.index + SECURITY_SCAN_CHUNK, jobs.length);
    const slice = jobs.slice(job.index, end);
    const results = await mapLimit(slice, 5, ({ repo, source }) => this.withAuth((auth) => scanOne(auth, repo, source)));
    slice.forEach(({ repo, source }, i) => {
      const res = results[i];
      (job.repoScanners[repo] ??= {} as Record<AlertSource, { status: ScannerStatus; message?: string }>)[source] = {
        status: res.status,
        message: res.message,
      };
      job.alerts.push(...res.alerts);
      if (res.truncated) job.truncated.push(`${repo} (${source})`);
    });
    job.index = end;

    if (job.index < jobs.length) {
      await this.ctx.storage.put("securityJob", job);
      return;
    }
    const report: SecurityReport = {
      alerts: job.alerts,
      repos: job.repos.map((repo) => ({ repo, scanners: job.repoScanners[repo] })),
      truncated: job.truncated,
      scannedAt: new Date().toISOString(),
    };
    await this.ctx.storage.put("securityReport", report);
    await this.ctx.storage.delete("securityJob");
  }

  // ---------- WebSockets ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const hello = clientHello.safeParse(typeof message === "string" ? safeJson(message) : null);
    if (!hello.success) return;
    const seq = this.seq;
    const lastEventAt = (await this.ctx.storage.get<number>("lastEventAt")) ?? 0;
    const stale = lastEventAt > Date.parse(hello.data.fetchedAt);
    ws.send(JSON.stringify({ type: stale ? "resync" : "welcome", seq } satisfies ServerMessage));

    // First watcher: start the catch-up poll from now.
    if (!(await this.ctx.storage.get<number>("nextPollAt"))) {
      await this.ctx.storage.put({ nextPollAt: Date.now() + POLL_MS, pollSince: Date.now() - POLL_OVERLAP_MS });
      await this.schedule();
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "Closed");
    } catch {
      // already closed
    }
  }

  // ---------- Queue & alarm ----------

  private async enqueue(keys: QueueKey[], delay: number): Promise<void> {
    const queue = (await this.ctx.storage.get<Record<string, number>>("queue")) ?? {};
    const due = Date.now() + delay;
    for (const k of keys) queue[k] = Math.min(queue[k] ?? Infinity, due);
    await this.ctx.storage.put("queue", queue);
    await this.schedule();
  }

  /**
   * One alarm serves the debounce queue, the poll and the security scan; with no tabs open
   * and no scan running, only queued work keeps it alive.
   */
  private async schedule(): Promise<void> {
    const queue = (await this.ctx.storage.get<Record<string, number>>("queue")) ?? {};
    const watching = this.ctx.getWebSockets().length > 0;
    const nextPollAt = watching ? ((await this.ctx.storage.get<number>("nextPollAt")) ?? Infinity) : Infinity;
    // A scan runs to completion (across ticks) even after the last tab closes.
    const nextScanAt = (await this.ctx.storage.get<SecurityJob>("securityJob")) ? Date.now() + SECURITY_SCAN_TICK_MS : Infinity;
    const next = Math.min(nextPollAt, nextScanAt, ...Object.values(queue));
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const queue = (await this.ctx.storage.get<Record<string, number>>("queue")) ?? {};
    const due = Object.keys(queue).filter((k) => queue[k] <= now + 50) as QueueKey[];
    for (const k of due) delete queue[k];
    await this.ctx.storage.put("queue", queue);

    const watching = this.ctx.getWebSockets().length > 0;
    if (!watching) {
      await this.ctx.storage.delete(["nextPollAt", "pollSince"]);
    } else {
      try {
        if (due.length) await this.flush(due);
        if (((await this.ctx.storage.get<number>("nextPollAt")) ?? Infinity) <= now) await this.poll(now);
      } catch (err) {
        // Token gone or GitHub down: the tab falls back to its snapshot; a later event retries.
        console.error("hub: flush/poll failed", err);
      }
    }

    const job = await this.ctx.storage.get<SecurityJob>("securityJob");
    if (job) {
      try {
        await this.continueSecurityScan(job);
      } catch (err) {
        // Token gone or GitHub down: drop the checkpoint; the next getSecurity() retries.
        console.error("hub: security scan failed", err);
        await this.ctx.storage.delete("securityJob");
      }
    }
    await this.schedule();
  }

  private async flush(keys: QueueKey[]): Promise<void> {
    const subjects = keys.filter((k): k is SubjectKey => !k.startsWith("prs"));
    const ctx = await this.sectionContext();
    const at = Date.now();

    if (subjects.length) {
      const items = await this.withAuth((auth) => fetchSubjects(auth, subjects));
      for (const [key, item] of items) {
        if (item) this.sendItem(item, ctx, at);
        else this.broadcast({ type: "gone", at, urls: subjectUrls(key) });
      }
    }

    for (const k of keys.filter((k) => k.startsWith("prs"))) {
      const [kind, repo] = k.split(/:(.*)/) as [string, string];
      const prs = await this.withAuth((auth) => fetchOpenPrs(auth, repo));
      // Only PRs you'd see anyway; a push doesn't move others into your inbox.
      for (const pr of prs) if (sectionsFor(pr, ctx).length) this.sendItem(pr, ctx, at);
      if (kind === "prs") await this.enqueue([`prs2:${repo}`], MERGEABLE_RECHECK_MS);
    }
  }

  private async poll(now: number): Promise<void> {
    const since = (await this.ctx.storage.get<number>("pollSince")) ?? now - POLL_OVERLAP_MS;
    await this.ctx.storage.put({ nextPollAt: now + POLL_MS, pollSince: now - POLL_OVERLAP_MS });
    const iso = new Date(since).toISOString().replace(/\.\d{3}Z$/, "Z");
    const [items, ctx] = await Promise.all([this.withAuth((auth) => fetchRecentlyUpdated(auth, iso)), this.sectionContext()]);
    for (const item of items) this.sendItem(item, ctx, now);
  }

  private sendItem(item: PullRequest | Issue, ctx: SectionContext, at: number): void {
    this.broadcast({ type: "item", at, item, sections: sectionsFor(item, ctx) });
  }

  private broadcast(msg: Outgoing): void {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    // Storage writes are ordered and cached in memory, so no await is needed here.
    const seq = ++this.seq;
    void this.ctx.storage.put("seq", seq);
    const data = JSON.stringify({ ...msg, seq });
    for (const ws of sockets) {
      try {
        ws.send(data);
      } catch {
        // closing; its client will resync on reconnect
      }
    }
  }

  // ---------- GitHub ----------

  /** No GitHub App configured: local development with a personal token from `.dev.vars`. */
  private get localMode(): boolean {
    return !this.env.GITHUB_CLIENT_ID;
  }

  private async withAuth<T>(fn: (auth: GitHubAuth) => Promise<T>): Promise<T> {
    const api = this.env.GITHUB_API_URL || undefined;
    if (this.localMode) {
      const token = this.env.GITHUB_TOKEN?.trim();
      if (!token) throw new MissingTokenError("No GitHub token. Put GITHUB_TOKEN in .dev.vars (see .dev.vars.example).");
      return fn({ token, api });
    }
    const token = await this.tokens.get();
    if (!token) throw new MissingTokenError();
    try {
      return await fn({ token, api });
    } catch (err) {
      if (!(err instanceof GitHubError && err.status === 401)) throw err;
      const fresh = await this.tokens.get(true);
      if (!fresh) throw err;
      return fn({ token: fresh, api });
    }
  }

  /** Signed-in login (OAuth), or the personal token's owner (local mode, looked up once). */
  private async viewerLogin(): Promise<string> {
    if (!this.localMode) {
      const tokens = await this.ctx.storage.get<StoredTokens>("tokens");
      if (!tokens) throw new MissingTokenError();
      return tokens.login;
    }
    let login = await this.ctx.storage.get<string>("localLogin");
    if (!login) {
      login = await this.withAuth(fetchViewerLogin);
      await this.ctx.storage.put("localLogin", login);
    }
    return login;
  }

  private async sectionContext(): Promise<SectionContext> {
    const viewer = await this.viewerLogin();
    let teams = await this.ctx.storage.get<{ list: string[]; at: number }>("teams");
    if (!teams || Date.now() - teams.at > TEAMS_TTL_MS) {
      const list = await this.withAuth((auth) => fetchTeams(auth, viewer)).catch(() => teams?.list ?? []);
      teams = { list, at: Date.now() };
      await this.ctx.storage.put("teams", teams);
    }
    return { viewer, owners: [viewer, ...splitList(this.env.TRIAGE_OWNERS)], teams: teams.list };
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
