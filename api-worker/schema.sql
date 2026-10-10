-- RelayLens API D1 schema (idempotent)
CREATE TABLE IF NOT EXISTS batches(
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_batches_site ON batches(site, started_at DESC);

CREATE TABLE IF NOT EXISTS rounds(
  batch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  model TEXT,
  in_tok INTEGER, cached_tok INTEGER, out_tok INTEGER,
  should_cost REAL, actual_cost REAL, ttft_ms INTEGER,
  PRIMARY KEY(batch_id, seq)
);

-- only SHA-256 of keys stored, plaintext never persisted
CREATE TABLE IF NOT EXISTS keys(
  hash TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  trial_until TEXT,
  email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage(
  subject TEXT NOT NULL,
  minute TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(subject, minute)
);

CREATE TABLE IF NOT EXISTS webhooks(
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta(
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);