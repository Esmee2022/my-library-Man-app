/**
 * Database Module (SQLite via better-sqlite3)
 * Security decisions:
 * - SQLite file placed in server/database/ (outside any public or web-accessible folder)
 * - Strict parameter binding everywhere (no SQL string concatenation)
 * - Foreign keys enabled and WAL mode for high performance and integrity
 * - Database file permissions restricted
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getClient } = require('./supabase');
const cloudAuth = process.env.AUTH_STORE === 'supabase';

const DB_DIR = path.join(__dirname, 'database');
const DB_PATH = process.env.AUTH_DB_PATH || path.join(DB_DIR, 'auth.db');

// Ensure database directory exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
}

// Initialize SQLite database
const db = cloudAuth ? null : new Database(DB_PATH);

// Enable WAL mode & foreign keys
if (db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
}

// Restrict database file permissions if supported
try {
  if (db) fs.chmodSync(DB_PATH, 0o600);
} catch {
  // Windows file systems might not support POSIX chmod; ACL is handled by OS
}

/**
 * Initialize Tables
 */
function initDatabase() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL COLLATE NOCASE,
      name TEXT,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('inputer', 'manager', 'admin', 'administrator')),
      active INTEGER NOT NULL DEFAULT 1,
      password_changed_at TEXT DEFAULT (datetime('now')),
      totp_secret TEXT,
      totp_enrolled INTEGER DEFAULT 0,
      failed_login_attempts INTEGER DEFAULT 0,
      locked_until INTEGER DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_activity INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      status TEXT NOT NULL CHECK(status IN ('SUCCESS', 'FAILURE')),
      details TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS recovery_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      used_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
  `);
  const userColumns = db.pragma('table_info(users)');
  if (!userColumns.some((column) => column.name === 'active')) {
    db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }
  if (!userColumns.some((column) => column.name === 'password_changed_at')) {
    db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
    db.exec("UPDATE users SET password_changed_at = datetime('now') WHERE password_changed_at IS NULL");
  }
}

initDatabase();

// Parameterized Query Helpers

const queries = db ? {
  getUserByEmail: db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`),
  getUserById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  listUsers: db.prepare(`SELECT id, email, name, role, active, totp_enrolled, created_at, locked_until FROM users ORDER BY id ASC`),
  createUser: db.prepare(`
    INSERT INTO users (email, name, password_hash, salt, role, totp_secret, totp_enrolled, password_changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `),
  deleteUser: db.prepare(`DELETE FROM users WHERE id = ?`),
  updateUserRole: db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`),
  updateUserStatus: db.prepare(`UPDATE users SET active = ?, updated_at = datetime('now') WHERE id = ?`),
  changeUserPassword: db.prepare(`UPDATE users SET password_hash = ?, salt = ?, password_changed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`),
  updateTotpSecret: db.prepare(`
    UPDATE users SET totp_secret = ?, totp_enrolled = ?, updated_at = datetime('now') WHERE id = ?
  `),
  recordFailedAttempt: db.prepare(`
    UPDATE users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = ?
  `),
  resetFailedAttempts: db.prepare(`
    UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = ?
  `),
  lockAccount: db.prepare(`
    UPDATE users SET locked_until = ? WHERE id = ?
  `),

  // Sessions
  createSession: db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_token, expires_at, last_activity, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getSession: db.prepare(`
    SELECT s.*, u.email, u.name, u.role, u.active, u.locked_until
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
  `),
  updateSessionActivity: db.prepare(`
    UPDATE sessions SET last_activity = ?, expires_at = ? WHERE id = ?
  `),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
  deleteUserSessions: db.prepare(`DELETE FROM sessions WHERE user_id = ?`),
  cleanExpiredSessions: db.prepare(`DELETE FROM sessions WHERE expires_at < ?`),

  // Recovery Codes
  insertRecoveryCode: db.prepare(`
    INSERT INTO recovery_codes (user_id, code_hash, used) VALUES (?, ?, 0)
  `),
  getUnusedRecoveryCodes: db.prepare(`
    SELECT * FROM recovery_codes WHERE user_id = ? AND used = 0
  `),
  markRecoveryCodeUsed: db.prepare(`
    UPDATE recovery_codes SET used = 1, used_at = datetime('now') WHERE id = ?
  `),
  deleteUserRecoveryCodes: db.prepare(`DELETE FROM recovery_codes WHERE user_id = ?`),

  // Audit Log
  insertAudit: db.prepare(`
    INSERT INTO audit_log (user_id, action, ip_address, user_agent, status, details)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  getAuditLogs: db.prepare(`
    SELECT a.*, u.email as user_email
    FROM audit_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.id DESC LIMIT ?
  `)
} : {};

