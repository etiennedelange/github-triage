// Messages on the /api/live WebSocket, shared by the Hub Durable Object and the browser.

import { z } from "zod";

import type { InboxSection, Issue, PullRequest, SecurityAlert } from "@/lib/triage";

/** Server → browser. `seq` increases by one per broadcast; a gap means a message was missed. */
export type ServerMessage =
  | { type: "welcome"; seq: number }
  | { type: "resync"; seq: number }
  /** An item's current state and the sections it now belongs in (empty = remove it everywhere). */
  | { type: "item"; seq: number; at: number; item: PullRequest | Issue; sections: InboxSection[] }
  /** Gone or no longer readable (deleted, transferred, access lost): remove every URL listed. */
  | { type: "gone"; seq: number; at: number; urls: string[] }
  | { type: "alert"; seq: number; at: number; alert: SecurityAlert }
  | { type: "alert-gone"; seq: number; at: number; url: string };

/** Browser → server, sent on every (re)connect with the snapshot the page was rendered from. */
export const clientHello = z.object({ type: z.literal("hello"), fetchedAt: z.string() });
export type ClientHello = z.infer<typeof clientHello>;

// Minimal envelope check on the browser side; the Hub is trusted for the payload itself.
export const serverEnvelope = z.looseObject({
  type: z.enum(["welcome", "resync", "item", "gone", "alert", "alert-gone"]),
  seq: z.number(),
});
