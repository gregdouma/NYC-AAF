CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  team TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  image_hash TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  amount_cents INTEGER,
  submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT,
  reviewer_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_donations_status_time ON donations(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_approved_team ON donations(status, team);


-- Anonymous, short-lived activity sessions. No name, employee ID, email, or IP is stored.
-- Last-seen 90 seconds means an active meeting page. A recent click-through to
-- the official corporate AAF site is counted for up to 10 minutes.
CREATE TABLE IF NOT EXISTS activity_sessions (
  session_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL,
  clicked_at INTEGER,
  stage TEXT NOT NULL CHECK (stage IN ('view', 'donate', 'upload', 'submitted'))
);
CREATE INDEX IF NOT EXISTS idx_activity_last_seen ON activity_sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_activity_clicked_at ON activity_sessions(clicked_at);
