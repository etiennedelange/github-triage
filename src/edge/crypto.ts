// WebCrypto helpers shared by the worker entry and its tests. Runtime-agnostic.

const enc = new TextEncoder();

function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  return toHex(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(data)));
}

/** Constant-time check via `subtle.verify`, so a mismatch leaks nothing through timing. */
async function verifyHex(secret: string, data: string, hex: string): Promise<boolean> {
  const sig = fromHex(hex);
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(data));
}

/** GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function verifyWebhook(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!secret || !header?.startsWith("sha256=")) return Promise.resolve(false);
  return verifyHex(secret, body, header.slice("sha256=".length));
}

// ---------- Session cookie: "<login>.<expiresAtMs>.<hmac>" ----------

export async function signSession(secret: string, login: string, expiresAt: number): Promise<string> {
  const payload = `${login}.${expiresAt}`;
  return `${payload}.${await hmacHex(secret, payload)}`;
}

/** The signed-in login, or null if the value is missing, tampered with or expired. */
export async function verifySession(secret: string, value: string | undefined, now = Date.now()): Promise<string | null> {
  if (!secret || !value) return null;
  const [login, exp, sig] = value.split(".");
  if (!login || !exp || !sig || !(Number(exp) > now)) return null;
  return (await verifyHex(secret, `${login}.${exp}`, sig)) ? login : null;
}

export function randomToken(bytes = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}
