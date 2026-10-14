-- Migration 009: Tables for Tours / Tools module
-- Includes: booking_history, proxies, and user_preferences

CREATE TABLE IF NOT EXISTS booking_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ticket_name VARCHAR(255) NOT NULL,
    irctc_id VARCHAR(100),
    from_station VARCHAR(50) NOT NULL,
    to_station VARCHAR(50) NOT NULL,
    journey_date VARCHAR(50) NOT NULL,
    bank_name VARCHAR(255),
    pnr VARCHAR(50),
    fare NUMERIC(10, 2) DEFAULT 0.00,
    booking_date DATE DEFAULT CURRENT_DATE NOT NULL,
    remarks VARCHAR(255) DEFAULT 'Booking Success' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_booking_history_user_id ON booking_history(user_id);
CREATE INDEX IF NOT EXISTS idx_booking_history_booking_date ON booking_history(booking_date);

CREATE TABLE IF NOT EXISTS proxies (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ip VARCHAR(100) NOT NULL,
    port INTEGER NOT NULL,
    username VARCHAR(100),
    password VARCHAR(100),
    encrypted_password TEXT,
    password_iv TEXT,
    password_auth_tag TEXT,
    check_irctc BOOLEAN DEFAULT false,
    status VARCHAR(50) DEFAULT 'untested' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_proxies_user_id ON proxies(user_id);

CREATE TABLE IF NOT EXISTS user_preferences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    history_retention_days INTEGER DEFAULT 30 NOT NULL,
    proxy_pair_limit INTEGER DEFAULT 4 NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
