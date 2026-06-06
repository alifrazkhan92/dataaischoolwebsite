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

-- Visitor details collected via pre-chat form before the session starts
CREATE TABLE IF NOT EXISTS visitor_sessions (
  session_id    TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,   -- ISO 8601 UTC timestamp
  visitor_name  TEXT,
  visitor_email TEXT,
  visitor_phone TEXT
);

-- Contact form enquiries
CREATE TABLE IF NOT EXISTS enquiries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,       -- ISO 8601 UTC timestamp
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  wa_status  TEXT NOT NULL DEFAULT 'no_phone'  -- 'no_phone' | 'sent' | 'failed'
);

CREATE INDEX IF NOT EXISTS idx_enq_created ON enquiries (created_at);

-- WhatsApp conversation messages (outbound confirmations + inbound user replies)
CREATE TABLE IF NOT EXISTS wa_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  enquiry_id   INTEGER,             -- FK to enquiries.id (nullable for unmatched inbound)
  created_at   TEXT NOT NULL,
  direction    TEXT NOT NULL,       -- 'outbound' | 'inbound'
  wa_phone     TEXT NOT NULL,
  message_text TEXT NOT NULL,
  wa_msg_id    TEXT                 -- WhatsApp message ID from Meta
);

CREATE INDEX IF NOT EXISTS idx_wa_phone ON wa_messages (wa_phone);
CREATE INDEX IF NOT EXISTS idx_wa_enq   ON wa_messages (enquiry_id);
