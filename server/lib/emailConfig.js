/**
 * @deprecated No-op retained for OSS compatibility. Never mutates process.env.
 */
export function applyDevEmailEnvDefault() {
  // Intentionally empty — self-hosted installs must set RESEND_API_KEY or SMTP explicitly.
}

/**
 * Whether outbound email is configured (OSS). Separate from emailTransport so
 * route handlers and unit tests can mock sendEmail without Vitest namespace
 * mocks having to export isEmailConfigured.
 */
export function isEmailConfigured() {
  return Boolean(
    process.env.RESEND_API_KEY
    || process.env.EMAIL_HOST
    || process.env.EMAIL_USER,
  );
}