function cloudError(error, action) {
  if (error) throw new Error(`Cloud authentication ${action} failed (${error.code || 'request error'}).`);
}
function cloudClient() {
  const client = getClient();
  if (!client) throw new Error('Cloud authentication is not configured.');
  return client;
}
function authResult(result, action) { cloudError(result.error, action); return result.data; }

function getUserByEmail(email) {
  if (cloudAuth) return cloudClient().from('auth_users').select('*').eq('email', String(email).trim().toLowerCase()).maybeSingle().then(r => authResult(r, 'user lookup'));
  return queries.getUserByEmail.get(email);
}

function getUserById(id) {
  if (cloudAuth) return cloudClient().from('auth_users').select('*').eq('id', id).maybeSingle().then(r => authResult(r, 'user lookup'));
  return queries.getUserById.get(id);
}

function listUsers() {
  if (cloudAuth) return (async () => {
    const users = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const result = await cloudClient().from('auth_users')
        .select('id,email,name,role,active,totp_enrolled,created_at,locked_until')
        .order('id').range(offset, offset + pageSize - 1);
      const page = authResult(result, 'user list');
      users.push(...(page || []));
      if (!page || page.length < pageSize) return users;
    }
  })();
  return queries.listUsers.all();
}

function createUser({ email, name, password_hash, salt, role, totp_secret = null, totp_enrolled = 0 }) {
  if (cloudAuth) return cloudClient().from('auth_users').insert({ email, name, password_hash, salt, role, totp_secret, totp_enrolled: Boolean(totp_enrolled) }).select('id').single().then(r => authResult(r, 'user creation')).then(row => row.id);
  const result = queries.createUser.run(email, name, password_hash, salt, role, totp_secret, totp_enrolled);
  return result.lastInsertRowid;
}

function deleteUser(id) {
  if (cloudAuth) return cloudClient().from('auth_users').delete().eq('id', id).then(r => authResult(r, 'user deletion'));
  return queries.deleteUser.run(id);
}

function updateUserRole(id, role) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ role, updated_at: new Date().toISOString() }).eq('id', id).then(r => authResult(r, 'role update'));
  return queries.updateUserRole.run(role, id);
}

function updateUserStatus(id, active) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ active: Boolean(active), updated_at: new Date().toISOString() }).eq('id', id).then(r => authResult(r, 'account status update'));
  return queries.updateUserStatus.run(active ? 1 : 0, id);
}

function changeUserPassword(id, passwordHash, salt) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ password_hash: passwordHash, salt, password_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', id).then(r => authResult(r, 'password update'));
  return queries.changeUserPassword.run(passwordHash, salt, id);
}

function updateTotpSecret(id, totpSecret, enrolled = 0) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ totp_secret: totpSecret, totp_enrolled: Boolean(enrolled), updated_at: new Date().toISOString() }).eq('id', id).then(r => authResult(r, '2FA update'));
  return queries.updateTotpSecret.run(totpSecret, enrolled, id);
}

function recordFailedAttempt(id) {
  if (cloudAuth) return cloudClient().rpc('auth_record_failed_attempt', { p_user_id: id }).then(r => authResult(r, 'failed-login update'));
  return queries.recordFailedAttempt.run(id);
}

function resetFailedAttempts(id) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ failed_login_attempts: 0, locked_until: null }).eq('id', id).then(r => authResult(r, 'failed-login reset'));
  return queries.resetFailedAttempts.run(id);
}

function lockAccount(id, lockUntilMs) {
  if (cloudAuth) return cloudClient().from('auth_users').update({ locked_until: lockUntilMs }).eq('id', id).then(r => authResult(r, 'account lock'));
  return queries.lockAccount.run(lockUntilMs, id);
}

function createSession({ id, userId, csrfToken, expiresAt, lastActivity, createdAt }) {
  if (cloudAuth) return cloudClient().from('auth_sessions').insert({ id, user_id: userId, csrf_token: csrfToken, expires_at: expiresAt, last_activity: lastActivity, created_at: createdAt }).then(r => authResult(r, 'session creation'));
  queries.createSession.run(id, userId, csrfToken, expiresAt, lastActivity, createdAt);
}

