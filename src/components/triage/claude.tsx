import { Sparkles } from "lucide-react";
import { useState } from "react";

import { requestClaude, useClaudeRuns, useClaudeSetup } from "@/client/api";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { claudeKey, defaultPrompt, runLink, TRIGGER, type ClaudeRun, type ClaudeState, type ClaudeStatus } from "@/lib/claude";
import type { Failure } from "@/lib/github/result";
import type { Issue } from "@/lib/triage";

import { Pill, type Tone } from "./rows";

/**
 * "Fix with Claude" on an issue row: a button that opens an editable @claude comment, or,
 * once you've asked, where the run has got to.
 */
export function ClaudeAction({ issue }: { issue: Issue }) {
  const { data } = useClaudeRuns();
  const run = data?.ok ? data.data[claudeKey(issue.repo, issue.number)] : undefined;
  if (run) return <RunPill run={run} />;
  return (
    <>
      {issue.claude && <ClaudeStatusPill status={issue.claude} />}
      <AskClaude issue={issue} />
    </>
  );
}

const STATUS: Record<ClaudeStatus["state"], { label: string; tone: Tone; hint: string }> = {
  asked: { label: "Asked Claude", tone: "muted", hint: "An @claude comment is waiting for the Claude Action to pick it up" },
  working: { label: "Claude working", tone: "info", hint: "The Claude Action is working on the latest @claude request" },
  done: { label: "Claude replied", tone: "success", hint: "The Claude Action finished the latest @claude request" },
  error: { label: "Claude failed", tone: "danger", hint: "The Claude Action hit an error on the latest @claude request" },
};

/** Where the newest @claude comment on a PR or issue has got, whoever posted it and wherever. */
export function ClaudeStatusPill({ status }: { status: ClaudeStatus }) {
  const s = STATUS[status.state];
  return (
    <a href={status.url} target="_blank" rel="noreferrer" title={s.hint} className="hover:opacity-80">
      <Pill tone={s.tone}>
        <Sparkles aria-hidden className="mr-1 size-3" />
        {s.label}
      </Pill>
    </a>
  );
}

const STATE: Record<ClaudeState, { label: string; tone: Tone; hint: string }> = {
  requested: { label: "Asked Claude", tone: "muted", hint: "Comment posted; waiting for the Claude Action to pick it up" },
  working: { label: "Claude working", tone: "info", hint: "The Claude Action is working on it" },
  branch: { label: "Branch ready", tone: "success", hint: "Claude pushed a branch: open it to review and create the PR" },
  pr: { label: "PR opened", tone: "success", hint: "The pull request from Claude's branch" },
};

function RunPill({ run }: { run: ClaudeRun }) {
  const s = STATE[run.state];
  return (
    <a href={runLink(run)} target="_blank" rel="noreferrer" title={s.hint} className="hover:opacity-80">
      <Pill tone={s.tone}>
        <Sparkles aria-hidden className="mr-1 size-3" />
        {s.label}
      </Pill>
    </a>
  );
}

function AskClaude({ issue }: { issue: Issue }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => defaultPrompt(issue.title));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const setup = useClaudeSetup(issue.repo, open);
  const ready = setup.data?.ok && setup.data.data;
  const canSend = ready && draft.includes(TRIGGER) && !sending;

  async function send() {
    if (!canSend) return;
    setSending(true);
    setError(undefined);
    try {
      const res = await requestClaude(issue.repo, issue.number, draft);
      // On success the row swaps to the run's pill, which unmounts this popover.
      if (!res.ok) setError(describe(res.error));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label="Fix with Claude" className="text-muted-foreground">
              <Sparkles aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Fix with Claude</TooltipContent>
      </Tooltip>
      <PopoverContent className="space-y-2">
        <div className="text-sm font-medium">Fix with Claude</div>
        <SetupLine setup={setup} repo={issue.repo} />
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            Comment to post on {issue.repo}#{issue.number}
          </span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
            }}
            rows={5}
            className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
        {!draft.includes(TRIGGER) && <p className="text-xs text-orange">The Action only answers comments containing {TRIGGER}.</p>}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">Starts a paid Action run.</span>
          <Button size="xs" disabled={!canSend} onClick={() => void send()}>
            {sending ? "Posting…" : "Post comment"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SetupLine({ setup, repo }: { setup: ReturnType<typeof useClaudeSetup>; repo: string }) {
  if (setup.isPending) return <p className="text-xs text-muted-foreground">Checking {repo} for the Claude Action…</p>;
  if (setup.isError) return <p className="text-xs text-destructive">Couldn't check the repo's workflows: {setup.error.message}</p>;
  if (!setup.data.ok) return <p className="text-xs text-destructive">Couldn't check the repo's workflows: {describe(setup.data.error)}</p>;
  if (setup.data.data) return null;
  return (
    <p className="text-xs text-orange">
      No workflow in {repo} uses the Claude Action, so nothing would answer. Set it up by running{" "}
      <code className="font-mono">/install-github-app</code> in Claude Code in that repo.
    </p>
  );
}

function describe(error: Failure): string {
  if (error.kind === "github" && error.status === 403) {
    return `GitHub refused (${error.message}). The app needs write access to issues: accept the App's new Issues permission, or use a token with it.`;
  }
  return error.message;
}
