// Safe offline checks for the cloud migration and backup encryption.
// This file deliberately makes no Supabase requests and never changes remote data.
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { encryptSecret, decryptSecret } = require('../crypto');

const migration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '001_library.sql'), 'utf8');
const catalogMigration = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrations', '004_library_catalog.sql'), 'utf8');
const apiSpec = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8'));
let passed = 0;
function check(condition, label) {
  if (!condition) throw new Error(`FAIL: ${label}`);
  passed += 1;
  console.log(`PASS: ${label}`);
}

const sample = JSON.stringify({ schemaVersion: 1, books: [], copies: [], loans: [], users: [], auditEvents: [] });
const sealed = encryptSecret(sample);
check(decryptSecret(sealed) === sample, 'encrypted snapshot round-trips with authenticated encryption');
let tamperRejected = false;
const [iv, tag, ciphertext] = sealed.split(':');
const changedCiphertext = `${ciphertext[0] === '0' ? '1' : '0'}${ciphertext.slice(1)}`;
try { decryptSecret(`${iv}:${tag}:${changedCiphertext}`); } catch { tamperRejected = true; }
check(tamperRejected, 'tampered backup data fails authentication');
for (const table of ['lms_users', 'books', 'book_copies', 'loans', 'audit_events', 'backup_metadata']) {
  check(new RegExp(`create table if not exists public\\.${table}\\b`, 'i').test(migration), `${table} is included in migration`);
}
check(/enable row level security/i.test(migration) && /revoke all .* from anon,authenticated/i.test(migration), 'cloud tables deny direct browser-role access');
check(/create_lms_snapshot[\s\S]*?jsonb_build_object[\s\S]*?auditEvents/i.test(migration), 'backup snapshot is assembled in one consistent database statement');
check(/lms_schema_health[\s\S]*?issue[\s\S]*?restore/i.test(migration), 'health check verifies required transaction and backup procedures');
check(/issue_book_copy[\s\S]*?for update/i.test(migration) && /return_book_copy/i.test(migration), 'transaction-safe issue and return procedures are present');
check(/restore_lms_snapshot[\s\S]*?schemaVersion[\s\S]*?delete from loans/i.test(migration), 'restore procedure validates version before replacing library records');
check(/create table if not exists public\.book_categories/i.test(catalogMigration), 'catalog migration adds a normalized book category table');
check(/add column if not exists format text not null default 'physical'/i.test(catalogMigration) && /ebook_copies_need_url_check/i.test(catalogMigration), 'catalog migration tracks physical copies and linked eBook licenses');
check((catalogMigration.match(/\('(?:pride-prejudice|frankenstein|sherlock-holmes|alice-wonderland|moby-dick|jane-eyre|little-women|dracula|time-machine|war-worlds|tom-sawyer|two-cities|wuthering-heights|dorian-gray|secret-garden|wizard-oz|around-world|count-monte-cristo|republic|art-of-war|the-hobbit|nineteen-eighty-four|mockingbird|sapiens|brief-history-time|clean-code|atomic-habits|educated|very-hungry-caterpillar|little-prince)'/g) || []).length >= 25, 'catalog migration seeds a broad starter collection');
check(/category_id[\s\S]*?format[\s\S]*?digital_url/i.test(catalogMigration), 'updated restore procedure preserves catalogue and eBook metadata');
check(Boolean(apiSpec.paths?.['/library/backups/{id}/preview']) && Boolean(apiSpec.paths?.['/library/backups/{id}/restore']), 'OpenAPI documents backup preview and restore routes');
check(Boolean(apiSpec.paths?.['/library/categories']), 'OpenAPI documents the library category endpoint');
console.log(`Passed ${passed} offline cloud-schema checks. These do not verify the configured Supabase project.`);
