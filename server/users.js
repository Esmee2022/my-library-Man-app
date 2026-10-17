/**
 * User Management and RBAC-Protected Routes
 */

const express = require('express');
const {
  listUsers,
  getUserById,
  getUserByEmail,
  createUser,
  deleteUser,
  updateUserRole,
  logAudit,
  getAuditLogs
} = require('./database');
const { deleteUserSessions } = require('./database');
const { validatePasswordPolicy, generateSalt, hashPassword } = require('./crypto');
const { requireAuth, requireRole, canManageTargetUser } = require('./rbac');
const { getClient, isConfigured } = require('./supabase');

const router = express.Router();

function inspectPasswordHash(encodedHash) {
  const hash = typeof encodedHash === 'string' ? encodedHash : '';
  const argon = /^\$(argon2id|argon2i|argon2d)\$v=(\d+)\$([^$]+)\$/.exec(hash);
  if (argon) {
    const values = Object.fromEntries(argon[3].split(',').map(part => part.split('=')));
    const numbers = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]));
    if (Number.isSafeInteger(numbers.m) && Number.isSafeInteger(numbers.t) && Number.isSafeInteger(numbers.p)) {
      return {
        algorithm: ({ argon2id: 'Argon2id', argon2i: 'Argon2i', argon2d: 'Argon2d' })[argon[1]],
        parameters: { version: Number(argon[2]), memoryKiB: numbers.m, iterations: numbers.t, parallelism: numbers.p }
      };
    }
  }

  const bcrypt = /^\$2([aby])\$(\d{2})\$/.exec(hash);
  if (bcrypt) return { algorithm: 'bcrypt', parameters: { cost: Number(bcrypt[2]), variant: `2${bcrypt[1]}` } };

  const scrypt = /^\$scrypt\$(?:ln=(\d+)|N=(\d+)),r=(\d+),p=(\d+)\$/.exec(hash);
  if (scrypt) {
    const workFactor = Number(scrypt[1] ? 2 ** Number(scrypt[1]) : scrypt[2]);
    return { algorithm: 'scrypt', parameters: { cost: workFactor, blockSize: Number(scrypt[3]), parallelization: Number(scrypt[4]) } };
  }

  const pbkdf2 = /^\$pbkdf2-(sha(?:1|256|512))\$i=(\d+)\$/.exec(hash);
  if (pbkdf2) return { algorithm: `PBKDF2-${pbkdf2[1].toUpperCase()}`, parameters: { iterations: Number(pbkdf2[2]) } };
  return { algorithm: 'Unrecognized stored format', parameters: { available: false, reason: 'This hash format does not encode its parameters.' } };
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
}

/**
 * Basic Dashboard Data (All authenticated roles: inputer, manager, admin, administrator)
 */
router.get('/dashboard/data', requireAuth, (req, res) => {
  res.json({
    role: req.user.role,
    user: req.user,
    systemInfo: {
      serverTime: new Date().toISOString(),
      encryption: 'AES-256-GCM',
      hashing: 'Argon2id with HMAC-SHA256 Pepper'
    },
    message: `Welcome to the secure dashboard, ${req.user.name || req.user.email}!`
  });
});

/**
 * List Users:
 * Available to: manager, admin, administrator
 */
router.get('/users', requireAuth, requireRole(['administrator']), async (req, res) => {
  const users = await listUsers();
  res.json({ users });
});

router.get('/users/:id/security', requireAuth, requireRole(['administrator']), async (req, res) => {
  const target = await getUserById(Number(req.params.id));
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const reveal = req.query.reveal === '1';
  const hashMetadata = inspectPasswordHash(target.password_hash);
  res.json({ security: {
    id: target.id, email: target.email, role: target.role, active: Boolean(target.active),
    salt: target.salt, passwordHash: reveal ? target.password_hash : `••••••••${String(target.password_hash).slice(-8)}`,
    hashingAlgorithm: hashMetadata.algorithm,
    parameters: hashMetadata.parameters,
    twoFactorEnabled: Boolean(target.totp_enrolled), passwordChangedAt: target.password_changed_at
  }});
});

/**
 * Add / Create User:
 * - administrator: can create any role (inputer, manager, admin, administrator)
 * - manager: can ONLY create users with role 'inputer'
 * - admin / inputer: not authorized
 */
