// Which webhooks are worth a desktop notification, from the payload alone: the Hub sends these
// with no tab open, when it fetches nothing. Pure; no I/O.

import { z } from "zod";

import { runLink, type ClaudeRun } from "@/lib/claude";
import type { SecurityAlert } from "@/lib/triage";

import type { Change } from "./events";
import type { PushMessage } from "./push";

/** Who "you" are: your login, owners whose repos count as yours, teams whose review requests do. */
export type NoticeContext = { viewer: string; owners: string[]; teams: string[] };

const user = z.looseObject({ login: z.string() });
const payload = z.looseObject({
  action: z.string().optional(),
  repository: z.looseObject({ full_name: z.string() }).optional(),
  sender: user.optional(),
  requested_reviewer: user.nullish(),
  requested_team: z.looseObject({ slug: z.string() }).nullish(),
  assignee: user.nullish(),
  pull_request: z.looseObject({ number: z.number(), title: z.string(), html_url: z.string(), user }).optional(),
  issue: z.looseObject({ number: z.number(), title: z.string(), html_url: z.string(), user }).optional(),
  review: z.looseObject({ state: z.string(), html_url: z.string() }).optional(),
  comment: z.looseObject({ body: z.string().nullish(), html_url: z.string() }).optional(),
});

/** Alert actions that mean "new to you", not a re-read of one you already know about. */
const NEW_ALERT = ["created", "reintroduced", "publicly_leaked"];

const REVIEW_WORDS: Record<string, string> = { approved: "approved", changes_requested: "requested changes on" };

const isBot = (login: string) => login.endsWith("[bot]");

/** Notifications for one webhook delivery. `changes` is what `changesFor` made of it. */
export function noticesFor(event: string, raw: unknown, changes: Change[], ctx: NoticeContext): PushMessage[] {
  const parsed = payload.safeParse(raw);
  if (!parsed.success) return [];
  const p = parsed.data;
  const repo = p.repository?.full_name;
  const eq = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
  const isMe = (login: string | undefined) => eq(login, ctx.viewer);
  const sender = p.sender?.login ?? "someone";
  // Your own actions never notify you.
  if (!repo || isMe(p.sender?.login)) return [];

  const subject = p.pull_request ?? p.issue;
  const item = (verb: string) =>
    subject && {
      title: `@${sender} ${verb} ${repo}#${subject.number}`,
      body: subject.title,
      url: subject.html_url,
      tag: subject.html_url,
    };

  switch (event) {
    case "pull_request":
    case "issues": {
      if (!subject) return [];
      const kind = event === "issues" ? "issue" : "PR";
      if (p.action === "review_requested") {
        const team = p.requested_team && `${repo.split("/")[0]}/${p.requested_team.slug}`;
        const forYou = isMe(p.requested_reviewer?.login) || (team && ctx.teams.some((t) => eq(t, team)));
        return forYou ? [item("requested your review on")!] : [];
      }
      if (p.action === "assigned") return isMe(p.assignee?.login) ? [item(`assigned you ${kind}`)!] : [];
      // What lands in Incoming and Untriaged. Dependabot's PRs come with an alert of their own.
      const owned = ctx.owners.some((o) => eq(o, repo.split("/")[0]));
      if (p.action === "opened" && owned && !isBot(sender)) return [item(`opened ${kind}`)!];
      return [];
    }

    case "pull_request_review": {
      const verb = REVIEW_WORDS[p.review?.state.toLowerCase() ?? ""];
      if (p.action !== "submitted" || !verb || !p.pull_request || !isMe(p.pull_request.user.login)) return [];
      return [{ ...item(`${verb} your PR`)!, url: p.review!.html_url }];
    }

    // Mentions anywhere, and comments on what you opened; bots (CI, the Claude Action) are too chatty.
    case "issue_comment": {
      if (p.action !== "created" || !p.issue || !p.comment || isBot(sender)) return [];
      const body = p.comment.body ?? "";
      const mentioned = new RegExp(`(^|[^\\w/-])@${ctx.viewer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(body);
      const yours = isMe(p.issue.user.login);
      if (!mentioned && !yours) return [];
      const n = item(mentioned ? "mentioned you on" : "commented on")!;
      return [{ ...n, body: `${p.issue.title}\n${excerpt(body)}`, url: p.comment.html_url }];
    }

    case "dependabot_alert":
    case "code_scanning_alert":
    case "secret_scanning_alert": {
      if (!NEW_ALERT.includes(p.action ?? "")) return [];
      return changes.flatMap((c) => (c.kind === "alert" ? [alertNotice(c.alert)] : []));
    }

    default:
      return [];
  }
}

export function alertNotice(alert: SecurityAlert): PushMessage {
  const severity = alert.severity === "unknown" ? "" : `${alert.severity[0].toUpperCase()}${alert.severity.slice(1)} `;
  return { title: `${severity}security alert in ${alert.repo}`, body: alert.title, url: alert.url, tag: alert.url };
}

/** A Fix with Claude run that just reached a branch or a PR. */
export function claudeNotice(run: ClaudeRun): PushMessage | undefined {
  const where = `${run.repo}#${run.number}`;
  if (run.state === "branch")
    return {
      title: `Claude pushed a branch for ${where}`,
      body: "Open it to review and create the PR",
      url: runLink(run),
      tag: `claude:${where}`,
    };
  if (run.state === "pr")
    return { title: `Claude opened a PR for ${where}`, body: "Ready for review", url: runLink(run), tag: `claude:${where}` };
  return undefined;
}

function excerpt(body: string, max = 140): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
