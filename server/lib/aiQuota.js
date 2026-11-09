const FEATURES = ['chat', 'analysis', 'import'];

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseAdminEmails(rawCsv) {
  return String(rawCsv || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'));
}

function isUnlimitedUser(env, user) {
  const email = String(user?.email || '').trim().toLowerCase();
  const adminEmails = parseAdminEmails(env?.ADMIN_EMAILS);
  if (adminEmails.length > 0) return adminEmails.includes(email);
  return user?.isFirstUser === true;
}

const DEFAULT_DAILY_BY_FEATURE = {
  chat: 100,
  analysis: 30,
  import: 50,
};
const DEFAULT_MONTHLY_BY_FEATURE = {
  chat: 500,
  analysis: 100,
  import: 200,
};

function envOverride(raw) {
  return raw != null && String(raw).trim() !== '';
}

function featureDailyLimit(env, feature) {
  const specificKey = `AI_DAILY_LIMIT_${feature.toUpperCase()}`;
  if (envOverride(env?.[specificKey])) {
    return parsePositiveInt(env[specificKey], DEFAULT_DAILY_BY_FEATURE[feature] ?? 100);
  }
  if (envOverride(env?.AI_DAILY_LIMIT_USER)) {
    return parsePositiveInt(env.AI_DAILY_LIMIT_USER, 100);
  }
  return DEFAULT_DAILY_BY_FEATURE[feature] ?? 100;
}

function featureMonthlyLimit(env, feature) {
  const specificKey = `AI_MONTHLY_LIMIT_${feature.toUpperCase()}`;
  if (envOverride(env?.[specificKey])) {
    return parsePositiveInt(env[specificKey], DEFAULT_MONTHLY_BY_FEATURE[feature] ?? 1000);
  }
  if (envOverride(env?.AI_MONTHLY_LIMIT_USER)) {
    return parsePositiveInt(env.AI_MONTHLY_LIMIT_USER, 1000);
  }
  return DEFAULT_MONTHLY_BY_FEATURE[feature] ?? 1000;
}

export function getAiLimits(env = {}, user = {}) {
  const enabled = Boolean(env.GROQ_API_KEY);
  const unlimited = isUnlimitedUser(env, user);
  const out = { enabled };

  for (const feature of FEATURES) {
    out[feature] = unlimited
      ? { daily: Infinity, monthly: Infinity }
      : {
          daily: featureDailyLimit(env, feature),
          monthly: featureMonthlyLimit(env, feature),
        };
  }

  return out;
}
