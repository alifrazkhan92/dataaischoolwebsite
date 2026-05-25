-- DAIS AI Chat conversation log schema
-- Applied to Cloudflare D1 database: dais-chat-logs

CREATE TABLE IF NOT EXISTS chat_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,  -- ISO 8601 UTC timestamp
  visitor_msg TEXT    NOT NULL,
  ai_reply    TEXT    NOT NULL,
  turn        INTEGER NOT NULL DEFAULT 1  -- turn number within the session
);

CREATE INDEX IF NOT EXISTS idx_session   ON chat_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_created   ON chat_logs (created_at);
