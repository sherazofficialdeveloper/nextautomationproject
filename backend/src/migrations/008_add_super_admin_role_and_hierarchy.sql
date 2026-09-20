-- Migration 008: Add SUPER_ADMIN role and created_by_id hierarchy to users
-- Enables complete Super Admin -> Admin -> Seller organizational hierarchy

INSERT INTO roles (name) VALUES ('SUPER_ADMIN') ON CONFLICT (name) DO NOTHING;

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_created_by ON users(created_by_id);

