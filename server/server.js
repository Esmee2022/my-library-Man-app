/**
 * HTTPS Express Server
 * Features:
 * - Local server over HTTPS using self-signed certificate
 * - Strict CORS restricted to frontend origin
 * - Helmet security headers (CSP, HSTS, X-Content-Type-Options)
 * - Cookie parser for httpOnly, secure, sameSite session cookies
 * - Parameterized SQLite database
 * - RBAC middleware on all protected endpoints
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getOrGenerateCertificate } = require('./certs/certManager');
const authRoutes = require('./auth');
const userRoutes = require('./users');
const libraryRoutes = require('./library');
const { apiLimiter } = require('./rateLimiter');
const { getClient: getSupabaseClient, isConfigured: isSupabaseConfigured } = require('./supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || `https://localhost:${PORT}`;
const WEB_ORIGINS = new Set([FRONTEND_ORIGIN, ...(process.env.WEB_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean)]);
const AUTH_STORE_NAME = process.env.AUTH_STORE === 'supabase' ? 'supabase-postgres' : 'local-development-sqlite';

// 1. Helmet Security Headers with custom Content Security Policy (CSP)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", ...WEB_ORIGINS]
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// 2. Strict CORS Configuration
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, or same-origin)
      if (!origin || WEB_ORIGINS.has(origin) || origin === `https://127.0.0.1:${PORT}`) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS policy for untrusted origin.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization']
  })
);

// 3. Body and Cookie Parsers
app.use(express.json({ limit: '50kb' })); // Restrict payload size
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(cookieParser(process.env.SESSION_SECRET));

// 4. Rate limiting on API
app.use('/api', apiLimiter);

// 5. Mount API Routes
app.use('/api/auth', authRoutes);
app.use('/api', userRoutes);
app.use('/api', libraryRoutes);

app.get('/api/health', async (req, res) => {
  if (!isSupabaseConfigured()) return res.status(503).json({ status: 'degraded', authenticationStore: AUTH_STORE_NAME, libraryDatabase: 'not_configured' });
  try {
    const client = getSupabaseClient();
    const tables = ['lms_users','books','book_copies','loans','audit_events','backup_metadata'];
    if (AUTH_STORE_NAME === 'supabase-postgres') tables.push('auth_users','auth_sessions','auth_recovery_codes','auth_audit_log','auth_challenges');
    const checks = await Promise.all(tables.map(table =>
      client.from(table).select('*', { head: true }).limit(0)
    ));
    const { data: routines, error: routineError } = await client.rpc('lms_schema_health');
    const routinesReady = routines && ['issue','return','snapshot','restore'].every(key => routines[key] === true);
    let authReady = true;
    if (AUTH_STORE_NAME === 'supabase-postgres') {
      const { data, error } = await client.rpc('auth_schema_health');
      authReady = data === true && !error;
    }
    if (checks.some(result => result.error) || routineError || !routinesReady || !authReady) return res.status(503).json({ status: 'degraded', authenticationStore: AUTH_STORE_NAME, libraryDatabase: 'migration_required_or_unavailable' });
    return res.json({ status: 'ok', authenticationStore: AUTH_STORE_NAME, libraryDatabase: 'ready' });
  } catch {
    return res.status(503).json({ status: 'degraded', authenticationStore: AUTH_STORE_NAME, libraryDatabase: 'unavailable' });
  }
});
app.get('/api/openapi.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'openapi.json'));
});

// 6. Serve Existing Frontend Files
// Serve the maintained project root first. The nested folder is an older UI copy.
const candidates = [
  path.join(__dirname, '..'),
  path.join(__dirname, '..', '111-Login & Sign Up Form'),
];
const frontendDir = candidates.find(d => fs.existsSync(path.join(d, 'index.html'))) || candidates[1];

app.use(express.static(frontendDir));

// Fallback to index.html for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

// 7. Global Error Handler (Generic error messages; never leak stack traces)
app.use((err, req, res, next) => {
  console.error('[Server Error]:', err.message);
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: 'CORS forbidden' });
  }
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

// 8. Server Initialization (HTTPS by default, HTTP with --http flag)
const http = require('http');

async function startServer() {
  const pepper = process.env.PASSWORD_PEPPER || process.env.PEPPER || '';
  const sessionSecret = process.env.SESSION_SECRET || '';
  const encryptionKey = process.env.ENCRYPTION_KEY || '';
  const invalid = pepper.length < 32 || pepper.startsWith('replace_') || sessionSecret.length < 32 || sessionSecret.startsWith('replace_') || !/^[a-f0-9]{64}$/i.test(encryptionKey) || encryptionKey.startsWith('replace_');
  if (invalid) {
    console.error('Required security configuration is missing or invalid. Check PEPPER, SESSION_SECRET, and ENCRYPTION_KEY.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && process.env.AUTH_STORE !== 'supabase') {
    console.error('Production startup is disabled until authentication data is migrated from local SQLite to managed PostgreSQL.');
    process.exit(1);
  }
  const isHttp = process.argv.includes('--http') || process.env.USE_HTTPS === 'false';

  try {
    let serverInstance;

    if (isHttp) {
      serverInstance = http.createServer(app);
      serverInstance.listen(PORT, '0.0.0.0', () => {
        console.log('====================================================');
        console.log(`🌐 HTTP Server running at http://localhost:${PORT} and http://127.0.0.1:${PORT}`);
        console.log(`📁 Serving frontend from: ${frontendDir}`);
        console.log(`🛡️  RBAC & 2FA TOTP Protection Active`);
        console.log('====================================================');
      });
    } else {
      const credentials = await getOrGenerateCertificate();
      serverInstance = https.createServer(
        {
          key: credentials.key,
          cert: credentials.cert
        },
        app
      );

      serverInstance.listen(PORT, '0.0.0.0', () => {
        console.log('====================================================');
        console.log(`🔒 HTTPS Server running securely at:`);
        console.log(`   👉 https://localhost:${PORT}`);
        console.log(`   👉 https://127.0.0.1:${PORT}`);
        console.log(`📁 Serving frontend from: ${frontendDir}`);
        console.log(`🛡️  RBAC & 2FA TOTP Protection Active`);
        console.log('====================================================');
      });
    }

    serverInstance.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
        console.error(`👉 Fix: Change PORT in server/.env (e.g., PORT=3001) or terminate the process on port ${PORT}.\n`);
      } else {
        console.error('\n❌ Fatal Server Error:', err.message);
      }
      process.exit(1);
    });

    return serverInstance;
  } catch (err) {
    console.error('Fatal: Failed to start server:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, startServer };
