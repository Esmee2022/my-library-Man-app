/**
 * Cryptographic and Security Utilities
 * - Argon2id hashing; fails closed if the required implementation is unavailable
 * - HMAC-SHA256 pepper applied prior to hashing
 * - Minimum 16-byte random salt per user
 * - Constant-time comparison using crypto.timingSafeEqual
 * - AES-256-GCM encryption for 2FA TOTP secrets
 * - Password complexity enforcement
 */

const crypto = require('crypto');
const argon2 = require('argon2');

// Common passwords list for rejection
const COMMON_PASSWORDS = new Set([
  'password', 'password123', 'admin123', '1234567890', 'qwertyuiop',
  'letmein123', 'welcome123', 'administrator', 'changeme123', 'iloveyou123'
]);

/**
 * Validates password against security policy:
 * - Minimum 10 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one digit
 * - At least one special symbol
 * - Not in common passwords list
 */
function validatePasswordPolicy(password) {
  if (!password || typeof password !== 'string') {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length < 10) {
    return { valid: false, message: 'Password must be at least 10 characters long' };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { valid: false, message: 'Password is too common and easily guessable' };
  }
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasDigit = /[0-9]/.test(password);
  const hasSpecial = /[^A-Za-z0-9]/.test(password);

  if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
    return {
      valid: false,
      message: 'Password must contain uppercase, lowercase, numbers, and symbols'
    };
  }

  return { valid: true };
}

/**
 * Generates a cryptographically secure random salt (minimum 16 bytes)
 */
function generateSalt(bytes = 16) {
  return crypto.randomBytes(Math.max(16, bytes)).toString('hex');
}

/**
 * Applies HMAC-SHA256 pepper to password before hashing
 * Security decision: Pepper is stored in .env, never in DB.
 * Even with a full database dump, attackers cannot crack hashes without the pepper.
 */
function applyPepper(password) {
  const pepper = process.env.PASSWORD_PEPPER || process.env.PEPPER;
  if (!pepper) {
    throw new Error('PASSWORD_PEPPER or PEPPER environment variable is missing');
  }
  return crypto.createHmac('sha256', pepper).update(password).digest('hex');
}

/**
 * Hashes peppered password with Argon2id and the user's independent salt.
 * Fail closed if Argon2id is unavailable; weaker emergency fallbacks are unsafe.
 */
async function hashPassword(password, saltHex) {
  const peppered = applyPepper(password);
  const saltBuf = Buffer.from(saltHex, 'hex');

  if (saltBuf.length < 16) throw new Error('Password salt must be at least 16 bytes');
  return argon2.hash(peppered, {
    salt: saltBuf,
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4
  });
}

/**
 * Constant-time comparison for password verification
 */
async function verifyPassword(password, storedHash) {
  const peppered = applyPepper(password);

  if (storedHash.startsWith('$argon2')) {
    try {
      return await argon2.verify(storedHash, peppered);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Timing-safe string comparison
 * Prevents side-channel timing attacks
 */
function safeCompare(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b));

  if (bufA.length !== bufB.length) {
    // Perform dummy comparison to avoid length-based early return timing leak
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Encrypts 2FA secret using AES-256-GCM before saving to database
 * Security decision: Key stored in .env; unique 12-byte IV per encryption;
 * Auth tag guarantees ciphertext integrity against tampering.
 */
function encryptSecret(plainText) {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is missing');
  }
  const key = Buffer.from(rawKey, 'hex');
  if (key.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  }

  const iv = crypto.randomBytes(12); // 96-bit IV recommended for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plainText, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');

  // Format: iv:tag:encrypted
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

/**
 * Decrypts AES-256-GCM encrypted 2FA secret
 */
function decryptSecret(encryptedPayload) {
  if (!encryptedPayload) return null;
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is missing');
  }
  const key = Buffer.from(rawKey, 'hex');

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted payload format');
  }

  const [ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(dataHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generates a set of 8 random alphanumeric backup recovery codes
 * Returns array of plain codes (to show user once) and their hashes (for DB)
 */
function generateRecoveryCodes(count = 8) {
  const plainCodes = [];
  const hashedCodes = [];

  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
    plainCodes.push(code);

    // Hash recovery code with HMAC pepper for DB storage
    const pepper = process.env.PASSWORD_PEPPER || process.env.PEPPER || 'fallback';
    const hash = crypto.createHmac('sha256', pepper)
      .update(code)
      .digest('hex');
    hashedCodes.push(hash);
  }

  return { plainCodes, hashedCodes };
}

/**
 * Hashes a single recovery code for verification
 */
function hashRecoveryCode(code) {
  const pepper = process.env.PASSWORD_PEPPER || process.env.PEPPER || 'fallback';
  return crypto.createHmac('sha256', pepper)
    .update(code.trim().toUpperCase())
    .digest('hex');
}

module.exports = {
  validatePasswordPolicy,
  generateSalt,
  applyPepper,
  hashPassword,
  verifyPassword,
  safeCompare,
  encryptSecret,
  decryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode
};
