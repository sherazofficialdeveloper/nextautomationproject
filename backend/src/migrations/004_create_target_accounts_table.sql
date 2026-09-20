-- Target Accounts table for storing external website credentials
-- Passwords stored here are encrypted using AES-256-GCM (reversible for automation)
-- Strictly isolated per authenticated user (user_id)

CREATE TABLE IF NOT EXISTS target_accounts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username VARCHAR(255) NOT NULL,
    encrypted_password TEXT NOT NULL,
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_target_accounts_user_id ON target_accounts(user_id);

