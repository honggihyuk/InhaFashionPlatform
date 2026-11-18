// Transactional Outbox
//
// 문제: "DB 커밋 후 RabbitMQ 발행" 을 따로 하면, 커밋은 됐는데 발행 직전에 프로세스가 죽거나
//       RabbitMQ 가 내려가 있으면 후처리 메시지가 사라집니다(유실).
// 해결: 메시지를 같은 MySQL 트랜잭션 안에서 outbox_events 테이블에 함께 기록합니다.
//       주문이 커밋되면 메시지도 반드시 남고, 롤백되면 메시지도 같이 사라집니다.
//       실제 발행은 relay(messaging/relay.js)가 outbox 를 읽어 RabbitMQ 로 보내고 SENT 로 표시합니다.
const crypto = require('crypto');
const { S } = require('../db/mysql');

const TABLE = { admin: `${S.admin}.outbox_events`, member: `${S.member}.outbox_events` };

/**
 * @param tx       db.transaction 콜백의 tx (같은 트랜잭션으로 기록)
 * @param scope    'admin' | 'member' — 관리자 작업은 admin 스키마, 이용자 작업은 member 스키마 outbox
 * @param type     라우팅 키 (예: order.placed, product.updated)
 * @param data     이벤트 내용
 * @param actor    { type: 'admin'|'user', id, name }
 */
async function enqueue(tx, scope, type, data, actor = null) {
  const event = {
    event_id: crypto.randomUUID(),
    type,
    occurred_at: new Date().toISOString(),
    actor,
    data,
  };
  await tx.exec(`INSERT INTO ${TABLE[scope]} (event_id, routing_key, payload) VALUES (?, ?, ?)`,
    [event.event_id, type, JSON.stringify(event)]);
  return event;
}

/**
 * 기존 이벤트를 그대로(같은 event_id) 다시 발행하도록 outbox 에 넣음 — DLQ 재처리용.
 * 이미 성공한 다른 컨슈머는 processed_messages 에 기록이 있어 건너뛰고, 실패했던 컨슈머만 다시 처리합니다.
 */
async function enqueueExisting(tx, scope, routingKey, event) {
  await tx.exec(`INSERT INTO ${TABLE[scope]} (event_id, routing_key, payload) VALUES (?, ?, ?)`,
    [crypto.randomUUID(), routingKey, JSON.stringify(event)]);
}

module.exports = { enqueue, enqueueExisting, TABLE };
