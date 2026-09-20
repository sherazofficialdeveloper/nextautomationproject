-- Migration: Support username-only license model and enforce canonical uniqueness
--
-- 1. Make password_hash and email nullable in users table.
--    License holders and sellers created with only a Username do not require passwords or emails.
-- 2. Enforce case-insensitive unique constraint on username.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique_idx ON users (LOWER(TRIM(username)));

