// Generates every logo, favicon and PWA / home-screen icon from the official Visionary X logo
// (public/brand/visionary-x-logo.png: the orb with its VX badge above the "Visionary X by IPG" wordmark).
// The mark is never redrawn: the orb is cut out of the official artwork and only scaled.
// Run: node scripts/make-icons.mjs   (uses sharp, already installed)
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'

const SOURCE = 'public/brand/visionary-x-logo.png'
const CARBON = { r: 12, g: 12, b: 12, alpha: 1 }

// ── 1. Find the orb: the non-white region above the wordmark. Its top, bottom and left edges are the grey shade
//      side of the sphere, so they define the circle even where the highlight is close to white.
const { data, info } = await sharp(SOURCE).flatten({ background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info
const isInk = (x, y) => {
  const i = (y * W + x) * C
  return data[i] < 238 || data[i + 1] < 238 || data[i + 2] < 238
}
// The wordmark starts at the first fully white band below the orb.
let orbBottom = 0
let top = H
let left = W
for (let y = 0; y < H; y++) {
  let any = false
  for (let x = 0; x < W; x += 2) if (isInk(x, y)) { any = true; if (x < left) left = x; break }
  if (any) { if (y < top) top = y; orbBottom = y } else if (orbBottom && y - orbBottom > 20) break
}
const d = orbBottom - top + 1
const cx = left + d / 2
const cy = top + d / 2
console.log(`orb: top ${top} left ${left} diameter ${d}`)

// ── 2. Cut it out with a circular alpha mask (1.5px inside the edge so no white fringe shows on dark).
const size = Math.round(d)
const r = size / 2 - 1.5
const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="#fff"/></svg>`)
const orb = await sharp(SOURCE)
  .extract({ left: Math.round(cx - size / 2), top: Math.round(cy - size / 2), width: size, height: size })
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer()

const save = async (file, buf) => {
  await sharp(buf).png({ compressionLevel: 9 }).toFile(file)
  console.log('wrote', file)
}

// Transparent orb for the app UI and emails.
for (const s of [64, 128, 256, 512]) await save(`public/brand/vx-orb-${s}.png`, await sharp(orb).resize(s, s).toBuffer())

/** The orb centred on a carbon square. pad = empty fraction on each side (maskable icons need a safe zone). */
const onCarbon = async (canvas, pad, radius = 0) => {
  const inner = Math.round(canvas * (1 - pad * 2))
  const bg = radius
    ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}"><rect width="${canvas}" height="${canvas}" rx="${radius}" fill="#0c0c0c"/></svg>`)
    : await sharp({ create: { width: canvas, height: canvas, channels: 4, background: CARBON } }).png().toBuffer()
  return sharp(bg).composite([{ input: await sharp(orb).resize(inner, inner).toBuffer(), gravity: 'center' }]).png().toBuffer()
}

await save('public/icons/icon-192.png', await onCarbon(192, 0.1))
await save('public/icons/icon-512.png', await onCarbon(512, 0.1))
await save('public/icons/maskable-512.png', await onCarbon(512, 0.2)) // Android crops adaptive icons to a circle/squircle
await save('public/icons/apple-touch-icon.png', await onCarbon(180, 0.1)) // iOS adds its own rounded corners
await save('public/favicon-32.png', await onCarbon(32, 0.04, 7))
await save('public/favicon-64.png', await onCarbon(64, 0.04, 14))

// favicon.svg keeps working for browsers that ask for it: it wraps the raster mark rather than redrawing it.
const fav = (await onCarbon(128, 0.04, 28)).toString('base64')
writeFileSync('public/favicon.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><image width="128" height="128" href="data:image/png;base64,${fav}"/></svg>\n`)
console.log('wrote public/favicon.svg')
