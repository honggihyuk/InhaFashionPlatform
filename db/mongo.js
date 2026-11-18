// MongoDB 연결 + 컬렉션 정의
// 스키마가 자주 바뀌거나 문서 단위로 통째로 읽고 쓰는 데이터, 계속 쌓이기만 하는 로그성 데이터를 둡니다.
//   analysis_results   PyTorch 분석 결과(수백 KB 중첩 JSON)       — 최신 1건을 통째로 읽음
//   audit_log          관리자 작업 기록 (RabbitMQ 후처리로 기록)  — 계속 쌓이고 필드가 작업마다 다름
//   notifications      이용자 알림 (주문 완료/배송/취소)
//   activity_events    이용자 활동 로그 (상품 조회, 장바구니 담기)
//   processed_messages 컨슈머 멱등 처리 기록 (같은 메시지 두 번 처리 방지)
//   failed_messages    재시도를 모두 실패해 DLQ 로 간 메시지 (관리자 재처리 화면)
const { MongoClient } = require('mongodb');
const config = require('../config');

let client;
let database;

async function db() {
  if (!database) {
    client = new MongoClient(config.mongo.url, { serverSelectionTimeoutMS: 3000 });
    await client.connect();
    database = client.db(config.mongo.db);
  }
  return database;
}

async function col(name) {
  return (await db()).collection(name);
}

async function ensureIndexes() {
  const d = await db();
  await Promise.all([
    d.collection('analysis_results').createIndex({ generated_at: -1 }),
    d.collection('audit_log').createIndex({ created_at: -1 }),
    d.collection('audit_log').createIndex({ action: 1, created_at: -1 }),
    d.collection('notifications').createIndex({ user_id: 1, created_at: -1 }),
    d.collection('activity_events').createIndex({ type: 1, created_at: -1 }),
    d.collection('activity_events').createIndex({ article_id: 1, type: 1 }),
    // 90일 지난 활동 로그는 자동 삭제 (TTL 인덱스)
    d.collection('activity_events').createIndex({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90, name: 'ttl_90d' }),
    d.collection('processed_messages').createIndex({ processed_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14, name: 'ttl_14d' }),
    d.collection('failed_messages').createIndex({ status: 1, failed_at: -1 }),
  ]);
}

async function dropDatabase() {
  await (await db()).dropDatabase();
}

async function close() {
  if (client) { const c = client; client = null; database = null; await c.close(); }
}

module.exports = { db, col, ensureIndexes, dropDatabase, close };
