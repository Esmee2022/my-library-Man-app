/**
 * Database Seed Script
 * Creates the initial 'administrator' account.
 * Run with: npm run seed or node scripts/seed.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  getUserByEmail,
  createUser,
  logAudit
} = require('../database');
const {
  validatePasswordPolicy,
  generateSalt,
  hashPassword
} = require('../crypto');

async function seed() {
  console.log('--- Initializing Administrator Seed Script ---');

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in server/.env before creating the initial administrator.');
  }
  const adminName = 'Primary Administrator';

  // 1. Validate password policy
  const policyCheck = validatePasswordPolicy(adminPassword);
  if (!policyCheck.valid) {
    console.error('Seed Error: Admin password does not meet security policy:', policyCheck.message);
    process.exit(1);
  }

  // 2. Check if admin already exists
  const existing = await getUserByEmail(adminEmail);
  if (existing) {
    console.log(`ℹ️ Administrator (${adminEmail}) already exists. Seed skipped.`);
    process.exit(0);
  }

  // 3. Hash password with Salt + HMAC Pepper + Argon2id
  const salt = generateSalt(16);
  const passwordHash = await hashPassword(adminPassword, salt);

  // 4. Create user record
  const userId = await createUser({
    email: adminEmail,
    name: adminName,
    password_hash: passwordHash,
    salt,
    role: 'administrator',
    totp_secret: null,
    totp_enrolled: 0 // Will enroll 2FA QR code on first login
  });

  // 5. Log audit
  await logAudit({
    userId,
    action: 'SEED_INITIAL_ADMIN',
    ip: '127.0.0.1',
    userAgent: 'seed-script',
    status: 'SUCCESS',
    details: `Seeded initial administrator: ${adminEmail}`
  });

  console.log('✅ Initial administrator created successfully!');
  console.log('----------------------------------------------------');
  console.log(` Email:    ${adminEmail}`);
  console.log(' Password: supplied securely through environment configuration (not printed)');
  console.log(` Role:     administrator`);
  console.log(` 2FA:      Ready for QR code enrollment on first login`);
  console.log('----------------------------------------------------');
}

seed().catch((err) => {
  console.error('Fatal Seed Error:', err);
  process.exit(1);
});
