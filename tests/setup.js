// Imported FIRST by every test file, before anything from src/, so the app
// and its database client only ever see the test settings.
//
// Tests run only against the local mindora_test database in the same Docker
// Postgres as development (localhost:5433). They never touch mindora_dev,
// Neon or any other database, and refuse to start if pointed elsewhere.

const TEST_DATABASE_URL = 'postgresql://mindora:mindora_dev_password@localhost:5433/mindora_test'

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || TEST_DATABASE_URL
if (!/@localhost:5433\/mindora_test(\?|$)/.test(process.env.DATABASE_URL)) {
  throw new Error('Tests only run against the local mindora_test database (localhost:5433/mindora_test).')
}

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'mindora-test-secret-not-for-production'

// Replaced with fake values so the real keys in .env are never loaded during
// tests (dotenv does not override a variable that is already set). The
// email library refuses to start with no key at all, so it gets a fake one:
// any email a test triggered would be rejected by Resend, never delivered.
process.env.RESEND_API_KEY = 're_test_fake_key_never_sends'
// The email helpers that check this skip sending entirely.
process.env.EMAIL_DISABLED = 'true'
for (const key of ['ANTHROPIC_API_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
  process.env[key] = ''
}
