// 후처리 아키텍처: Transactional Outbox → RabbitMQ → 컨슈머 (재시도 → DLQ → MongoDB 보관 → 관리자 재처리), 멱등 처리
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  setup, cleanup, startServer, startWorker, waitFor, drained, Client, ACCOUNTS, ARTICLES, db, S, mongo, config,
} = require('./helpers/setup');

const rabbit = require('../messaging/rabbit');
const relay = require('../messaging/relay');
const outbox = require('../messaging/outbox');
const handlers = require('../workers/handlers');
const { NonRetryableError } = require('../messaging/consumer');
const cart = require('../models/cart');
const order = require('../models/order');

const TEE = ARTICLES.tee.article_id;
const SHIPPING = { recipient: '김인하', phone: '010-1234-5678', address: '인천', payment_method: 'card', agree: '1' };
const MAX_ATTEMPTS = config.rabbitmq.retryDelays.length + 1; // 최초 1회 + 재시도

// 실패 주입: user-notifier 핸들러를 바꿔치기할 수 있게 감쌈
const faults = { notifier: null };
const testHandlers = {
  'user-notifier': async (event, ctx) => {
    if (faults.notifier) return faults.notifier(event, ctx);
    return handlers['user-notifier'](event, ctx);
  },
};

const col = (name) => mongo.col(name);
const notificationsFor = async (orderNo) => (await col('notifications')).find({ order_no: orderNo }).toArray();
const outboxRows = (scope) => db.query(`SELECT * FROM ${S[scope]}.outbox_events ORDER BY id`);

let server; let user; let admin; let worker;
before(async () => {
  await setup();
  worker = await startWorker({ handlers: testHandlers, relay: false }); // relay 는 테스트마다 직접 제어
  server = await startServer();
  user = new Client(server.base);
  admin = new Client(server.base);
  await user.login(ACCOUNTS.user);
  await admin.login(ACCOUNTS.admin, 'admin');
});
after(async () => { await server.close(); await worker.stop(); await cleanup(); });
beforeEach(async () => {
  faults.notifier = null;
  // 이전 테스트가 남긴 outbox·큐를 모두 처리한 뒤 relay 를 멈춘 상태로 시작
  relay.start();
  await drained();
  await relay.stop();
  await cart.clear(db, ACCOUNTS.user.id);
  await db.exec(`UPDATE ${S.catalog}.products SET stock = 50 WHERE article_id = ?`, [TEE]);
});

async function placeOrder() {
  await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1 });
  await user.get('/checkout');
  const res = await user.post('/checkout', SHIPPING);
  assert.equal(res.status, 302);
  return res.location.match(/\/orders\/([^?]+)/)[1];
}

