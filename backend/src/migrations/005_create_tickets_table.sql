-- Tickets table for persisting journey details, train choices, passengers, and booking preferences
-- Associated strictly with the authenticated application user and their saved IRCTC target account

CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    irctc_account_id INTEGER NOT NULL REFERENCES target_accounts(id) ON DELETE CASCADE,
    ticket_name VARCHAR(255) NOT NULL,
    from_station VARCHAR(255) NOT NULL,
    to_station VARCHAR(255) NOT NULL,
    journey_date DATE NOT NULL,
    quota VARCHAR(50) DEFAULT 'General' NOT NULL,
    selected_class VARCHAR(50),
    train_number VARCHAR(50),
    train_name VARCHAR(255),
    boarding_point VARCHAR(255),
    journey_time VARCHAR(100),
    slot_time VARCHAR(100),
    passengers JSONB NOT NULL DEFAULT '[]'::jsonb,
    mobile_number VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    payment_method VARCHAR(100) DEFAULT 'Default Payment (Auto)' NOT NULL,
    status VARCHAR(50) DEFAULT 'saved' NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_irctc_account_id ON tickets(irctc_account_id);