router.post('/users', requireAuth, requireRole(['administrator']), async (req, res) => {
  const { email, name, password, libraryRole } = req.body || {};
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  const validRoles = ['student', 'librarian', 'manager', 'administrator'];
  if (!validRoles.includes(libraryRole)) {
    return res.status(400).json({ error: `Role must be one of: ${validRoles.join(', ')}` });
  }
  const targetRole = ['manager', 'administrator'].includes(libraryRole) ? libraryRole : 'inputer';

  // Validate password against policy
  const policyCheck = validatePasswordPolicy(password);
  if (!policyCheck.valid) {
    return res.status(400).json({ error: policyCheck.message });
  }

  // Check unique email
  const existing = await getUserByEmail(email.trim());
  if (existing) {
    return res.status(409).json({ error: 'A user with this email address already exists' });
  }

  // Hash password with salt + HMAC pepper + Argon2id
  const salt = generateSalt(16);
  const passwordHash = await hashPassword(password, salt);

  const userId = await createUser({
    email: email.trim().toLowerCase(),
    name: name ? name.trim() : null,
    password_hash: passwordHash,
    salt,
    role: targetRole,
    totp_secret: null,
    totp_enrolled: 0 // Will enroll on first login
  });

  if (!isConfigured()) {
    await deleteUser(userId);
    return res.status(503).json({ error: 'Cloud library database is not configured.' });
  }
  const { error: profileError } = await getClient().from('lms_users').insert({
    local_user_id: userId,
    email: email.trim().toLowerCase(),
    username: email.trim().toLowerCase(),
    display_name: name ? name.trim() : email.trim(),
    role: libraryRole
  });
  if (profileError) {
    await deleteUser(userId);
    return res.status(503).json({ error: 'Cloud profile creation failed. Apply the LMS database migration and try again.' });
  }

  await logAudit({
    userId: req.user.id,
    action: 'USER_CREATED',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: `Created user ${email} with role '${libraryRole}'`
  });

  res.status(201).json({
    message: `User created successfully with role '${libraryRole}'`,
    user: {
      id: userId,
      email: email.trim().toLowerCase(),
      name,
      role: libraryRole
    }
  });
});

/**
 * Delete User:
 * - administrator: can delete any user (except cannot delete self)
 * - admin: can ONLY delete users with role 'inputer'
 * - manager / inputer: not authorized
 */
router.delete('/users/:id', requireAuth, requireRole(['administrator']), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }

  const targetUser = await getUserById(targetId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (targetUser.role === 'administrator' && targetUser.active) {
    const activeAdmins = (await listUsers()).filter(user => user.role === 'administrator' && user.active);
    if (activeAdmins.length <= 1) return res.status(409).json({ error: 'The last active administrator cannot be deleted.' });
  }

  if (isConfigured()) {
    const { error } = await getClient().from('lms_users').update({ active: false, library_access: false }).eq('local_user_id', targetId);
    if (error) return res.status(503).json({ error: 'Cloud account could not be deactivated.' });
  }
  await deleteUser(targetId);

  await logAudit({
    userId: req.user.id,
    action: 'USER_ACCOUNT_DELETED',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: `Removed login for ${targetUser.email} (role: ${targetUser.role}); library history retained`
  });

  res.json({ message: `Account ${targetUser.email} deleted. Library history is retained.` });
});

/**
 * Update Role:
 * - administrator ONLY
 */
router.patch('/users/:id/role', requireAuth, requireRole(['administrator']), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const { role } = req.body || {};
  const ip = getClientIp(req);
  const userAgent = req.headers['user-agent'] || 'unknown';

  const validRoles = ['student', 'librarian', 'manager', 'administrator'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: `Invalid role. Must be one of: ${validRoles.join(', ')}` });
  }

  const targetUser = await getUserById(targetId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!isConfigured()) return res.status(503).json({ error: 'Cloud library database is not configured.' });
  const { error: profileError } = await getClient().from('lms_users').update({ role }).eq('local_user_id', targetId);
  if (profileError) return res.status(503).json({ error: 'Cloud role update failed.' });
  await updateUserRole(targetId, ['manager', 'administrator'].includes(role) ? role : 'inputer');
  await deleteUserSessions(targetId);
  await logAudit({
    userId: req.user.id,
    action: 'ROLE_UPDATED',
    ip,
    userAgent,
    status: 'SUCCESS',
    details: `Updated role of ${targetUser.email} from '${targetUser.role}' to '${role}'`
  });

  res.json({ message: `Role updated to '${role}'` });
});

/**
 * View Audit Logs:
 * - administrator ONLY
 */
router.get('/audit-log', requireAuth, requireRole(['administrator']), async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const logs = await getAuditLogs(limit);
  res.json({ logs });
});

module.exports = router;
