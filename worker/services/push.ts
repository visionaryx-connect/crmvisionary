// Web Push for Cloudflare Workers, implemented on WebCrypto (no Node "web-push" dependency, which relies on
// node:crypto ECDH/HKDF APIs the Workers runtime does not fully provide).
//   * Payload encryption: RFC 8291 (Message Encryption for Web Push) with RFC 8188 "aes128gcm" content coding.
//   * Authentication: RFC 8292 VAPID — an ES256 JWT signed with the private key, plus the public key.
// The private key is a Worker secret and never leaves the Worker.

import type { Env } from '../env'

const te = new TextEncoder()

export function b64urlDecode(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}
const buf = (u: Uint8Array) => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, length * 8))
}

function publicJwk(raw: Uint8Array): JsonWebKey {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('Expected an uncompressed P-256 public key (65 bytes)')
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)), ext: true }
}

export interface EncryptOverrides {
  /** Test vectors only. */
  salt?: Uint8Array
  senderPrivate?: Uint8Array
  senderPublic?: Uint8Array
}

/** RFC 8291 encryption. Returns the aes128gcm body (header + single record). */
export async function encryptPayload(plaintext: Uint8Array, uaPublicB64: string, authSecretB64: string, o: EncryptOverrides = {}): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(uaPublicB64)
  const authSecret = b64urlDecode(authSecretB64)
  let asPrivateKey: CryptoKey
  let asPublic: Uint8Array
  if (o.senderPrivate && o.senderPublic) {
    asPublic = o.senderPublic
    asPrivateKey = await crypto.subtle.importKey('jwk', { ...publicJwk(asPublic), d: b64urlEncode(o.senderPrivate) }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
    asPrivateKey = pair.privateKey
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
  }
  const uaKey = await crypto.subtle.importKey('jwk', publicJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPrivateKey, 256))
  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(authSecret, shared, keyInfo, 32)
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt'])
  const record = concat(plaintext, new Uint8Array([2])) // single, final record: delimiter 0x02, no padding
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aes, buf(record)))
  const rs = 4096
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255]), new Uint8Array([asPublic.length]), asPublic)
  return concat(header, cipher)
}

let vapidKeyCache: { pem: string; key: CryptoKey } | null = null

async function vapidSigningKey(publicB64: string, privateB64: string): Promise<CryptoKey> {
  const cacheKey = publicB64 + privateB64
  if (vapidKeyCache?.pem === cacheKey) return vapidKeyCache.key
  const key = await crypto.subtle.importKey('jwk', { ...publicJwk(b64urlDecode(publicB64)), d: privateB64, ext: false }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  vapidKeyCache = { pem: cacheKey, key }
  return key
}

/** RFC 8292 VAPID JWT for a push service origin (ES256, raw r||s signature as JOSE requires). */
export async function vapidJwt(audience: string, subject: string, publicB64: string, privateB64: string, ttlSeconds = 12 * 3600): Promise<string> {
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64urlEncode(te.encode(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSeconds, sub: subject })))
  const unsigned = `${header}.${claims}`
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(publicB64, privateB64), te.encode(unsigned))
  return `${unsigned}.${b64urlEncode(sig)}`
}

// ───────── Key hygiene ─────────
// Secrets are pasted by hand. scripts/gen-vapid.mjs prints `VAPID_PUBLIC_KEY=…` lines, so people paste the
// name, quotes, spaces, a trailing newline or standard base64. Accept all of that, and say clearly when what is
// left still is not a usable key pair (instead of failing silently in the browser).

