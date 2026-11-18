-- =====================================================================
-- MEMBER 스키마 (MySQL database `{{member}}`)
-- 이용자 계정, 장바구니, 주문, 이용자 작업용 outbox. 관리자 계정과 완전히 분리됩니다.
-- =====================================================================
CREATE DATABASE IF NOT EXISTS `{{member}}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `{{member}}`.users (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  email          VARCHAR(190) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  name           VARCHAR(100) NOT NULL,
  phone          VARCHAR(30),
  address        VARCHAR(300),
  hm_customer_id CHAR(64),
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `{{member}}`.cart_items (
  user_id    INT         NOT NULL,
  article_id CHAR(10)    NOT NULL,
  size       VARCHAR(20) NOT NULL,
  qty        INT         NOT NULL,
  added_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, article_id, size),
  CONSTRAINT chk_qty CHECK (qty > 0),
  CONSTRAINT fk_cart_user FOREIGN KEY (user_id) REFERENCES `{{member}}`.users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `{{member}}`.orders (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  order_no       VARCHAR(30)  NOT NULL UNIQUE,
  user_id        INT          NOT NULL,
  status         ENUM('PAID', 'SHIPPING', 'DELIVERED', 'CANCELLED') NOT NULL DEFAULT 'PAID',
  total_krw      INT          NOT NULL,
  recipient      VARCHAR(100) NOT NULL,
  phone          VARCHAR(30)  NOT NULL,
  address        VARCHAR(300) NOT NULL,
  payment_method VARCHAR(20)  NOT NULL,
  source         VARCHAR(10)  NOT NULL DEFAULT 'web',   -- web: 실제 주문, seed: 개발용 데모 주문
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- 서버 시간대(아래 time_zone) 기준
  KEY idx_orders_user (user_id),
  KEY idx_orders_created (created_at),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES `{{member}}`.users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `{{member}}`.order_items (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  order_id       INT          NOT NULL,
  article_id     CHAR(10)     NOT NULL,
  prod_name      VARCHAR(200) NOT NULL,
  size           VARCHAR(20)  NOT NULL,
  qty            INT          NOT NULL,
  unit_price_krw INT          NOT NULL,
  KEY idx_items_order (order_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES `{{member}}`.orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Transactional Outbox: 주문/취소/장바구니 등 이용자 작업과 같은 트랜잭션으로 기록
CREATE TABLE IF NOT EXISTS `{{member}}`.outbox_events (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id        CHAR(36)     NOT NULL UNIQUE,
  routing_key     VARCHAR(100) NOT NULL,
  payload         JSON         NOT NULL,
  status          ENUM('PENDING', 'SENT') NOT NULL DEFAULT 'PENDING',
  attempts        INT          NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_error      VARCHAR(500),
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at         DATETIME(3),
  KEY idx_outbox_pending (status, next_attempt_at)
) ENGINE=InnoDB;
