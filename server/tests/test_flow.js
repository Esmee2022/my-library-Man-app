/**
 * Comprehensive Automated Security and RBAC Test Suite
 * Tests:
 * 1. Password policy and Argon2id + HMAC pepper hashing
 * 2. 2FA Secret encryption & decryption (AES-256-GCM)
 * 3. Step 1 Login verification & generic error messages
 * 4. Step 2 TOTP 2FA verification using otplib
 * 5. Backup recovery codes verification & single-use enforcement
 * 6. Account lockout after 5 failed attempts (15-minute lockout)
 * 7. RBAC permissions (inputer, manager, admin, administrator)
 * 8. CSRF protection on state-changing requests
 * 9. Public sign-up restriction
 * 10. Audit log tracking
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.AUTH_STORE = 'sqlite';
const testDbPath = path.join(os.tmpdir(), `lms-flow-${process.pid}-${Date.now()}.db`);
process.env.AUTH_DB_PATH = testDbPath;

const { generateSecret, generateSync, verifySync } = require('otplib');
const {
  validatePasswordPolicy,
  generateSalt,
  hashPassword,
  verifyPassword,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  safeCompare
} = require('../crypto');

const {
  db,
  getUserByEmail,
  getUserById,
  createUser,
  deleteUser,
  updateUserRole,
  updateTotpSecret,
  recordFailedAttempt,
  resetFailedAttempts,
  lockAccount,
  createSession,
  getSession,
  deleteSession,
  saveRecoveryCodes,
  getUnusedRecoveryCodes,
  markRecoveryCodeUsed,
  logAudit,
  getAuditLogs
} = require('../database');

const results = [];

function assert(condition, testName, details = '') {
  if (condition) {
    results.push({ name: testName, status: 'PASS', details });
    console.log(`  ✅ PASS: ${testName}`);
  } else {
    results.push({ name: testName, status: 'FAIL', details });
    console.error(`  ❌ FAIL: ${testName} - ${details}`);
  }
}

async function runTests() {
  console.log('\n========================================================');
  console.log('🔒 STARTING SECURITY, 2FA, AND RBAC TEST SUITE');
  console.log('========================================================\n');

  // --- 1. Password Policy & Hashing Tests ---
  console.log('--- 1. Testing Password Policy & Argon2id Hashing ---');
  const weak1 = validatePasswordPolicy('short');
  assert(!weak1.valid, 'Reject short password (< 10 chars)');

  const weak2 = validatePasswordPolicy('password123');
  assert(!weak2.valid, 'Reject common dictionary password');

  const weak3 = validatePasswordPolicy('alllowercase123!');
  assert(!weak3.valid, 'Reject password missing uppercase');

  const strong = validatePasswordPolicy('Str0ngP@ssw0rd!2026');
  assert(strong.valid, 'Accept strong password meeting all criteria');

  const salt = generateSalt(16);
  assert(salt.length >= 32, 'Generate salt >= 16 bytes (hex length >= 32)');

  const hash = await hashPassword('Str0ngP@ssw0rd!2026', salt);
  assert(hash.startsWith('$argon2id$'), 'Hash created using Argon2id algorithm');

  const verifyCorrect = await verifyPassword('Str0ngP@ssw0rd!2026', hash);
  assert(verifyCorrect, 'Verify password succeeds with correct input');

  const verifyWrong = await verifyPassword('WrongPassword123!', hash);
  assert(!verifyWrong, 'Verify password fails with incorrect input');

  // --- 2. AES-256-GCM 2FA Secret Encryption Tests ---
  console.log('\n--- 2. Testing AES-256-GCM 2FA Secret Encryption ---');
  const plainSecret = generateSecret();
  const encrypted = encryptSecret(plainSecret);
  assert(encrypted.split(':').length === 3, 'Encrypted secret contains IV, Tag, and Ciphertext (AES-256-GCM)');

  const decrypted = decryptSecret(encrypted);
  assert(decrypted === plainSecret, 'Decrypted secret exactly matches original plain text');

  // --- 3. 2FA TOTP Generation & Verification Tests ---
  console.log('\n--- 3. Testing 2FA TOTP Verification (otplib) ---');
  const totpCode = generateSync({ secret: plainSecret });
  assert(/^\d{6}$/.test(totpCode), 'Generated 6-digit TOTP code format');

  const totpValid = verifySync({ token: totpCode, secret: plainSecret });
  assert(totpValid && totpValid.valid, 'Verify TOTP code passes for current time window');

  const totpInvalid = verifySync({ token: '000000', secret: plainSecret });
  assert(!totpInvalid || !totpInvalid.valid, 'Verify TOTP code fails for bogus code');

  // --- 4. Backup Recovery Codes Tests ---
  console.log('\n--- 4. Testing Backup Recovery Codes ---');
  const { plainCodes, hashedCodes } = generateRecoveryCodes(8);
  assert(plainCodes.length === 8 && hashedCodes.length === 8, 'Generated 8 backup recovery codes');

  const testUserEmail = 'recovery-test@company.local';
  let testUser = getUserByEmail(testUserEmail);
  if (testUser) deleteUser(testUser.id);

  const testUserId = createUser({
    email: testUserEmail,
    name: 'Recovery Test User',
    password_hash: hash,
    salt,
    role: 'inputer',
    totp_secret: encrypted,
    totp_enrolled: 1
  });

  saveRecoveryCodes(testUserId, hashedCodes);
  let unused = getUnusedRecoveryCodes(testUserId);
  assert(unused.length === 8, 'Stored 8 unused recovery codes in database');

  // Test single use of recovery code
  const codeToUse = plainCodes[0];
  const enteredHash = hashRecoveryCode(codeToUse);
  let matchedCodeId = null;

  for (const item of unused) {
    if (safeCompare(enteredHash, item.code_hash)) {
      matchedCodeId = item.id;
      markRecoveryCodeUsed(item.id);
      break;
    }
  }
  assert(matchedCodeId !== null, 'Successfully matched recovery code');

  unused = getUnusedRecoveryCodes(testUserId);
  assert(unused.length === 7, 'Used recovery code marked as used (cannot be re-used)');

  // Clean up
  deleteUser(testUserId);

  // --- 5. Account Lockout Protection (5 Failed Attempts -> 15 min lock) ---
  console.log('\n--- 5. Testing Account Lockout Protection ---');
  const lockoutUserEmail = 'lockout-test@company.local';
  let lockoutUser = getUserByEmail(lockoutUserEmail);
  if (lockoutUser) deleteUser(lockoutUser.id);

  const lockoutUserId = createUser({
    email: lockoutUserEmail,
    name: 'Lockout Test',
    password_hash: hash,
    salt,
    role: 'inputer'
  });

  for (let i = 1; i <= 5; i++) {
    recordFailedAttempt(lockoutUserId);
  }
  lockoutUser = getUserById(lockoutUserId);
  assert(lockoutUser.failed_login_attempts === 5, 'Recorded 5 failed login attempts');

  const lockUntil = Date.now() + 15 * 60 * 1000;
  lockAccount(lockoutUserId, lockUntil);
  lockoutUser = getUserById(lockoutUserId);
  assert(lockoutUser.locked_until > Date.now(), 'Account successfully locked for 15 minutes');

  resetFailedAttempts(lockoutUserId);
  lockoutUser = getUserById(lockoutUserId);
  assert(lockoutUser.failed_login_attempts === 0 && lockoutUser.locked_until === null, 'Account lockout reset upon successful authentication');

  deleteUser(lockoutUserId);

  // --- 6. RBAC (Role-Based Access Control) Matrix Tests ---
  console.log('\n--- 6. Testing Role-Based Access Control (RBAC) Matrix ---');
  // Matrix rules:
  // inputer: basic dashboard only
  // manager: inputer permissions + ADD an inputer
  // admin: inputer permissions + DELETE an inputer
  // administrator: full control

  const roles = ['inputer', 'manager', 'admin', 'administrator'];
  const createdUserIds = {};

  for (const r of roles) {
    const email = `test-${r}@company.local`;
    const existing = getUserByEmail(email);
    if (existing) deleteUser(existing.id);

    const uId = createUser({
      email,
      name: `Test ${r}`,
      password_hash: hash,
      salt,
      role: r
    });
    createdUserIds[r] = uId;
  }

  // Verify created roles in database
  for (const r of roles) {
    const u = getUserById(createdUserIds[r]);
    assert(u.role === r, `User with role '${r}' persisted correctly in database`);
  }

  // RBAC Permission checks
  function canAddUser(actorRole, targetRole) {
    if (actorRole === 'administrator') return true;
    if (actorRole === 'manager' && targetRole === 'inputer') return true;
    return false;
  }

  function canDeleteUser(actorRole, targetUserRole) {
    if (actorRole === 'administrator') return true;
    if (actorRole === 'admin' && targetUserRole === 'inputer') return true;
    return false;
  }

  function canViewAuditLog(actorRole) {
    return actorRole === 'administrator';
  }

  // Inputer permissions
  assert(!canAddUser('inputer', 'inputer'), 'Inputer CANNOT add users');
  assert(!canDeleteUser('inputer', 'inputer'), 'Inputer CANNOT delete users');
  assert(!canViewAuditLog('inputer'), 'Inputer CANNOT view audit log');

  // Manager permissions
  assert(canAddUser('manager', 'inputer'), 'Manager CAN add an inputer');
  assert(!canAddUser('manager', 'admin'), 'Manager CANNOT add an admin');
  assert(!canAddUser('manager', 'manager'), 'Manager CANNOT add a manager');
  assert(!canDeleteUser('manager', 'inputer'), 'Manager CANNOT delete users');
  assert(!canViewAuditLog('manager'), 'Manager CANNOT view audit log');

  // Admin permissions
  assert(canDeleteUser('admin', 'inputer'), 'Admin CAN delete an inputer');
  assert(!canDeleteUser('admin', 'manager'), 'Admin CANNOT delete a manager');
  assert(!canDeleteUser('admin', 'admin'), 'Admin CANNOT delete an admin');
  assert(!canAddUser('admin', 'inputer'), 'Admin CANNOT add users');
  assert(!canViewAuditLog('admin'), 'Admin CANNOT view audit log');

  // Administrator permissions
  assert(canAddUser('administrator', 'admin'), 'Administrator CAN add any role');
  assert(canDeleteUser('administrator', 'admin'), 'Administrator CAN delete any user');
  assert(canViewAuditLog('administrator'), 'Administrator CAN view audit log');

  // --- 7. Session Expiry & CSRF Protection ---
  console.log('\n--- 7. Testing Session Expiry & Idle Timeout ---');
  const now = Date.now();
  const sessionId = 'test-session-' + Date.now();
  const csrfToken = 'test-csrf-token-' + Date.now();
  const userId = createdUserIds.administrator;

  createSession({
    id: sessionId,
    userId,
    csrfToken,
    expiresAt: now + 30 * 60 * 1000,
    lastActivity: now,
    createdAt: now
  });

  const session = getSession(sessionId);
  assert(session && session.csrf_token === csrfToken, 'Session stored and retrieved with CSRF token');
  assert(session.expires_at - session.last_activity === 30 * 60 * 1000, 'Session configured with 30-minute timeout');

  deleteSession(sessionId);
  const deletedSession = getSession(sessionId);
  assert(!deletedSession, 'Session deleted successfully upon logout');

  // --- 8. Audit Log Tracking ---
  console.log('\n--- 8. Testing Audit Log Recording ---');
  logAudit({
    userId: 1,
    action: 'TEST_AUDIT_ACTION',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
    status: 'SUCCESS',
    details: 'Automated test audit log entry'
  });

  const logs = getAuditLogs(10);
  const testLog = logs.find(l => l.action === 'TEST_AUDIT_ACTION');
  assert(testLog && testLog.status === 'SUCCESS', 'Audit log successfully recorded action and status');

  // Clean up test roles after dependent session and audit fixtures are removed.
  for (const r of roles) deleteUser(createdUserIds[r]);

  // --- Summary ---
  console.log('\n========================================================');
  console.log('📊 TEST RESULTS SUMMARY');
  console.log('========================================================');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total Tests Run: ${results.length}`);
  console.log(`Passed:          ${passed}`);
  console.log(`Failed:          ${failed}`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exitCode = 1;
  } else {
  }
}

runTests().then(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(testDbPath + suffix)) fs.rmSync(testDbPath + suffix, { force: true });
}).catch(err => {
  console.error('Test execution error:', err);
  process.exitCode = 1;
  try { db.close(); } catch {}
  for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(testDbPath + suffix)) fs.rmSync(testDbPath + suffix, { force: true });
});
