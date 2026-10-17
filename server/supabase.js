/**
 * Supabase Online Backup Service
 * 
 * Implements the CIA Triad:
 * - Confidentiality: Never transmits passwords, hashes, salts, peppers, 2FA secrets, or session tokens.
 * - Integrity: Validates data types, enforces schema constraints, uses server-generated UUIDs and safe upserts.
 * - Availability: Non-blocking async execution, 5-second timeouts, graceful local-first fallback when offline.
 */

const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { defaultBackupQueue } = require('./backupQueue');

const REQUEST_TIMEOUT_MS = 5000; // 5-second timeout to protect availability

let supabaseClient = null;
let configurationNoticeLogged = false;

/**
 * Validates whether Supabase environment variables are present and well-formed
 */
function isConfigured() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;

  if (!url || !key) return false;
  if (url.includes('your-project-id') || key.includes('replace_with_your_supabase_secret_key')) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Lazily initializes and returns the server-side Supabase client
 */
function getClient() {
  if (!isConfigured()) {
    if (!configurationNoticeLogged) {
      console.log('[Supabase Backup] SUPABASE_URL and SUPABASE_SECRET_KEY are not configured. Running in local-only mode.');
      configurationNoticeLogged = true;
    }
    return null;
  }

  if (!supabaseClient) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;

    supabaseClient = createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      global: {
        // Enforce 5-second network timeout
        fetch: (input, init = {}) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
          const customInit = {
            ...init,
            signal: controller.signal
          };
          return fetch(input, customInit).finally(() => clearTimeout(timer));
        }
      }
    });
  }

  return supabaseClient;
}

/**
 * Sanitizes and validates a user account object before creating backup payload.
 * CONFIDENTIALITY GUARANTEE: Explicitly prevents any credential attributes from being included.
 */
function buildUserBackupPayload(user) {
  if (!user || typeof user !== 'object') {
    throw new Error('Invalid user object provided for backup');
  }

  const localUserId = parseInt(user.id, 10);
  if (!localUserId || isNaN(localUserId)) {
    throw new Error('User backup requires a valid positive integer local user ID');
  }

  if (!user.email || typeof user.email !== 'string') {
    throw new Error('User backup requires a valid email string');
  }

  const validRoles = ['inputer', 'manager', 'admin', 'administrator'];
  const role = user.role || 'inputer';
  if (!validRoles.includes(role)) {
    throw new Error(`Invalid user role "${role}" for backup payload`);
  }

  // Pure metadata only — no credentials
  return {
    local_user_id: localUserId,
    email: user.email.trim().toLowerCase(),
    name: user.name ? String(user.name).trim() : null,
    role,
    totp_enrolled: Boolean(user.totp_enrolled),
    account_created_at: user.created_at || new Date().toISOString(),
    synced_at: new Date().toISOString()
  };
}

/**
 * Synchronizes user account metadata to Supabase user_backup table
 * Uses idempotent UPSERT to avoid duplicate rows on repeated logins/updates.
 */
async function syncUserBackup(user) {
  const client = getClient();
  if (!client) {
    return { success: false, reason: 'NOT_CONFIGURED' };
  }

  const payload = buildUserBackupPayload(user);

  try {
    let { data, error } = await client
      .from('user_backup')
      .upsert(payload, { onConflict: 'email' });

    // Fallback if conflicting on local_user_id
    if (error && error.code === '23505') {
      const fallback = await client
        .from('user_backup')
        .upsert(payload, { onConflict: 'local_user_id' });
      error = fallback.error;
    }

    if (error) {
      throw error;
    }

    return { success: true, localUserId: payload.local_user_id };
  } catch (err) {
    console.warn(`[Supabase Backup Error] Failed to sync user #${payload.local_user_id}: ${err.message || 'Unknown network error'}`);
    throw err;
  }
}

/**
 * Records an authentication event in the Supabase login_activity table.
 * Uses server-generated UUID primary key to ensure retries never duplicate events.
 */
async function recordLoginActivityBackup(eventData) {
  const client = getClient();
  if (!client) {
    return { success: false, reason: 'NOT_CONFIGURED' };
  }

  const eventId = eventData.eventId || crypto.randomUUID();
  const validEventTypes = [
    'LOGIN_SUCCESS',
    'LOGIN_FAILURE_BAD_CREDENTIALS',
    'LOGIN_FAILURE_LOCKED',
    'LOGIN_FAILURE_2FA'
  ];
  const validMethods = ['PASSWORD_TOTP', 'PASSWORD_RECOVERY_CODE', 'NONE', 'UNKNOWN'];

  const eventType = validEventTypes.includes(eventData.eventType) ? eventData.eventType : 'LOGIN_SUCCESS';
  const authMethod = validMethods.includes(eventData.authMethod) ? eventData.authMethod : 'NONE';
  const status = eventData.status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';

  const payload = {
    event_id: eventId,
    local_user_id: eventData.localUserId ? parseInt(eventData.localUserId, 10) : null,
    event_type: eventType,
    auth_method: authMethod,
    status,
    ip_address: eventData.ipAddress ? String(eventData.ipAddress).slice(0, 45) : null,
    user_agent: eventData.userAgent ? String(eventData.userAgent).slice(0, 255) : null,
    event_timestamp: eventData.timestamp || new Date().toISOString(),
    backup_timestamp: new Date().toISOString()
  };

  try {
    const { data, error } = await client
      .from('login_activity')
      .insert(payload);

    if (error) {
      // Postgres error 23505 = unique_violation (already inserted on prior try)
      if (error.code === '23505') {
        return { success: true, eventId, duplicateIgnored: true };
      }
      throw error;
    }

    return { success: true, eventId };
  } catch (err) {
    console.warn(`[Supabase Backup Error] Failed to log activity event ${eventId}: ${err.message || 'Unknown network error'}`);
    throw err;
  }
}

/**
 * Non-blocking wrapper for user account backup with bounded retry queue
 */
function triggerUserBackupAsync(user) {
  if (!isConfigured()) return;

  // Execute in background; never await or block response
  setImmediate(async () => {
    try {
      await syncUserBackup(user);
    } catch (err) {
      defaultBackupQueue.enqueue(
        () => syncUserBackup(user),
        { type: 'USER_SYNC', identifier: `user-${user.id}` }
      );
    }
  });
}

/**
 * Non-blocking wrapper for login activity backup with bounded retry queue
 */
function triggerLoginActivityAsync(eventData) {
  if (!isConfigured()) return;

  const stableEventData = {
    ...eventData,
    eventId: eventData.eventId || crypto.randomUUID(),
    timestamp: eventData.timestamp || new Date().toISOString()
  };

  setImmediate(async () => {
    try {
      await recordLoginActivityBackup(stableEventData);
    } catch (err) {
      defaultBackupQueue.enqueue(
        () => recordLoginActivityBackup(stableEventData),
        { type: 'LOGIN_ACTIVITY', identifier: stableEventData.eventId }
      );
    }
  });
}

module.exports = {
  isConfigured,
  getClient,
  buildUserBackupPayload,
  syncUserBackup,
  recordLoginActivityBackup,
  triggerUserBackupAsync,
  triggerLoginActivityAsync,
  REQUEST_TIMEOUT_MS
};
