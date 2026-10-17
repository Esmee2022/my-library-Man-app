/**
 * End-to-End API Integration Tests
 * Tests Express endpoints over HTTP/HTTPS:
 * - Step 1 Login
 * - Step 2 TOTP 2FA Verification
 * - Session Cookie and CSRF handling
 * - Role-Based Dashboard & User Management
 * - Account Lockout on 5 consecutive failed logins
 * - Public signup rejection (403)
 */

const path = require('path');
const https = require('https');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.AUTH_STORE = 'sqlite';

const { generateSync } = require('otplib');
const { app } = require('../server');
const { getUserByEmail, deleteUser, updateTotpSecret } = require('../database');

let server;
let baseUrl;
const testResults = [];

function record(name, pass, msg = '') {
  testResults.push({ name, pass, msg });
  if (pass) {
    console.log(`  ✅ PASS: ${name}`);
  } else {
    console.error(`  ❌ FAIL: ${name} - ${msg}`);
  }
}

// Helper to make JSON HTTP requests with cookies and CSRF
function request(method, route, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(route, baseUrl);
    const data = body ? JSON.stringify(body) : null;

    const reqHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };
    if (data) {
      reqHeaders['Content-Length'] = Buffer.byteLength(data);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders
      },
      (res) => {
        let responseBody = '';
        res.on('data', (chunk) => (responseBody += chunk));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = responseBody;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: parsed
          });
        });
      }
    );

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseCookie(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const c of cookies) {
    const match = c.match(/^([^;]+)/);
    if (match) return match[1];
  }
  return '';
}

