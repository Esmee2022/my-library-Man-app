-- ====================================================================
-- SUPABASE ONLINE BACKUP DATABASE SCHEMA
-- Purpose: Offsite backup for local user accounts & authentication events
-- Project: Secure Access Auth System with 2FA TOTP & Supabase Online Backup
-- Security Classification: Confidential (Confidentiality & Integrity controls applied)
-- ====================================================================

-- --------------------------------------------------------------------
-- 1. Table: user_backup
-- Stores non-sensitive user account metadata to allow offsite account reconstruction.
-- ZERO CREDENTIALS: Never stores plaintext passwords, hashes, salts, peppers,
-- TOTP secrets, session IDs, or CSRF tokens.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_backup (
    local_user_id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    role TEXT NOT NULL CHECK (role IN ('inputer', 'manager', 'admin', 'administrator')),
    totp_enrolled BOOLEAN NOT NULL DEFAULT FALSE,
    account_created_at TIMESTAMPTZ,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for efficient lookup
CREATE INDEX IF NOT EXISTS idx_user_backup_email ON user_backup(email);
CREATE INDEX IF NOT EXISTS idx_user_backup_role ON user_backup(role);

-- --------------------------------------------------------------------
-- 2. Table: login_activity
-- Immutable audit log of authentication attempts (success and failure).
-- Protected by server-generated UUID primary key to guarantee idempotent retries.
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_activity (
    event_id UUID PRIMARY KEY,
    local_user_id INTEGER REFERENCES user_backup(local_user_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'LOGIN_SUCCESS',
        'LOGIN_FAILURE_BAD_CREDENTIALS',
        'LOGIN_FAILURE_LOCKED',
        'LOGIN_FAILURE_2FA'
    )),
    auth_method TEXT NOT NULL CHECK (auth_method IN (
        'PASSWORD_TOTP',
        'PASSWORD_RECOVERY_CODE',
        'NONE',
        'UNKNOWN'
    )),
    status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILURE')),
    ip_address TEXT,
    user_agent TEXT,
    event_timestamp TIMESTAMPTZ NOT NULL,
    backup_timestamp TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for activity log analysis and timeline auditing
CREATE INDEX IF NOT EXISTS idx_login_activity_user_id ON login_activity(local_user_id);
CREATE INDEX IF NOT EXISTS idx_login_activity_timestamp ON login_activity(event_timestamp);
CREATE INDEX IF NOT EXISTS idx_login_activity_status ON login_activity(status);

-- --------------------------------------------------------------------
-- 3. Row Level Security (RLS) & Permissions
-- Enforce the Confidentiality and Integrity principles of the CIA Triad.
-- --------------------------------------------------------------------

-- Enable Row Level Security on both backup tables
ALTER TABLE user_backup ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_activity ENABLE ROW LEVEL SECURITY;

-- Revoke default public/anon/authenticated access to ensure zero public exposure.
-- Only the trusted backend service role (SUPABASE_SECRET_KEY) can access these tables.
REVOKE ALL ON TABLE user_backup FROM anon, authenticated;
REVOKE ALL ON TABLE login_activity FROM anon, authenticated;

-- Explicitly ensure NO policies grant access to anon or authenticated users.
-- With RLS enabled and zero permissive policies for anon/authenticated, any
-- direct request from frontend browsers or API requests with anon keys are
-- completely blocked (HTTP 403 / empty response).

-- The trusted Node.js backend connects using SUPABASE_SECRET_KEY (service_role),
-- which bypasses RLS by design in PostgreSQL/Supabase, ensuring secure server-to-server sync.
