-- =====================================================================
-- ADMIN 스키마 (MySQL database `{{admin}}`)
-- 관리자 계정, 분석 실행 상태, 관리자 작업용 outbox.
-- (감사 로그·분석 결과 문서는 MongoDB 로 이동)
-- =====================================================================
CREATE DATABASE IF NOT EXISTS `{{admin}}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `{{admin}}`.admin_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(100) NOT NULL,
  role          ENUM('super', 'manager') NOT NULL DEFAULT 'manager',
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME
) ENGINE=InnoDB;

-- 분석 실행 상태(작은 정형 레코드). 결과 JSON 은 MongoDB analysis_results 에 저장.
CREATE TABLE IF NOT EXISTS `{{admin}}`.analysis_runs (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  status       ENUM('queued', 'running', 'success', 'failed') NOT NULL,
  triggered_by INT,
  started_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at  DATETIME,
  result_id    VARCHAR(40),          -- MongoDB analysis_results._id
  log          TEXT
) ENGINE=InnoDB;

-- Transactional Outbox: 관리자 작업과 같은 트랜잭션으로 기록 → relay 가 RabbitMQ 로 발행
CREATE TABLE IF NOT EXISTS `{{admin}}`.outbox_events (
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
