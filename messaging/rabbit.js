// RabbitMQ 연결 + 토폴로지(교환기·큐·재시도 큐·DLQ) 선언
//
//  [publisher] ─▶ {NS}events (topic) ─▶ {NS}q.<name>            ← 컨슈머가 처리
//                                         │ 실패(1~3회)
//                                         ▼
//                         {NS}q.<name>.retry.<n>  (x-message-ttl = 5s / 30s / 2m)
//                                         │ TTL 만료 → dead-letter → 원래 큐로 복귀
//                                         ▼
//                         {NS}q.<name>.dlq        ← 재시도 모두 실패. 관리자 화면에서 재처리
//
// 모든 교환기·큐는 durable, 메시지는 persistent 이고 발행은 publisher confirm 으로 브로커 저장을 확인합니다.
const amqp = require('amqplib');
const config = require('../config');

const NS = config.ns;
const EXCHANGE = config.rabbitmq.exchange;

/** 후처리 큐 정의: 이름 → 바인딩(라우팅 키 패턴) */
const QUEUES = {
  'search-indexer': ['product.*', 'promotion.*', 'order.placed', 'order.cancelled', 'order.status_changed'],
  'user-notifier': ['order.placed', 'order.cancelled', 'order.status_changed'],
  'audit-writer': ['product.updated', 'promotion.*', 'order.status_changed', 'analysis.requested', 'jobs.replayed'],
  'activity-logger': ['product.viewed', 'cart.item_added', 'order.placed'],
  'analysis-runner': ['analysis.requested'],
};

const qname = (name) => `${NS}q.${name}`;
const retryName = (name, n) => `${qname(name)}.retry.${n}`;
const dlqName = (name) => `${qname(name)}.dlq`;

let conn;
let confirmCh;
let connecting;

async function connect() {
  if (conn) return conn;
  if (!connecting) {
    connecting = (async () => {
      const c = await amqp.connect(config.rabbitmq.url, { timeout: 3000 });
      c.on('error', () => {});
      c.on('close', () => { conn = null; confirmCh = null; });
      conn = c;
      return c;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

/** 발행 전용 confirm 채널 (브로커가 디스크에 받았다고 확인해야 resolve) */
async function confirmChannel() {
  if (confirmCh) return confirmCh;
  const c = await connect();
  confirmCh = await c.createConfirmChannel();
  confirmCh.on('error', () => {});
  confirmCh.on('close', () => { confirmCh = null; });
  return confirmCh;
}

async function setupTopology(channel) {
  const ch = channel || await (await connect()).createChannel();
  try {
    await declare(ch);
  } finally {
    if (!channel) await ch.close().catch(() => {});
  }
}

async function declare(ch) {
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  for (const [name, keys] of Object.entries(QUEUES)) {
    await ch.assertQueue(qname(name), { durable: true });
    for (const k of keys) await ch.bindQueue(qname(name), EXCHANGE, k);
    // 재시도 대기 큐: TTL 이 지나면 기본 교환기('')를 통해 원래 큐로 되돌아감
    for (let i = 0; i < config.rabbitmq.retryDelays.length; i += 1) {
      await ch.assertQueue(retryName(name, i + 1), {
        durable: true,
        arguments: {
          'x-message-ttl': config.rabbitmq.retryDelays[i],
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': qname(name),
        },
      });
    }
    await ch.assertQueue(dlqName(name), { durable: true });
  }
}

/** 교환기로 발행하고 브로커 확인(confirm)까지 기다림 */
async function publish(routingKey, event, { headers = {} } = {}) {
  const ch = await confirmChannel();
  await new Promise((resolve, reject) => {
    ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
      persistent: true, contentType: 'application/json', messageId: event.event_id, type: routingKey,
      timestamp: Math.floor(Date.now() / 1000), headers,
    }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 특정 큐(재시도 큐, DLQ)로 직접 보냄 */
async function sendToQueue(queue, content, properties) {
  const ch = await confirmChannel();
  await new Promise((resolve, reject) => {
    ch.sendToQueue(queue, content, { ...properties, persistent: true }, (err) => (err ? reject(err) : resolve()));
  });
}

/** 큐별 대기 메시지 수 (관리자 후처리 화면) */
async function queueStats() {
  const c = await connect();
  const ch = await c.createChannel();
  ch.on('error', () => {});
  try {
    const out = [];
    for (const name of Object.keys(QUEUES)) {
      const main = await ch.checkQueue(qname(name));
      let retry = 0;
      for (let i = 1; i <= config.rabbitmq.retryDelays.length; i += 1) retry += (await ch.checkQueue(retryName(name, i))).messageCount;
      const dlq = await ch.checkQueue(dlqName(name));
      out.push({ name, ready: main.messageCount, consumers: main.consumerCount, retry, dlq: dlq.messageCount, bindings: QUEUES[name] });
    }
    return out;
  } finally {
    try { await ch.close(); } catch { /* 무시 */ }
  }
}

/** 이 네임스페이스의 큐·교환기 삭제 (테스트 정리용) */
async function deleteTopology() {
  const c = await connect();
  const ch = await c.createChannel();
  ch.on('error', () => {});
  for (const name of Object.keys(QUEUES)) {
    for (let i = 1; i <= config.rabbitmq.retryDelays.length; i += 1) await ch.deleteQueue(retryName(name, i));
    await ch.deleteQueue(dlqName(name));
    await ch.deleteQueue(qname(name));
  }
  await ch.deleteExchange(EXCHANGE);
  await ch.close();
}

async function close() {
  if (conn) { const c = conn; conn = null; confirmCh = null; try { await c.close(); } catch { /* 이미 닫힘 */ } }
}

module.exports = { connect, confirmChannel, setupTopology, publish, sendToQueue, queueStats, deleteTopology, close,
  QUEUES, EXCHANGE, qname, retryName, dlqName };
