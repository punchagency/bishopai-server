-- ---------------------------------------------------------------------------
-- Local dashboard auth (single-user: Nicole). Enforcement is server-side and
-- toggleable — Nicole flips it on/off from the app's Settings. A singleton row
-- holds the on/off flag, the scrypt password hash, and the HMAC secret tokens
-- are signed with. No external identity provider; this is a local desktop app.
-- ---------------------------------------------------------------------------
CREATE TABLE auth_config (
  id            boolean PRIMARY KEY DEFAULT true,   -- singleton: only one row
  enabled       boolean NOT NULL DEFAULT false,     -- is login required?
  password_hash text,                               -- scrypt: salt:hash (hex)
  token_secret  text,                               -- HMAC key for session tokens
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_config_singleton CHECK (id)
);
INSERT INTO auth_config (id, enabled) VALUES (true, false) ON CONFLICT DO NOTHING;
CREATE TRIGGER auth_config_set_updated_at BEFORE UPDATE ON auth_config
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
