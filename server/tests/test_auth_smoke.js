// Isolated HTTP regression test: creates and removes its own temporary SQLite DB.
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.AUTH_STORE = 'sqlite';
const dbFile = path.join(os.tmpdir(), `lms-auth-smoke-${process.pid}-${Date.now()}.db`);
process.env.AUTH_DB_PATH = dbFile;

const { app } = require('../server');
const database = require('../database');
const { generateSalt, hashPassword } = require('../crypto');
const { generateSync } = require('otplib');

async function run() {
  const email = 'smoke-admin@example.test';
  const password = 'SmokeTest@Pass123';
  const salt = generateSalt(16);
  database.createUser({ email, name: 'Smoke Admin', password_hash: await hashPassword(password, salt), salt, role: 'administrator' });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const assert = (condition, label) => { if (!condition) throw new Error(`FAIL: ${label}`); console.log(`PASS: ${label}`); };
  async function call(method, route, body, auth) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (auth?.token) headers.Authorization = `Bearer ${auth.token}`;
    if (auth?.csrf) headers['X-CSRF-Token'] = auth.csrf;
    const response = await fetch(root + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { response, data: await response.json().catch(() => ({})) };
  }
  try {
    const page = await fetch(root + '/library.html');
    assert(page.status === 200 && (await page.text()).includes('Library Workspace'),'library workspace page is served');
    const spec = await fetch(root + '/api/openapi.json');
    assert(spec.status === 200 && (await spec.json()).paths['/library/loans'],'OpenAPI document is served');
    const signup = await call('POST','/api/auth/signup',{signupName:'Nope',signupEmail:'new@example.test',signupPassword:'StrongPass@123'});
    assert(signup.response.status === 403,'public registration stays disabled');
    const wrong = await call('POST','/api/auth/login',{email,password:'WrongPass@123'});
    assert(wrong.response.status === 401 && wrong.data.error === 'Invalid credentials','unknown and incorrect passwords receive generic rejection');
    const first = await call('POST','/api/auth/login',{email,password});
    assert(first.response.status === 200 && first.data.step === 2 && first.data.manualSecret,'password step starts 2FA enrollment');
    const code = generateSync({ secret:first.data.manualSecret });
    const verify = await call('POST','/api/auth/2fa',{tempToken:first.data.tempToken,totpCode:code,mobile:true});
    assert(verify.response.status === 200 && verify.data.sessionToken && verify.data.csrfToken,'valid TOTP issues a mobile session and CSRF token');
    const auth = { token:verify.data.sessionToken, csrf:verify.data.csrfToken };
    const me = await call('GET','/api/auth/me',null,auth);
    assert(me.response.status === 200 && me.data.user.email === email,'bearer session authenticates to protected endpoint');
    const noCsrf = await call('POST','/api/auth/password',{currentPassword:password,newPassword:'ChangedPass@123',confirmPassword:'ChangedPass@123'},{token:auth.token});
    assert(noCsrf.response.status === 403,'state-changing requests require CSRF token');
    const changed = await call('POST','/api/auth/password',{currentPassword:password,newPassword:'ChangedPass@123',confirmPassword:'ChangedPass@123'},auth);
    assert(changed.response.status === 200,'password change verifies current password and completes');
    const revoked = await call('GET','/api/auth/me',null,auth);
    assert(revoked.response.status === 401,'password change revokes the old session');
  } finally {
    await new Promise(resolve => server.close(resolve));
    database.db.close();
    for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) fs.rmSync(dbFile + suffix,{force:true});
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
