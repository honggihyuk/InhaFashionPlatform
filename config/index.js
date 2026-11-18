// 애플리케이션 설정 (Spring의 application.properties 역할)
// 모든 값은 환경변수로 덮어쓸 수 있습니다. 기본값은 docker-compose.yml 의 개발 환경과 맞춰져 있습니다.
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const env = process.env;

// 네임스페이스: MySQL 스키마, MongoDB DB, Elasticsearch 인덱스, RabbitMQ 큐 이름 앞에 붙는 접두사.
// 테스트는 파일마다 고유한 NS(t_xxx_)를 써서 개발 데이터와 섞이지 않습니다.
const NS = env.INHA_NS || 'inha_';

module.exports = {
  root: ROOT,
  ns: NS,
  port: Number(env.PORT) || 3000,
  sessionSecret: env.SESSION_SECRET || 'inha-fashion-dev-secret-change-me',

  // ---- MySQL: 트랜잭션이 필요한 정형 데이터 (상품·재고·주문·계정·outbox) ----
  mysql: {
    host: env.MYSQL_HOST || '127.0.0.1',
    port: Number(env.MYSQL_PORT) || 3306,
    user: env.MYSQL_USER || 'inha',
    password: env.MYSQL_PASSWORD || 'inha-pass',
    // 관리자/이용자 스키마 분리: 하나의 MySQL 서버 안에 세 개의 스키마(database)
    schemas: {
      catalog: `${NS}catalog`, // H&M 원본 + 판매 상품·행사
      admin: `${NS}admin`, // 관리자 계정, 분석 실행 상태, 관리자 outbox
      member: `${NS}member`, // 이용자 계정, 장바구니, 주문, 이용자 outbox
    },
    connectionLimit: Number(env.MYSQL_POOL) || 10,
    // 주문 시각(시간대 분석) 기준 시간대. 기본 한국 표준시
    timeZone: env.DB_TIME_ZONE || '+09:00',
  },
  schemaDir: path.join(ROOT, 'db', 'schema'),

  // ---- MongoDB: 문서형·로그성 데이터 (분석 결과, 감사 로그, 알림, 활동 로그, 실패 메시지) ----
  mongo: {
    url: env.MONGO_URL || 'mongodb://127.0.0.1:27017',
    db: env.MONGO_DB || `${NS}docs`,
  },

  // ---- Elasticsearch: 관리자 상품 검색 ----
  elasticsearch: {
    url: env.ES_URL || 'http://127.0.0.1:9200',
    productIndex: `${NS}products`,
  },

  // ---- RabbitMQ: 트랜잭션 밖으로 분리한 후처리 ----
  rabbitmq: {
    url: env.AMQP_URL || 'amqp://inha:inha-pass@127.0.0.1:5672',
    exchange: `${NS}events`,
    // 재시도 대기 시간(ms). 1회차 5초, 2회차 30초, 3회차 2분 뒤 다시 처리하고, 그래도 실패하면 DLQ(격리 큐)로 보냅니다.
    retryDelays: (env.MQ_RETRY_DELAYS || '5000,30000,120000').split(',').map(Number),
    prefetch: 10,
  },
  outbox: {
    pollMs: Number(env.OUTBOX_POLL_MS) || 300,
    batch: 100,
    // 발행 실패 시 재시도 간격: min(2^attempts 초, 60초)
    maxBackoffSec: 60,
  },

  analysis: {
    python: env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    script: path.join(ROOT, 'analysis', 'sales_trend.py'),
    workDir: path.join(ROOT, 'data', 'analysis'),
  },
  images: {
    dir: path.join(ROOT, 'public', 'images', 'articles'),
  },
  shippingFeeKrw: 3000,
  freeShippingOverKrw: 50000,
};
