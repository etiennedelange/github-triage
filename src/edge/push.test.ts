import { describe, expect, it } from "vite-plus/test";

import type { ClaudeRun } from "@/lib/claude";

import { changesFor } from "./events";
import { claudeNotice, noticesFor, type NoticeContext } from "./notices";
import { encryptPayload, fromBase64Url, generateVapidKeys, toBase64Url, vapidAuthorization, type PushSubscriptionJSON } from "./push";

const enc = new TextEncoder();
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** A browser's side of RFC 8291: a subscription, and decrypting what's sent to it. */
async function browser() {
  const pair = (await crypto.subtle.generateKey(ECDH, true, ["deriveBits"])) as CryptoKeyPair;
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: PushSubscriptionJSON = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: toBase64Url(uaPublic), auth: toBase64Url(auth) },
  };
  async function decrypt(body: Uint8Array<ArrayBuffer>): Promise<string> {
    const salt = body.slice(0, 16);
    const idlen = body[20];
    const asPublic = body.slice(21, 21 + idlen);
    const peer = await crypto.subtle.importKey("raw", asPublic, ECDH, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, pair.privateKey, 256));
    const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
    const ikm = await hkdf(auth, shared, info, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, body.slice(21 + idlen)));
    expect(plain.at(-1)).toBe(2);
    return new TextDecoder().decode(plain.slice(0, -1));
  }
  return { sub, decrypt };
}

describe("web push", () => {
  it("encrypts a message only the subscribed browser can read", async () => {
    const { sub, decrypt } = await browser();
    const body = await encryptPayload(sub, '{"title":"héllo"}');
    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(await decrypt(body)).toBe('{"title":"héllo"}');

    const other = await browser();
    await expect(other.decrypt(body)).rejects.toThrow();
  });

  it("signs a VAPID token for the push service's origin with the key it advertises", async () => {
    const keys = await generateVapidKeys();
    const header = await vapidAuthorization(keys, "https://fcm.googleapis.com/fcm/send/abc", "https://triage.example", 1_000_000);
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(c)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1000 + 12 * 3600,
      sub: "https://triage.example",
    });
    const pub = await crypto.subtle.importKey("raw", fromBase64Url(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, fromBase64Url(s), enc.encode(`${h}.${c}`))).toBe(true);
  });
});

describe("notices", () => {
  const ctx: NoticeContext = { viewer: "octocat", owners: ["octocat", "acme"], teams: ["acme/core"] };
  const repository = { full_name: "acme/api" };
  const pr = { number: 7, title: "Fix it", html_url: "https://github.com/acme/api/pull/7", user: { login: "hubot" } };
  const issue = { number: 3, title: "Broken", html_url: "https://github.com/acme/api/issues/3", user: { login: "octocat" } };
  const notices = (event: string, p: object) => noticesFor(event, p, changesFor(event, p), ctx);

  it("notifies review requests for you or your team, not for others", () => {
    const base = { action: "review_requested", repository, pull_request: pr, sender: { login: "hubot" } };
    expect(notices("pull_request", { ...base, requested_reviewer: { login: "OctoCat" } })).toEqual([
      { title: "@hubot requested your review on acme/api#7", body: "Fix it", url: pr.html_url, tag: pr.html_url },
    ]);
    expect(notices("pull_request", { ...base, requested_team: { slug: "core" } })).toHaveLength(1);
    expect(notices("pull_request", { ...base, requested_reviewer: { login: "someone" } })).toEqual([]);
  });

  it("never notifies you about what you did yourself", () => {
    const p = { action: "assigned", repository, issue, assignee: { login: "octocat" }, sender: { login: "octocat" } };
    expect(notices("issues", p)).toEqual([]);
    expect(notices("issues", { ...p, sender: { login: "hubot" } })[0].title).toBe("@hubot assigned you issue acme/api#3");
  });

  it("notifies new PRs and issues in your repos, but not from bots or elsewhere", () => {
    const p = { action: "opened", repository, pull_request: pr, sender: { login: "hubot" } };
    expect(notices("pull_request", p)[0].title).toBe("@hubot opened PR acme/api#7");
    expect(notices("pull_request", { ...p, sender: { login: "dependabot[bot]" } })).toEqual([]);
    expect(notices("pull_request", { ...p, repository: { full_name: "other/api" } })).toEqual([]);
  });

  it("notifies approvals and change requests on your PRs", () => {
    const p = {
      action: "submitted",
      repository,
      sender: { login: "hubot" },
      pull_request: { ...pr, user: { login: "octocat" } },
      review: { state: "approved", html_url: "https://github.com/acme/api/pull/7#r1" },
    };
    expect(notices("pull_request_review", p)).toMatchObject([{ title: "@hubot approved your PR acme/api#7", url: p.review.html_url }]);
    expect(notices("pull_request_review", { ...p, review: { ...p.review, state: "commented" } })).toEqual([]);
  });

  it("notifies mentions and comments on your issues, skipping bots and look-alike logins", () => {
    const comment = (body: string, extra = {}) => ({
      action: "created",
      repository,
      sender: { login: "hubot" },
      issue: { ...issue, user: { login: "hubot" } },
      comment: { body, html_url: "https://github.com/acme/api/issues/3#c1" },
      ...extra,
    });
    expect(notices("issue_comment", comment("cc @octocat please"))[0]).toMatchObject({
      title: "@hubot mentioned you on acme/api#3",
      body: "Broken\ncc @octocat please",
    });
    expect(notices("issue_comment", comment("cc @octocat-bot"))).toEqual([]);
    expect(notices("issue_comment", comment("see acme/@octocat"))).toEqual([]);
    expect(notices("issue_comment", comment("LGTM", { issue }))[0].title).toBe("@hubot commented on acme/api#3");
    expect(notices("issue_comment", comment("@octocat", { sender: { login: "claude[bot]" } }))).toEqual([]);
  });

  it("notifies new security alerts, not updates to known ones", () => {
    const alert = {
      number: 1,
      html_url: "https://github.com/acme/api/security/secret-scanning/1",
      created_at: "2026-09-28T00:00:00Z",
      secret_type_display_name: "GitHub Token",
    };
    const p = { action: "created", repository, alert, sender: { login: "github", avatar_url: "", html_url: "" } };
    expect(notices("secret_scanning_alert", p)).toEqual([
      { title: "Critical security alert in acme/api", body: "Exposed GitHub Token", url: alert.html_url, tag: alert.html_url },
    ]);
    expect(notices("secret_scanning_alert", { ...p, action: "validated" })).toEqual([]);
  });

  it("notifies Claude runs that reach a branch or a PR", () => {
    const run: ClaudeRun = {
      repo: "acme/api",
      number: 3,
      state: "working",
      requestedAt: "2026-09-28T00:00:00Z",
      updatedAt: "2026-09-28T00:00:00Z",
      commentUrl: "https://github.com/acme/api/issues/3#c1",
    };
    expect(claudeNotice(run)).toBeUndefined();
    expect(claudeNotice({ ...run, state: "pr", prUrl: pr.html_url })).toMatchObject({
      title: "Claude opened a PR for acme/api#3",
      url: pr.html_url,
    });
  });
});
