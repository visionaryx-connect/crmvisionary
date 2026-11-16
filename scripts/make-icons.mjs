// Generates the PWA / home-screen icons from one vector design (moon orb + "X" badge on carbon).
// Run: node scripts/make-icons.mjs   (uses sharp, already installed as a dependency)
import sharp from 'sharp'
import { writeFileSync } from 'node:fs'

/** pad = fraction of the canvas kept empty around the orb (maskable icons need a safe zone). */
const svg = (pad = 0.16, rounded = false) => {
  const s = 512
  const r = (s * (1 - pad * 2)) / 2
  const cx = s / 2
  const cy = s / 2
  const br = r * 0.36
  const bx = cx + r * 0.62
  const by = cy - r * 0.62
  const arm = br * 0.42
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <radialGradient id="g" cx="0.34" cy="0.30" r="0.85">
      <stop offset="0" stop-color="#ffffff"/><stop offset="0.38" stop-color="#e9e8e4"/>
      <stop offset="0.72" stop-color="#a9a8a4"/><stop offset="1" stop-color="#5c5b58"/>
    </radialGradient>
  </defs>
  <rect width="${s}" height="${s}" ${rounded ? 'rx="112"' : ''} fill="#0c0c0c"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#g)"/>
  <circle cx="${bx}" cy="${by}" r="${br}" fill="#0c0c0c"/>
  <path d="M${bx - arm} ${by - arm} L${bx + arm} ${by + arm} M${bx + arm} ${by - arm} L${bx - arm} ${by + arm}" stroke="#fbfaf7" stroke-width="${br * 0.26}" stroke-linecap="round"/>
</svg>`
}

const out = async (file, size, pad, rounded = false) => {
  await sharp(Buffer.from(svg(pad, rounded))).resize(size, size).png().toFile(file)
  console.log('wrote', file)
}
await out('public/icons/icon-192.png', 192, 0.14)
await out('public/icons/icon-512.png', 512, 0.14)
await out('public/icons/maskable-512.png', 512, 0.24) // Android adaptive icons crop to a circle/squircle
await out('public/icons/apple-touch-icon.png', 180, 0.14) // iOS applies its own rounded corners
writeFileSync('public/favicon.svg', svg(0.08, true))
console.log('wrote public/favicon.svg')
