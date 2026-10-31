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

-- ===== 账号 / 评论 / 认领 / 收录队列(2026-10-11) =====
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,          -- 'email' | 'github'
  identity TEXT NOT NULL,          -- 邮箱或 GitHub 用户 id
  display TEXT,                    -- 评论展示昵称(可为空=匿名)
  created_at TEXT NOT NULL,
  UNIQUE(provider, identity)
);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes(
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);

-- 用户评论:先审后发;一人一站一评(可更新,更新后重新进入待审)
CREATE TABLE IF NOT EXISTS reviews(
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  user_id TEXT NOT NULL,
  stars INTEGER NOT NULL,          -- 自由五星 1-5
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | published | rejected
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reject_reason TEXT,
  station_reply TEXT,
  replied_at TEXT,
  UNIQUE(site, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_site ON reviews(site, status);

-- 收录申请队列(对接 probe onboard 管线,payload 为 schema v1.0.0)
CREATE TABLE IF NOT EXISTS submissions(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'onboarding',
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_reason TEXT
);

-- 站点认领:token 放域名 /.well-known/relaylens-claim.txt 自动验证 + 管理员复核
CREATE TABLE IF NOT EXISTS claims(
  id TEXT PRIMARY KEY,
  site TEXT NOT NULL,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | rejected
  created_at TEXT NOT NULL,
  verified_at TEXT
);