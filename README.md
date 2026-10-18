# Library Management System

## Current state

This repository preserves the original neumorphic HTML/CSS/JavaScript login and 2FA interface, has an Express authentication service, a Supabase-backed LMS API implementation, a responsive library workspace, an Expo/React Native client, PostgreSQL migrations, and an OpenAPI description. The configured Supabase project has all LMS and authentication tables, required transaction/backup/security procedures, and a private backup bucket. Local authentication data was imported (12 identities, 88 recovery-code hashes, 179 security events; no active sessions). The cloud authentication path passed a live password, TOTP, protected-session, and logout check; temporary check data was removed. Production deployment and native mobile builds have not been verified.

The web UI is served by `server/server.js`. The login request keeps the existing `email` and `password` fields. Public registration is disabled. Administrators create student, librarian, manager, and administrator accounts after the cloud schema is installed.

## Run the existing authentication app locally

1. Install Node.js 20.19 or newer.
2. Copy `server/.env.example` to `server/.env` and replace every placeholder with independently generated secrets. Do not use example values as secrets.
3. Provide `ADMIN_EMAIL` and a unique `ADMIN_PASSWORD` in `server/.env` before first-time setup.
4. For a new Supabase project, apply migrations `001_library.sql` through `005_reader_self_checkout.sql` in order in its SQL Editor. On an existing project, apply any missing migrations in order; the catalogue requires `004_library_catalog.sql`, and student catalogue borrowing requires `005_reader_self_checkout.sql`. Apply SQL before deploying the matching API code.
5. From this directory, run `npm install --prefix server`, then `npm run seed` once, then `npm start`.
6. Open `https://localhost:3000` and accept the local development certificate warning.

The seed script does not print the administrator password. To run the configured installation with cloud authentication, set `AUTH_STORE=supabase` in the protected server environment and restart the API. Keep the local SQLite file as a recovery copy. A live cloud authentication check passed; full library restore workflows still need verification before deployment.

## Existing security controls

- Argon2id password hashing with an HMAC-SHA-256 server-side pepper and a separate random salt.
- TOTP 2FA, encrypted TOTP secrets, one-time hashed recovery codes, lockout, rate limiting, CSRF checks, and role-gated existing user-management endpoints.
- Public account registration is rejected.
- The password hashing service fails closed if Argon2id is unavailable. The prior weaker, incorrect fallback was removed.

Cloud library roles are `student`, `librarian`, `manager`, and `administrator`; they are checked on every library API route. Existing legacy SQLite accounts are mapped to a least-privilege default profile on first library use, and administrators can assign the intended role. The issue procedure enforces a five-open-loan limit. Staff may issue loans for up to 30 days; student catalogue self-checkout is limited to 14 days.

## Configuration

See `server/.env.example`. Important values include `AUTH_STORE` (`sqlite` for local development or `supabase` for cloud authentication), `PEPPER` (random secret, 32+ bytes), `SESSION_SECRET` (random secret, 32+ bytes), and `ENCRYPTION_KEY` (32 random bytes encoded as 64 hexadecimal characters). Keep the same pepper and encryption key used when existing accounts and 2FA secrets were created. Store production values only in a secret manager or protected deployment configuration. `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are used server-side for library data, authentication, and encrypted backups. Never include them in web or Expo settings. The Expo API URL is a public URL and belongs in `mobile/.env`.

## Host the API on AWS

AWS App Runner configuration is in [`apprunner.yaml`](apprunner.yaml). Deployment steps, the required server secrets, and the Expo API URL setup are documented in [`AWS_DEPLOYMENT.md`](AWS_DEPLOYMENT.md). Supabase remains the database; never expose its server key in Expo or source control.

## Automated checks

Run `npm test` or `npm run test:all` from this directory. These checks use temporary local databases and never write to the configured project. `npm run test:cloud-schema` runs offline migration and backup-encryption checks; it does not connect to Supabase.

## Known work remaining

The catalogue offers student self-checkout for available physical copies and eBook licenses. Physical loans are recorded immediately and readers collect the book at the circulation desk. eBook access uses an HTTPS reading-provider URL entered by an administrator; only a reader with that title's active eBook loan receives the link. Use only reading links the library is authorized to provide. Reservation queues, reminders, and hosted eBook file storage are not included. User provisioning updates authentication and library profile stores separately, so it is not a single cross-database transaction.