function getSession(id) {
  if (cloudAuth) return cloudClient().from('auth_sessions').select('id,user_id,csrf_token,expires_at,last_activity,created_at,auth_users!inner(email,name,role,active,locked_until)').eq('id', id).maybeSingle().then(r => {
    const row = authResult(r, 'session lookup');
    if (!row) return null;
    const user = row.auth_users;
    return { ...row, email:user.email, name:user.name, role:user.role, active:user.active, locked_until:user.locked_until };
  });
  return queries.getSession.get(id);
}

function updateSessionActivity(id, lastActivity, expiresAt) {
  if (cloudAuth) return cloudClient().from('auth_sessions').update({ last_activity: lastActivity, expires_at: expiresAt }).eq('id', id).then(r => authResult(r, 'session refresh'));
  queries.updateSessionActivity.run(lastActivity, expiresAt, id);
}

function deleteSession(id) {
  if (cloudAuth) return cloudClient().from('auth_sessions').delete().eq('id', id).then(r => authResult(r, 'session deletion'));
  queries.deleteSession.run(id);
}

function deleteUserSessions(userId) {
  if (cloudAuth) return cloudClient().from('auth_sessions').delete().eq('user_id', userId).then(r => authResult(r, 'session revocation'));
  queries.deleteUserSessions.run(userId);
}

function saveRecoveryCodes(userId, hashedCodes) {
  if (cloudAuth) return cloudClient().from('auth_recovery_codes').delete().eq('user_id', userId).then(r => authResult(r, 'recovery-code reset')).then(() => cloudClient().from('auth_recovery_codes').insert(hashedCodes.map(code_hash => ({ user_id:userId, code_hash })))).then(r => authResult(r, 'recovery-code save'));
  // Clear old recovery codes if re-enrolling
  queries.deleteUserRecoveryCodes.run(userId);
  const insertMany = db.transaction((codes) => {
    for (const hash of codes) {
      queries.insertRecoveryCode.run(userId, hash);
    }
  });
  insertMany(hashedCodes);
}

function getUnusedRecoveryCodes(userId) {
  if (cloudAuth) return cloudClient().from('auth_recovery_codes').select('*').eq('user_id', userId).eq('used', false).then(r => authResult(r, 'recovery-code lookup'));
  return queries.getUnusedRecoveryCodes.all(userId);
}

function markRecoveryCodeUsed(codeId, userId, codeHash) {
  if (cloudAuth) return cloudClient().rpc('auth_consume_recovery_code', { p_user_id:userId, p_code_hash:codeHash }).then(r => authResult(r, 'recovery-code use'));
  return queries.markRecoveryCodeUsed.run(codeId);
}

function logAudit({ userId = null, action, ip = 'unknown', userAgent = 'unknown', status, details = '' }) {
  try {
    if (cloudAuth) return cloudClient().from('auth_audit_log').insert({ user_id:userId, action, ip_address:ip, user_agent:userAgent, status, details }).then(r => authResult(r, 'audit write')).catch(err => console.error('Audit log error:', err.message));
    queries.insertAudit.run(userId, action, ip, userAgent, status, details);
  } catch (err) {
    console.error('Audit log error:', err.message);
  }
}

function getAuditLogs(limit = 100) {
  if (cloudAuth) return cloudClient().from('auth_audit_log').select('*,auth_users(email)').order('id', { ascending:false }).limit(limit).then(r => authResult(r, 'audit lookup')).then(rows => rows.map(a => ({ ...a, user_email:a.auth_users?.email || null })));
  return queries.getAuditLogs.all(limit);
}

module.exports = {
  db,
  getUserByEmail,
  getUserById,
  listUsers,
  createUser,
  deleteUser,
  updateUserRole,
  updateUserStatus,
  changeUserPassword,
  updateTotpSecret,
  recordFailedAttempt,
  resetFailedAttempts,
  lockAccount,
  createSession,
  getSession,
  updateSessionActivity,
  deleteSession,
  deleteUserSessions,
  saveRecoveryCodes,
  getUnusedRecoveryCodes,
  markRecoveryCodeUsed,
  logAudit,
  getAuditLogs
};