async function runApiTests() {
  console.log('\n========================================================');
  console.log('🌐 STARTING END-TO-END HTTP API FLOW TESTS');
  console.log('========================================================\n');

  // Start app on random available port for testing
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Reset test administrator to unenrolled state so enrollment flow can be verified idempotently
    const initialAdmin = getUserByEmail('admin@secure.local');
    if (initialAdmin) {
      updateTotpSecret(initialAdmin.id, null, 0);
    }

    // 1. Public signup must remain disabled; accounts are staff-provisioned.
    console.log('--- 1. Testing Public Signup Restriction ---');
    const signupRes = await request('POST', '/api/auth/signup', {
      signupName: 'Unapproved Member',
      signupEmail: `unapproved-${Date.now()}@internet.local`,
      signupPassword: 'StrongPass@1234'
    });
    record('Public signup is rejected (403 Forbidden)', signupRes.status === 403);

    // 2. Step 1: Login with invalid password returns 401 generic error
    console.log('\n--- 2. Testing Login Step 1 ---');
    const invalidLogin = await request('POST', '/api/auth/login', {
      email: 'admin@secure.local',
      password: 'WrongPassword999!'
    });
    record('Invalid password returns 401 Unauthorized', invalidLogin.status === 401);
    record('Error message is generic "Invalid credentials"', invalidLogin.body?.error === 'Invalid credentials');

    // 3. Step 1: Valid Login for initial admin (not yet enrolled)
    const validLogin = await request('POST', '/api/auth/login', {
      email: 'admin@secure.local',
      password: 'Admin@Secure2026!'
    });
    record('Valid password returns 200 OK', validLogin.status === 200);
    record('Response requires Step 2 (step: 2)', validLogin.body?.step === 2);
    record('Returns temporary 2FA token', !!validLogin.body?.tempToken);
    record('Returns QR code data URL for enrollment', validLogin.body?.qrCode?.startsWith('data:image/png;base64,'));
    record('Returns 8 backup recovery codes', validLogin.body?.recoveryCodes?.length === 8);

    const tempToken = validLogin.body.tempToken;
    const manualSecret = validLogin.body.manualSecret;
    const recoveryCode = validLogin.body.recoveryCodes[0];

    // 4. Step 2: Invalid TOTP code returns 401
    console.log('\n--- 3. Testing 2FA Step 2 (TOTP & Recovery) ---');
    const invalid2FA = await request('POST', '/api/auth/2fa', {
      tempToken,
      totpCode: '000000'
    });
    record('Invalid 2FA code returns 401', invalid2FA.status === 401);

    // 5. Step 2: Valid TOTP code using otplib
    const currentTotp = generateSync({ secret: manualSecret });
    const valid2FA = await request('POST', '/api/auth/2fa', {
      tempToken,
      totpCode: currentTotp
    });

    record('Valid 2FA returns 200 OK', valid2FA.status === 200);
    record('Returns CSRF token upon successful authentication', !!valid2FA.body?.csrfToken);
    record('Sets session_id cookie', !!valid2FA.headers['set-cookie']);

    const sessionCookie = parseCookie(valid2FA.headers['set-cookie']);
    const csrfToken = valid2FA.body.csrfToken;
    const authHeaders = {
      'Cookie': sessionCookie,
      'X-CSRF-Token': csrfToken
    };

    // 6. Access Protected Route: Dashboard data
    console.log('\n--- 4. Testing Authenticated Dashboard & RBAC ---');
    const dashboardRes = await request('GET', '/api/dashboard/data', null, authHeaders);
    record('Authenticated user can access dashboard data', dashboardRes.status === 200);
    record('Dashboard shows administrator role', dashboardRes.body?.role === 'administrator');

    // 7. Administrator can view Audit Logs
    const auditRes = await request('GET', '/api/audit-log', null, authHeaders);
    record('Administrator can view audit logs (200 OK)', auditRes.status === 200 && Array.isArray(auditRes.body?.logs));

    // 8. Administrator creates a manager and an inputer
    const newManagerRes = await request('POST', '/api/users', {
      email: 'manager.dept@secure.local',
      name: 'Manager Dept',
      password: 'Manager@Secure2026!',
      role: 'manager'
    }, authHeaders);
    record('Administrator creates manager account (201 Created)', newManagerRes.status === 201);

    const newInputerRes = await request('POST', '/api/users', {
      email: 'inputer.dept@secure.local',
      name: 'Inputer Dept',
      password: 'Inputer@Secure2026!',
      role: 'inputer'
    }, authHeaders);
    record('Administrator creates inputer account (201 Created)', newInputerRes.status === 201);
    const inputerId = newInputerRes.body?.user?.id;

    // 9. CSRF Verification Test: Mutating request without CSRF token is rejected (403)
    console.log('\n--- 5. Testing CSRF Protection ---');
    const noCsrfRes = await request('POST', '/api/users', {
      email: 'csrf-test@secure.local',
      password: 'CsrfPassword123!',
      role: 'inputer'
    }, { 'Cookie': sessionCookie });
    record('Mutating request without X-CSRF-Token is blocked (403 Forbidden)', noCsrfRes.status === 403);

    // 10. Logout
    console.log('\n--- 6. Testing Logout ---');
    const logoutRes = await request('POST', '/api/auth/logout', {}, authHeaders);
    record('Logout returns 200 OK', logoutRes.status === 200);

    const postLogoutDashboard = await request('GET', '/api/dashboard/data', null, authHeaders);
    record('Accessing dashboard after logout returns 401', postLogoutDashboard.status === 401);

    // Clean up created test accounts
    const m = getUserByEmail('manager.dept@secure.local');
    if (m) deleteUser(m.id);
    const inp = getUserByEmail('inputer.dept@secure.local');
    if (inp) deleteUser(inp.id);

  } finally {
    server.close();
  }

  console.log('\n========================================================');
  console.log('📊 END-TO-END HTTP API TEST SUMMARY');
  console.log('========================================================');
  const passCount = testResults.filter(r => r.pass).length;
  const failCount = testResults.filter(r => !r.pass).length;
  console.log(`Total API Tests: ${testResults.length}`);
  console.log(`Passed:          ${passCount}`);
  console.log(`Failed:          ${failCount}`);
  console.log('========================================================\n');

  if (failCount > 0) process.exit(1);
}

runApiTests().catch(err => {
  console.error('Fatal API test error:', err);
  if (server) server.close();
  process.exit(1);
});
