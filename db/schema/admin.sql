-- =====================================================================
-- ADMIN 스키마 (admin.db → ATTACH AS admin)
-- 관리자 계정, 분석 실행 이력, 관리 작업 감사 로그
-- =====================================================================
CREATE TABLE IF NOT EXISTS admin.admin_users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'manager' CHECK (role IN ('super', 'manager')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS admin.analysis_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  status       TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  triggered_by INTEGER,
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at  TEXT,
  result_path  TEXT,
  summary_json TEXT,
  log          TEXT
);

CREATE TABLE IF NOT EXISTS admin.audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
