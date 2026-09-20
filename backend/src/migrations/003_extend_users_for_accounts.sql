-- Account management extensions for the existing users table.
--
-- Adds display/profile fields and audit timestamps. Reuses the existing
-- roles/users schema (no duplicate account tables).
--
-- Status values remain application-enforced (active | inactive | blocked for
-- account management). No DB-wide CHECK is added on purpose: the shared users
-- table will also hold future LICENSE HOLDER accounts whose status set is not
-- defined yet.

ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS contact VARCHAR(200);
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Backfill display name for accounts created before this migration.
UPDATE users SET name = username WHERE name IS NULL;
ALTER TABLE users ALTER COLUMN name SET NOT NULL;

-- Email is a login identifier: prevent case-variant duplicates
-- (the plain UNIQUE constraint on email is case sensitive).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique_idx ON users (lower(email));

CREATE INDEX IF NOT EXISTS idx_users_role_id ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
