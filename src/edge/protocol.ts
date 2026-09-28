// Messages on the /api/live WebSocket, shared by the Hub Durable Object and the browser.

import { z } from "zod";

import type { InboxSection, Issue, PullRequest, SecurityAlert } from "@/lib/triage";

/** Server → browser. `seq` increases by one per broadcast; a gap means a message was missed. */
export type ServerMessage =
  /** `build`: the deployed app's build ID. A tab built from another one should reload. */
  | { type: "welcome"; seq: number; build: string }
  | { type: "resync"; seq: number; build: string }
  /** An item's current state and the sections it now belongs in (empty = remove it everywhere). */
  | { type: "item"; seq: number; at: number; item: PullRequest | Issue; sections: InboxSection[] }
  /** Gone or no longer readable (deleted, transferred, access lost): remove every URL listed. */
  | { type: "gone"; seq: number; at: number; urls: string[] }
  | { type: "alert"; seq: number; at: number; alert: SecurityAlert }
  | { type: "alert-gone"; seq: number; at: number; url: string }
  /** Stars changed: refetch the activity panel. */
  | { type: "activity"; seq: number; at: number }
  /** A "Fix with Claude" run changed: refetch the runs. */
  | { type: "claude"; seq: number; at: number };

/** Browser → server, sent on every (re)connect with the snapshot the page was rendered from. */
export const clientHello = z.object({ type: z.literal("hello"), fetchedAt: z.string() });
export type ClientHello = z.infer<typeof clientHello>;

// Minimal envelope check on the browser side; the Hub is trusted for the payload itself.
export const serverEnvelope = z.looseObject({
  type: z.enum(["welcome", "resync", "item", "gone", "alert", "alert-gone", "activity", "claude"]),
  seq: z.number(),
});
