/**
 * Authentication Route Handlers (2FA TOTP, Sessions, Lockout, and Recovery Codes)
 */

const express = require('express');
const crypto = require('crypto');
const { generateSecret, generateURI, verifySync } = require('otplib');
const QRCode = require('qrcode');

const {
  getUserByEmail,
  getUserById,
  changeUserPassword,
  deleteUserSessions,
  createUser,
  updateTotpSecret,
  recordFailedAttempt,
  resetFailedAttempts,
  lockAccount,
  createSession,
  deleteSession,
  saveRecoveryCodes,
  getUnusedRecoveryCodes,
  markRecoveryCodeUsed,
  logAudit
} = require('./database');

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
} = require('./crypto');

const { requireAuth, IDLE_TIMEOUT_MS } = require('./rbac');
const { loginLimiter, totpLimiter } = require('./rateLimiter');
const router = express.Router();

// In-memory temporary tokens for Step 1 -> Step 2 transition (valid for 5 minutes)
const tempTokens = new Map();

// Clean expired temp tokens every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tempTokens.entries()) {
    if (now > data.expiresAt) {
      tempTokens.delete(token);
    }
  }
}, 2 * 60 * 1000).unref();

const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes lockout
const MAX_FAILED_ATTEMPTS = 5;

async function createEnrollment(user) {
  const tempToken = crypto.randomBytes(32).toString('hex');
  tempTokens.set(tempToken, {
    userId: user.id,
    email: user.email,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  // Keep an unfinished enrollment's secret stable across retries and open tabs.
  let plainSecret = user.totp_secret ? decryptSecret(user.totp_secret) : null;
  if (!plainSecret) {
    plainSecret = generateSecret();
    await updateTotpSecret(user.id, encryptSecret(plainSecret), 0);
  }
  // The issuer is only the account name shown by authenticator apps. TOTP
  // parameters remain the standard 6-digit, 30-second SHA-1 defaults.
  const otpauthUrl = generateURI({ secret: plainSecret, label: user.email, issuer: 'Secure Access' });
  const qrCode = await QRCode.toDataURL(otpauthUrl);
  const { plainCodes, hashedCodes } = generateRecoveryCodes(8);
  await saveRecoveryCodes(user.id, hashedCodes);

  return {
    tempToken,
    accountEmail: user.email,
    qrCode,
    manualSecret: plainSecret,
    recoveryCodes: plainCodes
  };
}

/**
 * Helper: client IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Step 1: Login with username/email and password
 * Enforces account lockout, HMAC-peppered Argon2id verification, and rate limiting.
 */
router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const user = await getUserByEmail(email.trim());

  // Generic failure handler to avoid username enumeration
  const handleAuthFailure = async (userId = null) => {
    if (userId) {
      await recordFailedAttempt(userId);
      const updatedUser = await getUserById(userId);
      if (updatedUser && updatedUser.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
        const lockUntil = Date.now() + LOCKOUT_DURATION_MS;
        await lockAccount(userId, lockUntil);
        await logAudit({
          userId,
          action: 'ACCOUNT_LOCKED_FAILED_ATTEMPTS',
          ip,
          userAgent,
          status: 'FAILURE',
          details: `Account locked for 15 minutes after ${MAX_FAILED_ATTEMPTS} failed attempts`
        });
      }
    }
    await logAudit({
      userId,
      action: 'LOGIN_STEP1_FAILED',
      ip,
      userAgent,
      status: 'FAILURE',
      details: 'Invalid credentials attempted'
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  };

  if (!user || !user.active) {
    return await handleAuthFailure(null);
  }

  // Check 15-minute account lockout
  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    await logAudit({
      userId: user.id,
      action: 'LOGIN_REJECTED_ACCOUNT_LOCKED',
      ip,
      userAgent,
      status: 'FAILURE',
      details: 'Sign-in blocked by account security controls'
    });
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Verify password with HMAC-SHA256 pepper and Argon2id
  const passwordValid = await verifyPassword(password, user.password_hash);
  if (!passwordValid) {
    return await handleAuthFailure(user.id);
  }

  // Step 1 Passed! Generate temporary token for Step 2 (TOTP verification)
  const tempToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

  tempTokens.set(tempToken, {
    userId: user.id,
    email: user.email,
    expiresAt
  });

  await logAudit({
    userId: user.id,
    action: 'LOGIN_STEP1_SUCCESS',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: 'Password verified. Proceeding to 2FA Step 2.'
  });

  // Check if TOTP is already enrolled
  if (user.totp_enrolled && user.totp_secret) {
    return res.json({
      message: 'Step 1 verified. Please provide your 2FA TOTP code.',
      step: 2,
      enrolled: true,
      accountEmail: user.email,
      tempToken
    });
  }

  // First time login: Enroll TOTP with QR Code and generate backup recovery codes
  const enrollment = await createEnrollment(user);

  return res.json({
    message: 'First-time 2FA enrollment. Scan QR code and enter TOTP verification code.',
    step: 2,
    enrolled: false,
    ...enrollment
  });
});

/**
 * Step 2: 2FA Verification (TOTP or Backup Recovery Code)
 * Creates session only after BOTH steps pass.
 */
router.post('/2fa', totpLimiter, async (req, res) => {
  const { tempToken, totpCode, recoveryCode, mobile } = req.body || {};
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (!tempToken) {
    return res.status(400).json({ error: '2FA session token missing. Please log in again.' });
  }

  const tokenData = tempTokens.get(tempToken);
  if (!tokenData || Date.now() > tokenData.expiresAt) {
    tempTokens.delete(tempToken);
    return res.status(401).json({ error: '2FA session expired. Please start login again.' });
  }

  const user = await getUserById(tokenData.userId);
  if (!user || !user.active) {
    tempTokens.delete(tempToken);
    return res.status(401).json({ error: 'User not found' });
  }

  // Check account lockout
  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    tempTokens.delete(tempToken);
    return res.status(423).json({
      error: 'Unable to verify sign-in. Check your code or try again later.'
    });
  }

  let verified = false;
  let usedRecovery = false;

  // Option A: Verify TOTP Code
  if (totpCode) {
    try {
      const decryptedSecret = decryptSecret(user.totp_secret);
      if (decryptedSecret) {
        const cleanCode = String(totpCode).trim();
        const result = verifySync({
          token: cleanCode,
          secret: decryptedSecret,
          // Allow up to two 30-second steps of clock drift between server and phone.
          epochTolerance: 60
        });
        if (result && result.valid) {
          verified = true;
        }
      }
    } catch (err) {
      console.error('TOTP verification error:', err.message);
    }
  }

  // Option B: Verify Backup Recovery Code
  if (!verified && recoveryCode) {
    const enteredHash = hashRecoveryCode(recoveryCode);
    const unusedCodes = await getUnusedRecoveryCodes(user.id);

    for (const item of unusedCodes) {
      if (safeCompare(enteredHash, item.code_hash)) {
        verified = await markRecoveryCodeUsed(item.id, user.id, enteredHash);
        usedRecovery = verified;
        break;
      }
    }
  }

  if (!verified) {
    await recordFailedAttempt(user.id);
    const updated = await getUserById(user.id);
    if (updated && updated.failed_login_attempts >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = Date.now() + LOCKOUT_DURATION_MS;
      await lockAccount(user.id, lockUntil);
      tempTokens.delete(tempToken);
      await logAudit({
        userId: user.id,
        action: 'ACCOUNT_LOCKED_2FA_FAILURES',
        ip,
        userAgent,
        status: 'FAILURE',
        details: `Account locked for 15 minutes after ${MAX_FAILED_ATTEMPTS} failed attempts`
      });
      return res.status(423).json({
        error: 'Unable to verify sign-in. Check your code or try again later.'
      });
    }

    await logAudit({
      userId: user.id,
      action: 'LOGIN_2FA_FAILED',
      ip,
      userAgent,
      status: 'FAILURE',
      details: usedRecovery ? 'Invalid recovery code' : 'Invalid TOTP code'
    });

    return res.status(401).json({
      error: 'Invalid verification code. Use the current code from your authenticator app or a saved recovery code.'
    });
  }

  // BOTH STEPS PASSED!
  // Invalidate temp token
  tempTokens.delete(tempToken);

  // If first enrollment, mark totp_enrolled = 1
  if (!user.totp_enrolled) {
    await updateTotpSecret(user.id, user.totp_secret, 1);
  }

  // Reset failed login attempts and clear lockout
  await resetFailedAttempts(user.id);

  // Generate secure session ID and CSRF token
  const sessionId = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(32).toString('hex');
  const sessionExpiresAt = now + IDLE_TIMEOUT_MS;

  await createSession({
    id: sessionId,
    userId: user.id,
    csrfToken,
    expiresAt: sessionExpiresAt,
    lastActivity: now,
    createdAt: now
  });

  // Set httpOnly, secure, sameSite cookie
  res.cookie('session_id', sessionId, {
    httpOnly: true,
    secure: true, // Requires HTTPS
    sameSite: 'strict',
    maxAge: IDLE_TIMEOUT_MS,
    path: '/'
  });

  await logAudit({
    userId: user.id,
    action: 'LOGIN_SUCCESS',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: `Authenticated successfully via ${usedRecovery ? 'Backup Recovery Code' : 'TOTP 2FA'}`
  });

  return res.json({
    message: 'Login successful',
    csrfToken,
    ...(mobile === true ? { sessionToken: sessionId } : {}),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    }
  });
});

