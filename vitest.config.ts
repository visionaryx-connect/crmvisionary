import { defineConfig } from 'vitest/config'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { fileURLToPath } from 'node:url'

export default defineConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL('./migrations', import.meta.url)))
  return {
    resolve: { alias: { '@shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.test.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            APP_ENV: 'test',
            APP_ORIGIN: 'http://example.com',
            SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789',
            DATA_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
            // Test-only notification credentials. Nothing is sent: tests inject a fake fetch into the delivery worker,
            // and APP_ENV=test disables the immediate background dispatch.
            BREVO_API_KEY: 'test-brevo-key-not-real',
            BREVO_SENDER_EMAIL: 'notifications@example.com',
            BREVO_SENDER_NAME: 'Visionary X',
            BREVO_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
            VAPID_PUBLIC_KEY: 'BN0bdC4dLX9kZG-vWlLmemXmhbBiJkYk0grmWfMompSOceUnYccLwQGuXgIZilLNqAmSGwACbn19rZHlOWd3fyc',
            VAPID_PRIVATE_KEY: '2CDm9RPR_aCs3-JXWj87wC2fp_t7BLT-MPlQ4C2kKGU',
            VAPID_SUBJECT: 'mailto:test@example.com',
          },
        },
      }),
    ],
    test: { setupFiles: ['./tests/setup.ts'], include: ['tests/**/*.test.ts'] },
  }
})
