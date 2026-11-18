// 재시도·DLQ·멱등 처리를 갖춘 RabbitMQ 컨슈머
//
// 처리 흐름 (메시지 1건):
//   1) 멱등 확인  : processed_messages 에 "<큐>:<event_id>" 가 있으면 이미 처리한 메시지 → ack 만 하고 끝
//   2) 핸들러 실행 : 성공하면 processed_messages 기록 후 ack
//                    (관리자가 재처리한 메시지였다면 failed_messages 상태를 RESOLVED 로 바꿈)
//   3) 실패        : x-attempts < 최대 → retry.<n> 대기 큐로 보냄(5초/30초/2분 뒤 자동 복귀) 후 ack
//                    x-attempts = 최대 또는 NonRetryableError → DLQ 로 보냄 후 ack
//   4) 재시도/DLQ 로 보내는 것조차 실패(브로커 장애) → nack(requeue) 로 원래 큐에 남겨 유실 방지
//   5) 컨슈머 프로세스가 처리 중 죽으면 ack 되지 않은 메시지는 RabbitMQ 가 자동으로 다시 전달
//
// ack 는 항상 "다음 위치(재시도 큐/DLQ)에 confirm 으로 안전하게 넣은 뒤" 에만 합니다.
const config = require('../config');
const mongo = require('../db/mongo');
const rabbit = require('./rabbit');

class NonRetryableError extends Error {
  constructor(message) { super(message); this.nonRetryable = true; }
}

const maxRetries = () => config.rabbitmq.retryDelays.length;

/**
 * @param name     QUEUES 의 키 (예: 'search-indexer')
 * @param handler  async (event, ctx) => void
 */
async function consume(name, handler, { prefetch = config.rabbitmq.prefetch, onSettled } = {}) {
  const conn = await rabbit.connect();
  const ch = await conn.createChannel();
  ch.on('error', () => {});
  await ch.prefetch(prefetch);
  const queue = rabbit.qname(name);
  const processed = await mongo.col('processed_messages');
  const failed = await mongo.col('failed_messages');

  const { consumerTag } = await ch.consume(queue, async (msg) => {
    if (!msg) return;
    const headers = msg.properties.headers || {};
    const attempts = Number(headers['x-attempts'] || 0);
    const routingKey = headers['x-routing-key'] || msg.fields.routingKey;
    let event;
    let outcome;
    try {
      try {
        event = JSON.parse(msg.content.toString());
      } catch {
        throw new NonRetryableError('JSON 파싱 실패');
      }
      const key = `${name}:${event.event_id}`;
      if (await processed.findOne({ _id: key }, { projection: { _id: 1 } })) {
        outcome = 'duplicate';
      } else {
        await handler(event, { routingKey, attempts, queue: name });
        await processed.updateOne({ _id: key }, { $setOnInsert: { queue: name, event_id: event.event_id, routing_key: routingKey, processed_at: new Date() } }, { upsert: true });
        await failed.updateOne({ _id: key, status: 'REQUEUED' }, { $set: { status: 'RESOLVED', resolved_at: new Date() } });
        outcome = 'ok';
      }
      ch.ack(msg);
    } catch (err) {
      const nextHeaders = {
        ...headers,
        'x-attempts': attempts + 1,
        'x-routing-key': routingKey,
        'x-queue': name,
        'x-last-error': String(err && err.message).slice(0, 500),
        'x-first-failed-at': headers['x-first-failed-at'] || new Date().toISOString(),
      };
      const props = { contentType: 'application/json', messageId: msg.properties.messageId, type: routingKey, headers: nextHeaders };
      try {
        if (err.nonRetryable || attempts >= maxRetries()) {
          await rabbit.sendToQueue(rabbit.dlqName(name), msg.content, props);
          outcome = 'dead';
        } else {
          await rabbit.sendToQueue(rabbit.retryName(name, attempts + 1), msg.content, props);
          outcome = 'retry';
        }
        ch.ack(msg);
      } catch (sendErr) {
        // 재시도 큐로 옮기지 못함 → 원래 큐에 되돌려 놓음(유실 방지)
        outcome = 'requeued';
        try { ch.nack(msg, false, true); } catch { /* 채널 종료 시 브로커가 자동 재전달 */ }
      }
      if (outcome !== 'retry') console.error(`[${name}] ${outcome}:`, err.message);
    }
    if (onSettled) onSettled({ name, outcome, event, attempts, routingKey });
  });

  return { channel: ch, cancel: async () => { try { await ch.cancel(consumerTag); await ch.close(); } catch { /* 이미 닫힘 */ } } };
}

/**
 * DLQ 보관기: 각 큐의 DLQ 메시지를 MongoDB failed_messages 로 옮겨 관리자가 조회·재처리할 수 있게 함.
 * Mongo 저장에 실패하면 nack(requeue) 해서 DLQ 에 그대로 남깁니다.
 */
async function archiveDeadLetters(onArchived) {
  const conn = await rabbit.connect();
  const ch = await conn.createChannel();
  ch.on('error', () => {});
  await ch.prefetch(20);
  const failed = await mongo.col('failed_messages');
  const tags = [];
  for (const name of Object.keys(rabbit.QUEUES)) {
    const { consumerTag } = await ch.consume(rabbit.dlqName(name), async (msg) => {
      if (!msg) return;
      const h = msg.properties.headers || {};
      let payload;
      try { payload = JSON.parse(msg.content.toString()); } catch { payload = { raw: msg.content.toString() }; }
      try {
        const id = `${name}:${payload.event_id || msg.properties.messageId || Date.now()}`;
        await failed.updateOne({ _id: id }, {
          $set: {
            queue: name, event_id: payload.event_id || null, routing_key: h['x-routing-key'] || msg.properties.type,
            payload, attempts: Number(h['x-attempts'] || 0), error: h['x-last-error'] || null,
            first_failed_at: h['x-first-failed-at'] ? new Date(h['x-first-failed-at']) : new Date(),
            failed_at: new Date(), status: 'FAILED',
          },
          $inc: { times_dead: 1 },
        }, { upsert: true });
        ch.ack(msg);
        if (onArchived) onArchived({ name, id });
      } catch (err) {
        console.error('[dlq-archiver]', err.message);
        ch.nack(msg, false, true);
      }
    });
    tags.push(consumerTag);
  }
  return { cancel: async () => { try { for (const t of tags) await ch.cancel(t); await ch.close(); } catch { /* 무시 */ } } };
}

module.exports = { consume, archiveDeadLetters, NonRetryableError };
