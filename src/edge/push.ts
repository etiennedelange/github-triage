// Web Push on WebCrypto: VAPID (RFC 8292) to identify the sender and aes128gcm (RFC 8291)
// to encrypt the message for one browser. Runtime-agnostic, like crypto.ts.

import { z } from "zod";

/** What a browser's `PushSubscription.toJSON()` gives us, as stored by the Hub. */
export const pushSubscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});
export type PushSubscriptionJSON = z.infer<typeof pushSubscription>;

/** The Hub's VAPID key pair: the public key raw and base64url (what the browser subscribes with). */
export type VapidKeys = { publicKey: string; privateKey: JsonWebKey };

/** One notification, as the service worker (public/sw.js) reads it. */
export type PushMessage = {
  title: string;
  body: string;
  /** Opened on click. */
  url: string;
  /** A later message with the same tag replaces this one instead of stacking. */
  tag: string;
  /** Show it even over a focused tab (the test sent when you turn notifications on). */
  always?: boolean;
};

const enc = new TextEncoder();
const EC = { name: "ECDSA", namedCurve: "P-256" } as const;

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  return {
    publicKey: toBase64Url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateKey: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

/** `Authorization` for a push to `endpoint`: an ES256 JWT for the push service's origin, plus our key. */
export async function vapidAuthorization(keys: VapidKeys, endpoint: string, subject: string, now = Date.now()): Promise<string> {
  const header = toBase64Url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Push services cap `exp` at 24 hours out.
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${header}.${toBase64Url(enc.encode(JSON.stringify(claims)))}`;
  const key = await crypto.subtle.importKey("jwk", keys.privateKey, EC, false, ["sign"]);
  // WebCrypto's ECDSA signature is already JWS's raw r || s.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${toBase64Url(sig)}, k=${keys.publicKey}`;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** The request body for one subscription: a single aes128gcm record (RFC 8291 §3.4, RFC 8188). */
export async function encryptPayload(sub: PushSubscriptionJSON, plaintext: string): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = fromBase64Url(sub.keys.p256dh);
  const authSecret = fromBase64Url(sub.keys.auth);
  const ecdh = { name: "ECDH", namedCurve: "P-256" } as const;
  const local = (await crypto.subtle.generateKey(ecdh, true, ["deriveBits"])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const peer = await crypto.subtle.importKey("raw", uaPublic, ecdh, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  // 0x02: the last (and only) record, no padding.
  const record = concat(enc.encode(plaintext), Uint8Array.of(2));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));

  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

/**
 * Sends one message. `gone`: the push service no longer knows this subscription (unsubscribed,
 * expired, or made with another key), so the caller should forget it.
 */
export async function sendPush(
  keys: VapidKeys,
  sub: PushSubscriptionJSON,
  message: PushMessage,
  subject: string,
): Promise<{ ok: boolean; gone: boolean; status: number }> {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(keys, sub.endpoint, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // Held for a day if the browser isn't running; older than that isn't news any more.
      TTL: "86400",
      Urgency: "high",
    },
    body: await encryptPayload(sub, JSON.stringify(message)),
  });
  return { ok: res.ok, gone: res.status === 404 || res.status === 410 || res.status === 403, status: res.status };
}
