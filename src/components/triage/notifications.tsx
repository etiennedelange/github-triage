import { Bell, BellOff } from "lucide-react";
import { useEffect } from "react";

import { disablePush, enablePush, initPush, usePush } from "@/client/push";

const LABEL = { on: "On", off: "Off", busy: "…", blocked: "Blocked", unsupported: "" } as const;

/**
 * Desktop notifications, in the status bar with the other preferences. They arrive with the tab
 * closed, as long as Chrome is running; a focused tab doesn't get them, it has the live board.
 */
export function NotificationsToggle() {
  const { status, error } = usePush();
  useEffect(() => void initPush(), []);
  if (status === "unsupported") return null;
  const Icon = status === "on" ? Bell : BellOff;
  const hint =
    error ??
    (status === "blocked"
      ? "Blocked for this site: allow notifications in the browser's site settings, then reload"
      : status === "on"
        ? "Review requests, assignments, mentions, new PRs and issues in your repos, security alerts and Claude runs, even with the tab closed"
        : "Get a desktop notification for review requests, mentions, security alerts and more, even with the tab closed");
  return (
    <button
      type="button"
      disabled={status === "busy" || status === "blocked"}
      onClick={() => void (status === "on" ? disablePush() : enablePush())}
      title={hint}
      aria-label={`Desktop notifications: ${LABEL[status]}. ${hint}`}
      className="-my-1 inline-flex items-center gap-1 py-1 hover:text-foreground disabled:hover:text-muted-foreground"
    >
      <Icon aria-hidden className="size-3" />
      Notifications: {LABEL[status]}
      {error && <span className="text-destructive">(failed)</span>}
    </button>
  );
}
