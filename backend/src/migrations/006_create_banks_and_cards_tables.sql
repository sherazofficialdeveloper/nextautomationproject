-- Migration 006: Create user_banks and user_cards tables
-- Strictly scoped to the authenticated application user (user_id)

CREATE TABLE IF NOT EXISTS user_banks (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    bank_name VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_user_banks_user_bank UNIQUE (user_id, bank_name)
);

CREATE INDEX IF NOT EXISTS idx_user_banks_user_id ON user_banks(user_id);

CREATE TABLE IF NOT EXISTS user_cards (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    card_type VARCHAR(20) NOT NULL CHECK (card_type IN ('DEBIT', 'CREDIT')),
    bank_name VARCHAR(255) NOT NULL,
    card_holder_name VARCHAR(255),
    card_number_masked VARCHAR(30) NOT NULL,
    encrypted_card_number TEXT NOT NULL,
    encrypted_cvv TEXT,
    expiry_month VARCHAR(10),
    expiry_year VARCHAR(10),
    iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    status VARCHAR(50) DEFAULT 'active' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_cards_user_id ON user_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_user_cards_type ON user_cards(user_id, card_type);

