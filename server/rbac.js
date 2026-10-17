/**
 * RBAC (Role-Based Access Control) and Session Middleware
 * Roles:
 * - inputer: Basic dashboard access only
 * - manager: Inputer permissions + can add an inputer
 * - admin: Inputer permissions + can delete an inputer
 * - administrator: Full control (manage all users, change roles, view audit log)
 */

const { getSession, updateSessionActivity, getUserById, deleteUserSessions } = require('./database');
const { safeCompare } = require('./crypto');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes idle timeout

/**
 * Authentication Middleware:
 * - Reads session_id from httpOnly signed/encrypted cookie
 * - Checks session in SQLite database
 * - Validates 30-minute idle timeout
 * - Automatically slides session expiration on activity
 * - Enforces CSRF token check on state-changing HTTP methods
 */
async function requireAuth(req, res, next) {
 try {
  const authorization = req.get('authorization') || '';
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  const sessionId = req.cookies?.session_id || bearer;

  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.clearCookie('session_id');
    return res.status(401).json({ error: 'Session expired or invalid. Please log in again.' });
  }

  if (!session.active) {
    await deleteUserSessions(session.user_id);
    res.clearCookie('session_id');
    return res.status(401).json({ error: 'Authentication required. Please log in.' });
  }

  const now = Date.now();

  // Check 30-minute idle timeout
  if (now - session.last_activity > IDLE_TIMEOUT_MS || now > session.expires_at) {
    res.clearCookie('session_id');
    return res.status(401).json({ error: 'Session timed out due to 30 minutes of inactivity.' });
  }

  // Check if account was locked while session was active
  if (session.locked_until && session.locked_until > now) {
    res.clearCookie('session_id');
    return res.status(423).json({ error: 'Account is temporarily locked.' });
  }

  // Slide idle timeout
  const newExpiresAt = now + IDLE_TIMEOUT_MS;
  await updateSessionActivity(sessionId, now, newExpiresAt);

  // CSRF Protection for state-changing requests
  const mutatingMethods = ['POST', 'PUT', 'DELETE', 'PATCH'];
  if (mutatingMethods.includes(req.method.toUpperCase())) {
    const clientCsrfToken = req.headers['x-csrf-token'];
    if (!clientCsrfToken || !safeCompare(clientCsrfToken, session.csrf_token)) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token.' });
    }
  }

  // Attach session and user to request object
  req.session = session;
  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role
  };

  next();
 } catch (error) {
  next(error);
 }
}

/**
 * Role-Based Access Control middleware
 * Checks if authenticated user has one of the allowed roles
 */
function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Requires one of: [${allowedRoles.join(', ')}]. Current role: ${req.user.role}`
      });
    }

    next();
  };
}

/**
 * Granular User Management RBAC:
 * - administrator: can manage any user and assign any role
 * - manager: can ONLY create/add users with role 'inputer'
 * - admin: can ONLY delete users whose role is 'inputer'
 */
function canManageTargetUser(action) {
  return async (req, res, next) => {
   try {
    const actorRole = req.user.role;

    if (actorRole === 'administrator') {
      return next(); // Administrators have unrestricted access
    }

    if (action === 'create') {
      const targetRole = req.body?.role || 'inputer';
      if (actorRole === 'manager' && targetRole === 'inputer') {
        return next();
      }
      return res.status(403).json({
        error: 'Managers are only authorized to create users with the "inputer" role.'
      });
    }

    if (action === 'delete') {
      const targetId = parseInt(req.params.id, 10);
      const targetUser = await getUserById(targetId);

      if (!targetUser) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (actorRole === 'admin' && targetUser.role === 'inputer') {
        req.targetUser = targetUser;
        return next();
      }

      return res.status(403).json({
        error: 'Admins are only authorized to delete users with the "inputer" role.'
      });
    }

    return res.status(403).json({ error: 'Action not authorized for your role.' });
   } catch (error) { next(error); }
  };
}

module.exports = {
  requireAuth,
  requireRole,
  canManageTargetUser,
  IDLE_TIMEOUT_MS
};