const cleanKey = (raw: string | undefined) =>
  (raw ?? '')
    .trim()
    .replace(/^[A-Z_]+\s*=\s*/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/\s+/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const cleanSubject = (raw: string | undefined) =>
  (raw ?? '')
    .trim()
    .replace(/^VAPID_SUBJECT\s*=\s*/, '')
    .replace(/\s+#.*$/, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim()

export function vapidConfig(env: Env) {
  return { publicKey: cleanKey(env.VAPID_PUBLIC_KEY), privateKey: cleanKey(env.VAPID_PRIVATE_KEY), subject: cleanSubject(env.VAPID_SUBJECT) }
}

function safeDecode(s: string): Uint8Array | null {
  try {
    return s ? b64urlDecode(s) : null
  } catch {
    return null
  }
}

/** Cheap structural check (lengths, prefix, subject). Null when the keys look usable. */
export function vapidShapeProblem(env: Env): string | null {
  const k = vapidConfig(env)
  if (!k.publicKey || !k.privateKey || !k.subject) return 'Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT.'
  const pub = safeDecode(k.publicKey)
  if (!pub || pub.length !== 65 || pub[0] !== 4) return `VAPID_PUBLIC_KEY is not a valid public key (expected 87 base64url characters, got ${k.publicKey.length}). Paste only the value after "VAPID_PUBLIC_KEY=" from node scripts/gen-vapid.mjs.`
  const priv = safeDecode(k.privateKey)
  if (!priv || priv.length !== 32) return `VAPID_PRIVATE_KEY is not a valid private key (expected 43 base64url characters, got ${k.privateKey.length}). Paste only the value after "VAPID_PRIVATE_KEY=".`
  if (!/^(mailto:[^\s@]+@[^\s@]+\.[^\s@]+|https:\/\/\S+)$/i.test(k.subject)) return `VAPID_SUBJECT must be "mailto:someone@your-domain" or an https URL (got ${JSON.stringify(k.subject.slice(0, 60))}).`
  return null
}

let pairCheck: { key: string; problem: string | null } | null = null

/** Full check: shape plus proof that the private key belongs to the public key (sign, then verify). */
export async function vapidProblem(env: Env): Promise<string | null> {
  const shape = vapidShapeProblem(env)
  if (shape) return shape
  const k = vapidConfig(env)
  const cacheKey = k.publicKey + k.privateKey
  if (pairCheck?.key === cacheKey) return pairCheck.problem
  let problem: string | null = null
  try {
    const data = te.encode('vapid-pair-check')
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await vapidSigningKey(k.publicKey, k.privateKey), data)
    const pub = await crypto.subtle.importKey('raw', buf(b64urlDecode(k.publicKey)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, data))) problem = 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not from the same key pair. Run node scripts/gen-vapid.mjs once and set both values from the same run.'
  } catch {
    problem = 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY do not form a valid key pair. Run node scripts/gen-vapid.mjs once and set both values from the same run.'
  }
  pairCheck = { key: cacheKey, problem }
  return problem
}

export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

export type PushResult =
  | { outcome: 'sent'; status: number }
  | { outcome: 'expired'; status: number; error: string }
  | { outcome: 'retryable' | 'permanent'; status: number; error: string }

/** Only real push services: https, no credentials, no internal hosts (the endpoint is user-supplied). */
export function isAllowedEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint)
    if (u.protocol !== 'https:' || u.username || u.password) return false
    const h = u.hostname
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(':')) return false
    return true
  } catch {
    return false
  }
}

export async function sendWebPush(env: Env, target: PushTarget, payload: Record<string, unknown>, opts: { ttl?: number; urgency?: 'very-low' | 'low' | 'normal' | 'high'; topic?: string } = {}, fetcher: typeof fetch = fetch): Promise<PushResult> {
  const shape = vapidShapeProblem(env)
  if (shape) return { outcome: 'permanent', status: 0, error: shape }
  const keys = vapidConfig(env)
  if (!isAllowedEndpoint(target.endpoint)) return { outcome: 'expired', status: 0, error: 'Endpoint is not an allowed push service URL' }
  let body: Uint8Array
  try {
    body = await encryptPayload(te.encode(JSON.stringify(payload)), target.p256dh, target.auth)
  } catch (err) {
    return { outcome: 'expired', status: 0, error: `Invalid subscription keys: ${err instanceof Error ? err.message : String(err)}` }
  }
  const aud = new URL(target.endpoint).origin
  const jwt = await vapidJwt(aud, keys.subject, keys.publicKey, keys.privateKey)
  let res: Response
  try {
    res = await fetcher(target.endpoint, {
      method: 'POST',
      headers: {
        authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: String(opts.ttl ?? 24 * 3600),
        urgency: opts.urgency ?? 'normal',
        ...(opts.topic ? { topic: opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) } : {}),
      },
      body: buf(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    return { outcome: 'retryable', status: 0, error: `Network error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300) }
  }
  if (res.status >= 200 && res.status < 300) return { outcome: 'sent', status: res.status }
  const text = (await res.text().catch(() => '')).slice(0, 300)
  if (res.status === 404 || res.status === 410) return { outcome: 'expired', status: res.status, error: `Subscription gone (${res.status})` }
  if (res.status === 429 || res.status >= 500) return { outcome: 'retryable', status: res.status, error: `Push service ${res.status}: ${text}` }
  return { outcome: 'permanent', status: res.status, error: `Push service ${res.status}: ${text}` }
}
