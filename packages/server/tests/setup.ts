// Test environment. Uses a real PostgreSQL database — these are integration
// tests, not mocks: every assertion below is checked against actual SQL.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres@127.0.0.1:5432/mara_test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-at-least-32-characters-long';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-at-least-32-characters-long';
process.env.COOKIE_SECRET = 'test-cookie-secret-at-least-32-characters-long!';
process.env.MFA_SECRET_KEY = 'test-mfa-key-at-least-32-characters-long-here!!';
process.env.WHATSAPP_PROVIDER = 'log';
process.env.REQUIRE_ADMIN_MFA = 'false';
process.env.AUTO_MIGRATE = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.OTP_RESEND_COOLDOWN_SECONDS = '0';
process.env.OTP_MAX_PER_PHONE_PER_HOUR = '1000';
