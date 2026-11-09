const APP_CONFIG_TABLE = 'server_app_config';
const FALLBACK_ADMIN_KEY = 'fallback_admin_user_id';
const LIST_USERS_PER_PAGE = 200;
const LIST_USERS_TIMEOUT_MS = 5_000;
const NEGATIVE_CACHE_TTL_MS = 30_000;

let fallbackAdminIdCache;
let fallbackResolved = false;
let fallbackWarned = false;
let fallbackResolveInFlight = null;
let negativeCacheUntil = 0;

export function parseAdminEmails(rawCsv) {
  return String(rawCsv || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@'));
}

function isEmailConfirmed(user) {
  if (!user || typeof user !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(user, 'email_confirmed_at')) return false;
  return Boolean(user.email_confirmed_at);
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

async function listUsersWithTimeout(supabaseAdmin, params) {
  const promise = supabaseAdmin.auth.admin.listUsers(params);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('listUsers_timeout')), LIST_USERS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readPersistedFallbackAdminId(supabaseAdmin) {
  const { data, error } = await supabaseAdmin
    .from(APP_CONFIG_TABLE)
    .select('value')
    .eq('id', FALLBACK_ADMIN_KEY)
    .maybeSingle();
  if (error) throw error;
  const id = data?.value?.user_id;
  return typeof id === 'string' && id ? id : null;
}

async function persistFallbackAdminId(supabaseAdmin, userId) {
  const payload = { id: FALLBACK_ADMIN_KEY, value: { user_id: userId } };
  const { error } = await supabaseAdmin
    .from(APP_CONFIG_TABLE)
    .upsert(payload, { onConflict: 'id', ignoreDuplicates: true });
  if (error) throw error;
}

async function resolveFirstConfirmedUserId(supabaseAdmin) {
  let page = 1;
  let winner = null;
  let seen = 0;
  let total = null;

  while (true) {
    const { data, error } = await listUsersWithTimeout(supabaseAdmin, {
      page,
      perPage: LIST_USERS_PER_PAGE,
    });
    if (error) throw error;

    const chunk = data?.users || [];
    if (total == null && data?.total != null) total = data.total;
    if (chunk.length === 0) break;

    for (const user of chunk) {
      if (!isEmailConfirmed(user)) continue;
      const createdAt = Date.parse(user.created_at || '');
      if (!Number.isFinite(createdAt)) continue;
      if (!winner || createdAt < winner.createdAt) {
        winner = { id: user.id, createdAt };
      }
    }

    seen += chunk.length;
    if (total != null) {
      if (seen >= total) break;
    } else if (chunk.length < LIST_USERS_PER_PAGE) {
      break;
    }
    page += 1;
  }

  return winner?.id || null;
}

async function isPersistedAdminStillValid(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (!error && data?.user) {
    return isEmailConfirmed(data.user);
  }

  let page = 1;
  let seen = 0;
  let total = null;
  while (true) {
    const { data: listData, error: listErr } = await listUsersWithTimeout(supabaseAdmin, {
      page,
      perPage: LIST_USERS_PER_PAGE,
    });
    if (listErr) return false;
    const chunk = listData?.users || [];
    if (total == null && listData?.total != null) total = listData.total;
    if (chunk.length === 0) return false;
    const hit = chunk.find((u) => u.id === userId);
    if (hit) return isEmailConfirmed(hit);
    seen += chunk.length;
    if (total != null) {
      if (seen >= total) return false;
    } else if (chunk.length < LIST_USERS_PER_PAGE) {
      return false;
    }
    page += 1;
  }
}

async function resolveFallbackAdminIdUncached(supabaseAdmin) {
  if (Date.now() < negativeCacheUntil) {
    throw new Error('admin_fallback_negative_cache');
  }

  let persisted;
  try {
    persisted = await readPersistedFallbackAdminId(supabaseAdmin);
  } catch (err) {
    negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
    throw err;
  }

  if (persisted) {
    const valid = await isPersistedAdminStillValid(supabaseAdmin, persisted);
    if (valid) return persisted;
    fallbackAdminIdCache = null;
    fallbackResolved = true;
    return null;
  }

  const resolved = await resolveFirstConfirmedUserId(supabaseAdmin);
  if (resolved) {
    try {
      await persistFallbackAdminId(supabaseAdmin, resolved);
    } catch (err) {
      negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
      throw err;
    }
    const afterInsert = await readPersistedFallbackAdminId(supabaseAdmin);
    return afterInsert || resolved;
  }
  return null;
}

async function getFallbackAdminId(supabaseAdmin) {
  if (fallbackResolved) return fallbackAdminIdCache || null;

  if (!fallbackResolveInFlight) {
    fallbackResolveInFlight = resolveFallbackAdminIdUncached(supabaseAdmin)
      .then((id) => {
        fallbackAdminIdCache = id;
        fallbackResolved = true;
        return id;
      })
      .catch((err) => {
        negativeCacheUntil = Date.now() + NEGATIVE_CACHE_TTL_MS;
        throw err;
      })
      .finally(() => {
        fallbackResolveInFlight = null;
      });
  }

  return fallbackResolveInFlight;
}

export async function isUserAdmin({ env, supabaseAdmin, user }) {
  if (!isEmailConfirmed(user)) return false;

  const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);
  if (adminEmails.length > 0) {
    return adminEmails.includes(normalizeEmail(user.email));
  }

  const fallbackId = await getFallbackAdminId(supabaseAdmin);
  const allowed = Boolean(fallbackId && user?.id === fallbackId);
  if (allowed && !fallbackWarned) {
    fallbackWarned = true;
    console.warn('[requireAdmin] ADMIN_EMAILS is not configured; using fallback admin user id from server_app_config.');
  }
  return allowed;
}

export function warnIfAdminFallbackEnabled(env = process.env) {
  const adminEmails = parseAdminEmails(env.ADMIN_EMAILS);
  if (adminEmails.length > 0) return;
  console.warn(
    '[trazza-server] ADMIN_EMAILS is not set — the first verified user to sign up will receive admin access (persisted in server_app_config). Set ADMIN_EMAILS to a comma-separated list of owner emails.',
  );
}

export function __resetAdminResolverCacheForTests() {
  fallbackAdminIdCache = undefined;
  fallbackResolved = false;
  fallbackWarned = false;
  fallbackResolveInFlight = null;
  negativeCacheUntil = 0;
}
