-- 테스트 전용 SQLite DDL (운영 스키마는 db/schema/catalog.sql 의 MySQL DDL). sales_trend.py 단위 테스트에서만 사용합니다.
-- =====================================================================
-- CATALOG 스키마 (catalog.db, 메인 DB)
-- H&M Personalized Fashion Recommendations 원본 3개 테이블 + 판매용 상품 정보
-- 관리자/이용자 양쪽이 읽는 공용 데이터. 원본 컬럼명을 그대로 유지합니다.
-- =====================================================================
CREATE TABLE IF NOT EXISTS articles (
  article_id                   TEXT PRIMARY KEY,   -- 10자리, 앞자리 0 유지 (예: 0108775015)
  product_code                 TEXT NOT NULL,
  prod_name                    TEXT NOT NULL,
  product_type_no              INTEGER,
  product_type_name            TEXT,
  product_group_name           TEXT,
  graphical_appearance_no      INTEGER,
  graphical_appearance_name    TEXT,
  colour_group_code            TEXT,
  colour_group_name            TEXT,
  perceived_colour_value_id    INTEGER,
  perceived_colour_value_name  TEXT,
  perceived_colour_master_id   INTEGER,
  perceived_colour_master_name TEXT,
  department_no                INTEGER,
  department_name              TEXT,
  index_code                   TEXT,
  index_name                   TEXT,
  index_group_no               INTEGER,
  index_group_name             TEXT,
  section_no                   INTEGER,
  section_name                 TEXT,
  garment_group_no             INTEGER,
  garment_group_name           TEXT,
  detail_desc                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_articles_group ON articles(index_group_name, product_group_name);
CREATE INDEX IF NOT EXISTS idx_articles_code  ON articles(product_code);

CREATE TABLE IF NOT EXISTS customers (
  customer_id            TEXT PRIMARY KEY,
  FN                     REAL,
  Active                 REAL,
  club_member_status     TEXT,
  fashion_news_frequency TEXT,
  age                    INTEGER,
  postal_code            TEXT
);

CREATE TABLE IF NOT EXISTS transactions (
  t_dat            TEXT NOT NULL,     -- YYYY-MM-DD (원본에는 시각 정보가 없음)
  customer_id      TEXT NOT NULL,
  article_id       TEXT NOT NULL,
  price            REAL NOT NULL,     -- H&M이 정규화한 가격
  sales_channel_id INTEGER NOT NULL   -- 1: 오프라인 매장, 2: 온라인
);
CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(t_dat);
CREATE INDEX IF NOT EXISTS idx_tx_article ON transactions(article_id);

-- 판매용 상품 정보 (관리자가 가격/재고/노출 여부를 관리)
CREATE TABLE IF NOT EXISTS products (
  article_id  TEXT PRIMARY KEY REFERENCES articles(article_id),
  price_krw   INTEGER NOT NULL,
  stock       INTEGER NOT NULL DEFAULT 0,
  is_active   INTEGER NOT NULL DEFAULT 1,
  popularity  INTEGER NOT NULL DEFAULT 0,  -- 최근 판매량(정렬용)
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 행사(할인) 상품: PyTorch 분석이 추천한 후보 중 관리자가 승인한 상품만 등록됩니다.
-- 할인가는 저장하지 않고 정가(products.price_krw) × (100 - discount_pct)% 를 100원 단위로 반올림해 계산합니다.
CREATE TABLE IF NOT EXISTS promotions (
  article_id   TEXT PRIMARY KEY,
  discount_pct INTEGER NOT NULL CHECK (discount_pct BETWEEN 5 AND 70),
  reason       TEXT,                 -- 추천 근거 (예: 재고 1년치 이상 · 최근 4주 판매 -80%)
  score        REAL,                 -- PyTorch 추천 점수 (0~1, 직접 등록 시 NULL)
  approved_by  INTEGER,              -- admin.admin_users.id
  approved_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
