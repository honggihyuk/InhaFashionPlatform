-- =====================================================================
-- MEMBER 스키마 (member.db → ATTACH AS member)
-- 이용자 계정, 장바구니, 주문. 관리자 계정과 완전히 분리됩니다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS member.users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT,
  address        TEXT,
  hm_customer_id TEXT,              -- H&M customers.customer_id 와 연결(선택)
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member.cart_items (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  article_id TEXT NOT NULL,
  size       TEXT NOT NULL,
  qty        INTEGER NOT NULL CHECK (qty > 0),
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, article_id, size)
);

CREATE TABLE IF NOT EXISTS member.orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no       TEXT NOT NULL UNIQUE,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'PAID'
                 CHECK (status IN ('PAID', 'SHIPPING', 'DELIVERED', 'CANCELLED')),
  total_krw      INTEGER NOT NULL,
  recipient      TEXT NOT NULL,
  phone          TEXT NOT NULL,
  address        TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  source         TEXT NOT NULL DEFAULT 'web',  -- web: 실제 주문, seed: 개발용 데모 주문
  created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS member.idx_orders_user    ON orders(user_id);
CREATE INDEX IF NOT EXISTS member.idx_orders_created ON orders(created_at);

CREATE TABLE IF NOT EXISTS member.order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  article_id     TEXT NOT NULL,
  prod_name      TEXT NOT NULL,
  size           TEXT NOT NULL,
  qty            INTEGER NOT NULL,
  unit_price_krw INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS member.idx_items_order ON order_items(order_id);
