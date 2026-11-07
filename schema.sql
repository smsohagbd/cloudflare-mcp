-- Schema for cloudflare-mcp social automation & logs

CREATE TABLE IF NOT EXISTS post_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  post_id TEXT,
  title TEXT,
  content TEXT NOT NULL,
  media_urls TEXT,
  status TEXT NOT NULL DEFAULT 'published',
  scheduled_at TEXT,
  published_at TEXT,
  response_data TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comments_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  comment_id TEXT,
  author TEXT,
  comment_text TEXT NOT NULL,
  reply_text TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS social_credentials (
  platform TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_type TEXT,
  expires_at TEXT,
  extra_data TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_post_logs_platform ON post_logs(platform);
CREATE INDEX IF NOT EXISTS idx_post_logs_status ON post_logs(status);
CREATE INDEX IF NOT EXISTS idx_comments_platform_post ON comments_log(platform, post_id);