/**
 * Logout
 */
router.post('/logout', requireAuth, async (req, res) => {
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';
  // Clear the browser cookie even if the backing session store is temporarily
  // unavailable; otherwise the redirect can immediately sign the user back in.
  res.clearCookie('session_id', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/'
  });

  if (req.session?.id) {
    try {
      await deleteSession(req.session.id);
    } catch (error) {
      console.error('Logout session revocation failed:', error.message);
    }
  }

  await logAudit({
    userId: req.user?.id || null,
    action: 'LOGOUT',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: 'User logged out'
  });

  return res.json({ message: 'Logged out successfully' });
});

/**
 * Current Authenticated User & CSRF token
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: req.user,
    csrfToken: req.session.csrf_token
  });
});

router.post('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword || newPassword !== confirmPassword) return res.status(400).json({ error: 'Enter your current password and matching new password.' });
  const user = await getUserById(req.user.id);
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) return res.status(401).json({ error: 'Current password is incorrect.' });
  const policy = validatePasswordPolicy(newPassword);
  if (!policy.valid) return res.status(400).json({ error: policy.message });
  try {
    const salt = generateSalt(16);
    const passwordHash = await hashPassword(newPassword, salt);
    await changeUserPassword(user.id, passwordHash, salt);
    await deleteUserSessions(user.id);
    await logAudit({ userId: user.id, action: 'PASSWORD_CHANGED', ip: getClientIp(req), userAgent: req.get('user-agent') || 'unknown', status: 'SUCCESS', details: 'Password changed by account owner; all sessions revoked' });
    res.clearCookie('session_id', { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    return res.json({ message: 'Password changed. Please sign in again.' });
  } catch (error) {
    console.error('Password change failed:', error.message);
    return res.status(500).json({ error: 'Password could not be changed.' });
  }
});

/**
 * Public registration is intentionally disabled. Accounts are provisioned by
 * authorized staff through the protected user-management endpoint.
 */
router.post('/signup', loginLimiter, (req, res) => {
  return res.status(403).json({ error: 'Public registration is disabled. Contact a library administrator to request an account.' });
});

module.exports = router;
