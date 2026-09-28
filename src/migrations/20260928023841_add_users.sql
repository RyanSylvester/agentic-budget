-- 20260928023841: add users

-- Users for in-app auth (client-side Argon2id KDF; the server stores only a
-- peppered HMAC verifier, never the password). One row per login identity.
CREATE TABLE users (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  salt       TEXT NOT NULL,
  verifier   TEXT NOT NULL,
  kdf_params TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
