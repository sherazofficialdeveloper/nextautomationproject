-- Migration 012: Add bank_name and backup_bank to tickets table
-- Preserves user's configured bank choice (iPay-QR, PayTM-QR, PHONEPE-QR, etc.)

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS bank_name VARCHAR(100);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS backup_bank VARCHAR(100);
