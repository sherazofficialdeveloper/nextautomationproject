-- License / Access Key management.
--
-- A license always belongs to a Seller (licenses.seller_id -> users.id, role SELLER).
-- A license may optionally reference a License Holder (licenses.user_id -> users.id).
-- The USER / LICENSE HOLDER account module is a future module; the FK is created now
-- so the relationship is enforceable once that module lands.
--
-- Date representation:
--   starts_at / expires_at are PostgreSQL DATE (timezone-free, YYYY-MM-DD).
--   created_at / updated_at are TIMESTAMPTZ (UTC instants).
-- The application server is the single source of truth for "today".
--
-- Foreign keys intentionally have no ON DELETE rule (RESTRICT): deleting a
-- Seller or User account must never silently orphan licenses.

CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    access_key VARCHAR(80) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    duration_value INTEGER NOT NULL,
    duration_unit VARCHAR(10) NOT NULL,
    starts_at DATE NOT NULL,
    expires_at DATE NOT NULL,
    seller_id INTEGER NOT NULL REFERENCES users(id),
    user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT licenses_status_check CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'SUSPENDED')),
    CONSTRAINT licenses_duration_unit_check CHECK (duration_unit IN ('days', 'months', 'years')),
    CONSTRAINT licenses_duration_value_check CHECK (duration_value >= 1),
    CONSTRAINT licenses_dates_check CHECK (expires_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_licenses_seller_id ON licenses(seller_id);
CREATE INDEX IF NOT EXISTS idx_licenses_user_id ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_licenses_expires_at ON licenses(expires_at);