/**
 * One-time migration of authentication records from the local SQLite store.
 * Dry-run by default. Run only after applying 002_auth_cloud.sql and before
 * switching the application to AUTH_STORE=supabase.
 */
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getClient, isConfigured } = require('../supabase');

const sourcePath = process.env.AUTH_DB_PATH || path.join(__dirname, '..', 'database', 'auth.db');
const execute = process.argv.includes('--execute');
const resume = process.argv.includes('--resume');
const batchSize = 250;

function batches(rows) {
  const result = [];
  for (let i = 0; i < rows.length; i += batchSize) result.push(rows.slice(i, i + batchSize));
  return result;
}

function libraryRole(role) {
  if (role === 'administrator') return 'administrator';
  if (role === 'manager') return 'manager';
  if (role === 'admin') return 'librarian';
  return 'student';
}

async function upsertBatches(client, table, rows) {
  for (const chunk of batches(rows)) {
    const { error } = await client.from(table).upsert(chunk, { onConflict: 'id' });
    if (error) throw new Error(`Could not migrate ${table} batch (${error.code || 'cloud error'}).`);
  }
}

async function run() {
  if (!isConfigured()) throw new Error('Configure the Supabase URL and server-only secret key first.');
  const local = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    const users = local.prepare('SELECT * FROM users ORDER BY id').all().map(u => ({
      id: u.id, email: u.email.toLowerCase(), name: u.name, password_hash: u.password_hash, salt: u.salt,
      role: u.role, active: Boolean(u.active), password_changed_at: u.password_changed_at,
      totp_secret: u.totp_secret, totp_enrolled: Boolean(u.totp_enrolled),
      failed_login_attempts: u.failed_login_attempts, locked_until: u.locked_until,
      created_at: u.created_at, updated_at: u.updated_at
    }));
    const userIds = new Set(users.map(u => u.id));
    const sessions = local.prepare('SELECT * FROM sessions WHERE expires_at > ? AND last_activity > ? ORDER BY created_at').all(Date.now(), Date.now() - 30 * 60 * 1000)
      .filter(s => userIds.has(s.user_id)).map(s => ({ id:s.id,user_id:s.user_id,csrf_token:s.csrf_token,expires_at:s.expires_at,last_activity:s.last_activity,created_at:s.created_at }));
    const recoveryCodes = local.prepare('SELECT * FROM recovery_codes ORDER BY id').all().filter(c => userIds.has(c.user_id)).map(c => ({
      id:c.id,user_id:c.user_id,code_hash:c.code_hash,used:Boolean(c.used),used_at:c.used_at,created_at:c.created_at
    }));
    const audit = local.prepare('SELECT * FROM audit_log ORDER BY id').all().map(a => ({
      id:a.id,user_id:userIds.has(a.user_id) ? a.user_id : null,action:a.action,ip_address:a.ip_address,
      user_agent:a.user_agent,status:a.status,details:a.details,timestamp:a.timestamp
    }));
    const profiles = users.map(u => ({ local_user_id:u.id,email:u.email,username:u.email,display_name:u.name || u.email,role:libraryRole(u.role),active:u.active,library_access:true }));
    const counts = { users:users.length, activeSessions:sessions.length, recoveryCodes:recoveryCodes.length, auditEvents:audit.length };
    if (!execute) {
      console.log(JSON.stringify({ mode:'dry-run', source:path.basename(sourcePath), counts, actionRequired:'Review counts, then rerun with --execute to copy data.' }));
      return;
    }
    const client = getClient();
    const { count, error: countError } = await client.from('auth_users').select('id', { count:'exact', head:true });
    if (countError) throw new Error(`Could not inspect cloud authentication store (${countError.code || 'cloud error'}).`);
    if (count && !resume) {
      throw new Error('Cloud authentication already contains users. Refusing to overwrite them. Review the destination and use --resume only if an idempotent import is intended.');
    }
    await upsertBatches(client,'auth_users',users);
    await upsertBatches(client,'auth_sessions',sessions);
    await upsertBatches(client,'auth_recovery_codes',recoveryCodes);
    await upsertBatches(client,'auth_audit_log',audit);
    for (const chunk of batches(profiles)) {
      const { error } = await client.from('lms_users').upsert(chunk,{onConflict:'local_user_id',ignoreDuplicates:true});
      if (error) throw new Error(`Could not synchronize library profiles (${error.code || 'cloud error'}).`);
    }
    const { error } = await client.rpc('auth_finish_import');
    if (error) throw new Error(`Could not align cloud identity sequences (${error.code || 'cloud error'}).`);
    console.log(JSON.stringify({ mode:'completed', counts, notes:['Encrypted TOTP values and one-way password hashes were copied as stored.','Plaintext passwords and pepper values are not present in the source database.','Keep SQLite as the recovery source until cloud authentication has been verified.'] }));
  } finally {
    local.close();
  }
}

run().catch(error => {
  console.error(`Authentication migration failed: ${error.message}`);
  process.exitCode = 1;
});
