ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS encrypted_password TEXT,
  ADD COLUMN IF NOT EXISTS password_iv TEXT,
  ADD COLUMN IF NOT EXISTS password_auth_tag TEXT;
