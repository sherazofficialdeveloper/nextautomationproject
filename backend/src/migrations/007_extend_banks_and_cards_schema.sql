-- Migration 007: Extend user_banks and user_cards tables for complete desktop form support
-- Adds gateway, user_name, credentials, name_to_save, card_network, pin, card_3d_password

ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS gateway VARCHAR(50) DEFAULT 'IRCTC';
ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS user_name VARCHAR(255);
ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS encrypted_password TEXT;
ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS iv VARCHAR(64);
ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS auth_tag VARCHAR(64);
ALTER TABLE user_banks ADD COLUMN IF NOT EXISTS name_to_save VARCHAR(255);

ALTER TABLE user_banks DROP CONSTRAINT IF EXISTS uq_user_banks_user_bank;

ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS gateway VARCHAR(50) DEFAULT 'IRCTC';
ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS select_your_type VARCHAR(50) DEFAULT 'Credit_Card';
ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS card_network VARCHAR(50);
ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS pin TEXT;
ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS card_3d_password TEXT;
ALTER TABLE user_cards ADD COLUMN IF NOT EXISTS name_to_save VARCHAR(255);