describe('Transactional Outbox', () => {
  test('주문은 RabbitMQ 없이도 커밋되고, 이벤트는 같은 트랜잭션으로 outbox 에 PENDING 으로 남음', async () => {
    const orderNo = await placeOrder();
    const o = await order.getForUser(orderNo, ACCOUNTS.user.id);
    assert.equal(o.status, 'PAID');
    const rows = (await outboxRows('member')).filter((r) => r.routing_key === 'order.placed');
    const row = rows.find((r) => r.payload.data.order_no === orderNo);
    assert.ok(row, 'order.placed 이벤트');
    assert.equal(row.status, 'PENDING');
    assert.match(row.event_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(row.payload.data.article_ids, [TEE]);
    assert.deepEqual(row.payload.actor, { type: 'user', id: ACCOUNTS.user.id, name: ACCOUNTS.user.name });
    assert.equal((await notificationsFor(orderNo)).length, 0, 'relay 가 돌기 전에는 알림이 없음');
    // relay 가 발행하면 컨슈머가 알림을 만든다
    relay.start();
    const [n] = await waitFor(async () => { const x = await notificationsFor(orderNo); return x.length && x; });
    assert.equal(n.title, '주문이 접수되었습니다');
    assert.equal(n.user_id, ACCOUNTS.user.id);
    assert.equal(n.read, false);
    await drained();
    const sent = (await outboxRows('member')).find((r) => r.event_id === row.event_id);
    assert.equal(sent.status, 'SENT');
    assert.ok(sent.sent_at);
  });

  test('주문 트랜잭션이 실패(재고 부족)하면 outbox 이벤트도 남지 않음 (함께 롤백)', async () => {
    const before = (await outboxRows('member')).length;
    await db.exec(`UPDATE ${S.catalog}.products SET stock = 1 WHERE article_id = ?`, [TEE]);
    await user.post('/cart/add', { article_id: TEE, size: 'M', qty: 1 });
    await db.exec(`UPDATE ${S.catalog}.products SET stock = 0 WHERE article_id = ?`, [TEE]);
    await user.get('/checkout');
    const res = await user.post('/checkout', SHIPPING);
    assert.equal(res.status, 400);
    const added = (await outboxRows('member')).slice(before);
    assert.deepEqual(added.map((r) => r.routing_key), ['cart.item_added'], '장바구니 담기 이벤트만 있고 order.placed 는 없음');
  });

  test('RabbitMQ 발행이 실패하면 outbox 에 남아 백오프 후 다시 발행 (유실 없음)', async () => {
    const original = rabbit.publish;
    let calls = 0;
    rabbit.publish = async () => { calls += 1; throw new Error('Socket closed abruptly'); };
    try {
      const before = (await outboxRows('member')).length;
      const orderNo = await placeOrder();
      await relay.drainOnce();
      const rows = (await outboxRows('member')).slice(before);
      assert.deepEqual(rows.map((r) => r.routing_key), ['cart.item_added', 'order.placed']);
      assert.ok(rows.every((r) => r.status === 'PENDING'), '발행 실패 → 그대로 PENDING');
      const [first] = rows;
      assert.equal(first.attempts, 1);
      assert.match(first.last_error, /Socket closed/);
      assert.equal(rows[1].attempts, 0, '브로커 장애로 판단해 이번 회차의 나머지는 시도하지 않음');
      const wait = await db.one(`SELECT TIMESTAMPDIFF(MICROSECOND, CURRENT_TIMESTAMP(3), next_attempt_at) / 1e6 AS sec FROM ${S.member}.outbox_events WHERE id = ?`, [first.id]);
      assert.ok(wait.sec > 1 && wait.sec <= 2.1, `1회 실패 후 약 2초 뒤 재시도 (${wait.sec})`);
      assert.equal(calls, 1);
      // 관리자 화면에도 발행 지연이 보임
      const page = await admin.get('/admin/jobs');
      assert.match(page.text, /RabbitMQ 발행이 실패해 outbox 에서 다시 시도하는 중입니다/);
      // 브로커 복구 → 아직 시도하지 않은 행은 바로, 실패했던 행은 백오프(2초)가 지난 뒤 발행
      rabbit.publish = original;
      relay.start();
      await waitFor(async () => (await notificationsFor(orderNo)).length === 1, { message: '복구 후 알림' });
      await waitFor(async () => (await db.one(`SELECT COUNT(*) AS n FROM ${S.member}.outbox_events WHERE id IN (?) AND status = 'SENT'`, [rows.map((r) => r.id)])).n === 2,
        { timeout: 6000, message: '백오프 후 발행' });
      const after = await db.query(`SELECT routing_key, status, attempts, last_error FROM ${S.member}.outbox_events WHERE id IN (?) ORDER BY id`, [rows.map((r) => r.id)]);
      assert.deepEqual(after.map((r) => ({ ...r })), [
        { routing_key: 'cart.item_added', status: 'SENT', attempts: 2, last_error: null },
        { routing_key: 'order.placed', status: 'SENT', attempts: 1, last_error: null },
      ]);
    } finally {
      rabbit.publish = original;
    }
  });

  test('같은 이벤트가 두 번 발행돼도(최소 한 번 전달) 알림은 하나만 (멱등)', async () => {
    const orderNo = await placeOrder();
    relay.start();
    await waitFor(async () => (await notificationsFor(orderNo)).length === 1);
    await drained();
    const row = (await outboxRows('member')).find((r) => r.routing_key === 'order.placed' && r.payload.data.order_no === orderNo);
    const settledBefore = worker.settled.length;
    await rabbit.publish('order.placed', row.payload); // relay 가 confirm 후 SENT 기록 전에 죽은 상황
    await waitFor(() => worker.settled.slice(settledBefore).filter((e) => e.event && e.event.event_id === row.event_id).length >= 3,
      { message: '중복 메시지 처리' });
    const dup = worker.settled.slice(settledBefore).filter((e) => e.event && e.event.event_id === row.event_id);
    assert.deepEqual(dup.map((e) => e.name).sort(), ['activity-logger', 'search-indexer', 'user-notifier'], 'order.placed 를 구독하는 3개 큐');
    assert.ok(dup.every((e) => e.outcome === 'duplicate'), JSON.stringify(dup.map((e) => [e.name, e.outcome])));
    assert.equal((await notificationsFor(orderNo)).length, 1);
    const purchases = await (await col('activity_events')).countDocuments({ _id: { $regex: `^${row.event_id}:` } });
    assert.equal(purchases, 1, '활동 로그도 한 번만');
  });
});

describe('재시도 → DLQ → MongoDB 보관 → 관리자 재처리', () => {
  test(`핸들러가 계속 실패하면 ${MAX_ATTEMPTS}번 시도 후 DLQ, 실패 목록에 보관. 다른 큐는 정상 처리`, async () => {
    const seen = [];
    faults.notifier = async (event, ctx) => { seen.push(ctx.attempts); throw new Error('MongoDB write timeout (테스트)'); };
    relay.start();
    const orderNo = await placeOrder();
    const id = await waitFor(async () => {
      const doc = await (await col('failed_messages')).findOne({ queue: 'user-notifier', 'payload.data.order_no': orderNo });
      return doc && doc._id;
    }, { timeout: 10000, message: 'DLQ 보관' });
    const doc = await (await col('failed_messages')).findOne({ _id: id });
    assert.equal(doc.status, 'FAILED');
    assert.equal(doc.routing_key, 'order.placed');
    assert.equal(doc.attempts, MAX_ATTEMPTS);
    assert.match(doc.error, /MongoDB write timeout/);
    assert.deepEqual(seen, [...Array(MAX_ATTEMPTS).keys()], '0,1,2 회차 (재시도 큐를 거쳐 다시 들어옴)');
    // 같은 이벤트의 다른 후처리(활동 로그, 검색 색인)는 영향 없이 성공
    assert.ok(await (await col('processed_messages')).findOne({ _id: `activity-logger:${doc.event_id}` }));
    assert.ok(await (await col('processed_messages')).findOne({ _id: `search-indexer:${doc.event_id}` }));
    assert.equal((await notificationsFor(orderNo)).length, 0);

    // 관리자 화면: 실패 목록에 보임
    const page = await admin.get('/admin/jobs');
    assert.equal(page.status, 200);
    assert.match(page.text, /user-notifier/);
    assert.match(page.text, /MongoDB write timeout/);
    assert.match(page.text, new RegExp(`value="${id}"`));

    // 원인 해결 후 재처리 → 실패했던 큐만 다시 실행
    faults.notifier = null;
    const settledBefore = worker.settled.length;
    const res = await admin.post('/admin/jobs/replay', { id });
    assert.equal(res.status, 302);
    assert.equal((await (await col('failed_messages')).findOne({ _id: id })).status, 'REQUEUED');
    const [n] = await waitFor(async () => { const x = await notificationsFor(orderNo); return x.length && x; });
    assert.equal(n.title, '주문이 접수되었습니다');
    await waitFor(async () => (await (await col('failed_messages')).findOne({ _id: id })).status === 'RESOLVED', { message: 'RESOLVED 표시' });
    await drained();
    const replayed = worker.settled.slice(settledBefore).filter((e) => e.event && e.event.event_id === doc.event_id);
    const byQueue = Object.fromEntries(replayed.map((e) => [e.name, e.outcome]));
    assert.deepEqual(byQueue, { 'user-notifier': 'ok', 'activity-logger': 'duplicate', 'search-indexer': 'duplicate' });
    // 재처리 작업도 감사 로그에
    const audit = await waitFor(async () => (await col('audit_log')).findOne({ action: 'jobs.replay' }));
    assert.equal(audit.admin_name, ACCOUNTS.admin.name);
    assert.equal(audit.detail.count, 1);
    const resolved = await admin.get('/admin/jobs?status=RESOLVED');
    assert.match(resolved.text, /재처리 성공/);
  });

  test('재시도해도 소용없는 오류(NonRetryableError)는 바로 DLQ', async () => {
    const seen = [];
    faults.notifier = async (event, ctx) => { seen.push(ctx.attempts); throw new NonRetryableError('알 수 없는 이벤트 형식'); };
    relay.start();
    const orderNo = await placeOrder();
    const doc = await waitFor(async () => (await col('failed_messages')).findOne({ queue: 'user-notifier', 'payload.data.order_no': orderNo }));
    assert.equal(doc.attempts, 1);
    assert.deepEqual(seen, [0]);
  });

  test('JSON 이 아닌 메시지도 버리지 않고 DLQ 로 보관 (재처리 불가 표시)', async () => {
    await rabbit.sendToQueue(rabbit.qname('audit-writer'), Buffer.from('not-json'), { messageId: 'broken-1', headers: {} });
    const doc = await waitFor(async () => (await col('failed_messages')).findOne({ _id: 'audit-writer:broken-1' }));
    assert.equal(doc.attempts, 1);
    assert.match(doc.error, /JSON 파싱 실패/);
    await admin.get('/admin/jobs');
    await admin.post('/admin/jobs/replay', { id: 'audit-writer:broken-1' });
    assert.match((await admin.get('/admin/jobs')).text, /원본 이벤트가 손상되어 재처리할 수 없습니다/);
    await (await col('failed_messages')).deleteOne({ _id: 'audit-writer:broken-1' });
  });

  test('전체 재처리: FAILED 상태를 한 번에 다시 보냄', async () => {
    faults.notifier = async () => { throw new NonRetryableError('일시 장애'); };
    relay.start();
    const a = await placeOrder();
    const b = await placeOrder();
    await waitFor(async () => (await (await col('failed_messages')).countDocuments({ status: 'FAILED', 'payload.data.order_no': { $in: [a, b] } })) === 2);
    faults.notifier = null;
    await admin.get('/admin/jobs');
    const res = await admin.post('/admin/jobs/replay-all');
    assert.equal(res.status, 302);
    await waitFor(async () => (await notificationsFor(a)).length === 1 && (await notificationsFor(b)).length === 1);
    assert.equal(await (await col('failed_messages')).countDocuments({ status: 'FAILED' }), 0);
  });

  test('재처리할 것이 없으면 안내 메시지', async () => {
    await admin.get('/admin/jobs');
    await admin.post('/admin/jobs/replay', { id: 'nope:1' });
    assert.match((await admin.get('/admin/jobs')).text, /재처리할 실패 메시지가 없습니다/);
  });
});

describe('이용자 화면: 주문 알림 (MongoDB)', () => {
  test('주문·취소 알림이 주문내역에 보이고, 읽지 않은 개수가 메뉴에 표시된 뒤 읽음 처리', async () => {
    await (await col('notifications')).deleteMany({ user_id: ACCOUNTS.user.id });
    relay.start();
    const orderNo = await placeOrder();
    await user.post(`/orders/${orderNo}/cancel`);
    await waitFor(async () => (await notificationsFor(orderNo)).length === 2);
    const home = await user.get('/');
    assert.match(home.text, /title="새 알림">2</);
    const page = await user.get('/orders');
    assert.match(page.text, /주문이 접수되었습니다/);
    assert.match(page.text, /주문이 취소되었습니다/);
    assert.doesNotMatch((await user.get('/')).text, /title="새 알림"/, '주문내역을 열면 읽음 처리');
  });

  test('다른 이용자의 알림은 보이지 않음', async () => {
    const other = new Client(server.base);
    await other.login(ACCOUNTS.other);
    const page = await other.get('/orders');
    assert.doesNotMatch(page.text, /주문이 접수되었습니다/);
  });
});

describe('관리자 후처리 모니터 (/admin/jobs)', () => {
  test('큐별 대기·재시도·DLQ·워커 수와 outbox·Elasticsearch 상태', async () => {
    const res = await admin.get('/admin/jobs');
    assert.equal(res.status, 200);
    for (const q of Object.keys(rabbit.QUEUES)) assert.match(res.text, new RegExp(q));
    assert.match(res.text, /Outbox · 발행 대기/);
    assert.match(res.text, /클러스터 (green|yellow)/);
    assert.match(res.text, /1개<\/span>/, '워커 연결 수');
  });

  test('검색 인덱스 전체 재생성', async () => {
    await admin.get('/admin/jobs');
    await admin.post('/admin/jobs/reindex');
    assert.match((await admin.get('/admin/jobs')).text, /인덱스를 다시 만들었습니다. \(5건\)/);
  });

  test('outbox enqueue 는 반드시 트랜잭션 안에서 (이벤트 형식 확인)', async () => {
    const ev = await db.transaction((tx) => outbox.enqueue(tx, 'admin', 'product.updated', { article_ids: [TEE] }, null));
    assert.equal(ev.type, 'product.updated');
    assert.ok(ev.event_id && ev.occurred_at);
  });
});
