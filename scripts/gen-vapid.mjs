// Generate a Web Push VAPID key pair (P-256) in the base64url format the Worker expects.
// Run: node scripts/gen-vapid.mjs
// Then store them (see docs/NOTIFICATIONS.md):
//   npx wrangler secret put VAPID_PRIVATE_KEY --env production   (paste the private key)
//   VAPID_PUBLIC_KEY and VAPID_SUBJECT can be vars or secrets.
// Generate once per environment and keep the pair: rotating it invalidates every existing browser subscription.
import { generateKeyPairSync } from 'node:crypto'

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const jwk = privateKey.export({ format: 'jwk' })
const pub = publicKey.export({ format: 'jwk' })
const b64u = (b) => Buffer.from(b).toString('base64url')
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')])

console.log(`VAPID_PUBLIC_KEY=${b64u(raw)}`)
console.log(`VAPID_PRIVATE_KEY=${jwk.d}`)
console.log('VAPID_SUBJECT=mailto:it@visionary-x.in   # use a monitored address you control')
