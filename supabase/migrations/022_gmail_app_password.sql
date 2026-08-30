-- 022: Gmail IMAP app-password credential, alongside the existing OAuth
-- refresh token in user_settings. App passwords do not expire — this is the
-- fix for Google killing the refresh token every 7 days while the OAuth
-- consent screen stays in "Testing" publishing status (see errors.ts and
-- Claude HQ/summaries/cardIQ/gmail-autosync-and-imap-migration.md).
--
-- gmail_user is plain (an email address, not a secret). The app password
-- itself follows the exact same encrypted-column pattern already used for
-- anthropic_key_encrypted and google_refresh_token_encrypted (src/lib/crypto.ts).

alter table user_settings
  add column if not exists gmail_user text,
  add column if not exists gmail_app_password_encrypted text;

comment on column user_settings.gmail_user is
  'Gmail address used for IMAP login. Not secret — the app password is what is encrypted.';
comment on column user_settings.gmail_app_password_encrypted is
  'AES-256-GCM encrypted Gmail app password (myaccount.google.com/apppasswords). Never expires, unlike the OAuth refresh token.';
