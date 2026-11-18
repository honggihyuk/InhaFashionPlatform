-- =====================================================================
-- CATALOG 스키마 (MySQL database `{{catalog}}`)
-- H&M 원본 3개 테이블 + 판매용 상품 정보 + 행사 상품.
-- 재고 차감·가격 변경처럼 정합성이 중요한 데이터라 MySQL(InnoDB 트랜잭션)에 둡니다.
-- =====================================================================
CREATE DATABASE IF NOT EXISTS `{{catalog}}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `{{catalog}}`.articles (
  article_id                   CHAR(10)     NOT NULL PRIMARY KEY,  -- 10자리, 앞자리 0 유지
  product_code                 CHAR(7)      NOT NULL,
  prod_name                    VARCHAR(200) NOT NULL,
  product_type_no              INT,
  product_type_name            VARCHAR(100),
  product_group_name           VARCHAR(100),
  graphical_appearance_no      INT,
  graphical_appearance_name    VARCHAR(100),
  colour_group_code            VARCHAR(4),
  colour_group_name            VARCHAR(100),
  perceived_colour_value_id    INT,
  perceived_colour_value_name  VARCHAR(100),
  perceived_colour_master_id   INT,
  perceived_colour_master_name VARCHAR(100),
  department_no                INT,
  department_name              VARCHAR(200),
  index_code                   VARCHAR(4),
  index_name                   VARCHAR(100),
  index_group_no               INT,
  index_group_name             VARCHAR(100),
  section_no                   INT,
  section_name                 VARCHAR(200),
  garment_group_no             INT,
  garment_group_name           VARCHAR(100),
  detail_desc                  TEXT,
  KEY idx_articles_group (index_group_name, product_group_name),
  KEY idx_articles_code (product_code)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `{{catalog}}`.customers (
  customer_id            CHAR(64) NOT NULL PRIMARY KEY,
  FN                     DOUBLE,
  Active                 DOUBLE,
  club_member_status     VARCHAR(20),
  fashion_news_frequency VARCHAR(20),
  age                    INT,
  postal_code            CHAR(64)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `{{catalog}}`.transactions (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  t_dat            DATE        NOT NULL,   -- 원본에는 시각 정보가 없음
  customer_id      VARCHAR(64) NOT NULL,
  article_id       CHAR(10)    NOT NULL,
  price            DOUBLE      NOT NULL,   -- H&M 정규화 가격
  sales_channel_id TINYINT     NOT NULL,   -- 1: 매장, 2: 온라인
  KEY idx_tx_date (t_dat),
  KEY idx_tx_article (article_id, t_dat),
  KEY idx_tx_customer (customer_id)
) ENGINE=InnoDB;

-- 판매용 상품 정보 (관리자가 가격/재고/노출 여부를 관리)
CREATE TABLE IF NOT EXISTS `{{catalog}}`.products (
  article_id  CHAR(10) NOT NULL PRIMARY KEY,
  price_krw   INT      NOT NULL,
  stock       INT      NOT NULL DEFAULT 0,
  is_active   TINYINT  NOT NULL DEFAULT 1,
  popularity  INT      NOT NULL DEFAULT 0,   -- 최근 판매량(정렬용)
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_stock CHECK (stock >= 0),
  CONSTRAINT fk_products_article FOREIGN KEY (article_id) REFERENCES `{{catalog}}`.articles(article_id)
) ENGINE=InnoDB;

-- 행사(할인) 상품: PyTorch 추천 후보 중 관리자가 승인한 상품
CREATE TABLE IF NOT EXISTS `{{catalog}}`.promotions (
  article_id   CHAR(10)     NOT NULL PRIMARY KEY,
  discount_pct INT          NOT NULL,
  reason       VARCHAR(500),
  score        DOUBLE,
  approved_by  INT,
  approved_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chk_discount CHECK (discount_pct BETWEEN 5 AND 70)
) ENGINE=InnoDB;
