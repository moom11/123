import { randomBytes } from 'node:crypto';

/**
 * Configuration comes from the environment only. Nothing secret is ever
 * compiled into the bundle or shipped to a browser.
 */

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return raw === 'true' || raw === '1';
}

const isProd = process.env.NODE_ENV === 'production';

/**
 * In production every secret must be supplied. In development we generate an
 * ephemeral one so a fresh clone runs, at the cost of invalidating tokens on
 * restart — which is the correct trade-off for a dev box and an unacceptable
 * one for production, hence the hard failure above.
 */
function secret(name: string): string {
  const v = process.env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} must be set to at least 32 characters in production`);
  }
  if (v) {
    // eslint-disable-next-line no-console
    console.warn(`[config] ${name} is shorter than 32 chars; acceptable in dev only.`);
    return v;
  }
  return randomBytes(48).toString('base64url');
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd,
  port: int('PORT', 4000),
  host: process.env.HOST ?? '0.0.0.0',

  database: {
    url: required('DATABASE_URL', 'postgres://postgres@127.0.0.1:5432/mara'),
    poolMax: int('DB_POOL_MAX', 10),
    ssl: bool('DB_SSL', false),
  },

  auth: {
    accessSecret: secret('JWT_ACCESS_SECRET'),
    refreshSecret: secret('JWT_REFRESH_SECRET'),
    /** Admin access tokens are short; the refresh token carries the session. */
    accessTtlSeconds: int('ACCESS_TTL_SECONDS', 15 * 60),
    /** Staff on a shop-floor iPad get a longer refresh window than admins. */
    adminRefreshTtlSeconds: int('ADMIN_REFRESH_TTL_SECONDS', 12 * 60 * 60),
    employeeRefreshTtlSeconds: int('EMPLOYEE_REFRESH_TTL_SECONDS', 14 * 60 * 60),
    customerRefreshTtlSeconds: int('CUSTOMER_REFRESH_TTL_SECONDS', 30 * 24 * 60 * 60),
    /** Idle timeout for administrative sessions. */
    adminIdleTimeoutSeconds: int('ADMIN_IDLE_TIMEOUT_SECONDS', 30 * 60),
    maxFailedLogins: int('MAX_FAILED_LOGINS', 5),
    lockoutMinutes: int('LOCKOUT_MINUTES', 15),
    maxFailedPins: int('MAX_FAILED_PINS', 5),
    pinLockoutMinutes: int('PIN_LOCKOUT_MINUTES', 10),
    /** MFA is mandatory for administrative roles; only a dev box may relax it. */
    requireAdminMfa: bool('REQUIRE_ADMIN_MFA', isProd),
    mfaIssuer: process.env.MFA_ISSUER ?? 'MARA Lounge',
    /** Key used to encrypt TOTP secrets at rest (AES-256-GCM). */
    mfaSecretKey: secret('MFA_SECRET_KEY'),
  },

  otp: {
    length: int('OTP_LENGTH', 6),
    ttlSeconds: int('OTP_TTL_SECONDS', 300),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    /** Per-phone throttle so a customer's WhatsApp cannot be used as a weapon. */
    resendCooldownSeconds: int('OTP_RESEND_COOLDOWN_SECONDS', 60),
    maxPerPhonePerHour: int('OTP_MAX_PER_PHONE_PER_HOUR', 8),
  },

  whatsapp: {
    /** 'log' writes the code to the server log for development only. */
    provider: (process.env.WHATSAPP_PROVIDER ?? 'log') as 'log' | 'meta_cloud',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? '',
    apiVersion: process.env.WHATSAPP_API_VERSION ?? 'v21.0',
    otpTemplate: process.env.WHATSAPP_OTP_TEMPLATE ?? 'mara_otp',
    templateLanguage: process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? 'ar',
  },

  printing: {
    /** How long a print agent's claim on a job is honoured before re-queueing. */
    leaseSeconds: int('PRINT_LEASE_SECONDS', 60),
    retryBackoffSeconds: int('PRINT_RETRY_BACKOFF_SECONDS', 15),
    maxAttempts: int('PRINT_MAX_ATTEMPTS', 5),
    /** An agent silent for longer than this is reported as offline. */
    agentOfflineSeconds: int('PRINT_AGENT_OFFLINE_SECONDS', 120),
  },

  inventory: {
    /** Variance beyond either threshold raises an alert. */
    varianceAlertPercent: Number(process.env.VARIANCE_ALERT_PERCENT ?? '3'),
    varianceAlertValue: int('VARIANCE_ALERT_VALUE', 20000), // 200.00 SAR
    /** Waste above this value needs a manager's signature before it posts. */
    wasteApprovalThreshold: int('WASTE_APPROVAL_THRESHOLD', 10000), // 100.00 SAR
  },

  security: {
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:5174')
      .split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: bool('TRUST_PROXY', isProd),
    cookieSecret: secret('COOKIE_SECRET'),
    /** Guests scanning a QR get a permissive but finite budget. */
    rateLimitMax: int('RATE_LIMIT_MAX', 300),
    rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60_000),
  },

  uploads: {
    dir: process.env.UPLOAD_DIR ?? './uploads',
    maxBytes: int('UPLOAD_MAX_BYTES', 8 * 1024 * 1024),
  },

  publicMenuBaseUrl: process.env.PUBLIC_MENU_BASE_URL ?? 'http://localhost:5173',
} as const;

export type Config = typeof config;
