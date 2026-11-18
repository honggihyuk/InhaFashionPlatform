// 관리자 기능: 대시보드/분석 결과 API, 분석 실행(RabbitMQ analysis-runner), 상품·재고 수정, 주문 상태 변경, 작업 기록(MongoDB)
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  setup, cleanup, startServer, startWorker, waitFor, Client, ACCOUNTS, ARTICLES, db, S, mongo, config,
} = require('./helpers/setup');

const analysis = require('../models/analysis');
const cart = require('../models/cart');
const order = require('../models/order');

const SAMPLE = path.join(__dirname, 'fixtures', 'sales_trends.sample.json');
const sample = () => JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
const TEE = ARTICLES.tee.article_id;

// 실제 python/PyTorch 대신 가짜 분석 스크립트를 node 로 실행
config.analysis.python = process.execPath;
config.analysis.script = path.join(__dirname, 'fixtures', 'fake_analysis.js');

async function waitForRun(runId, timeout = 8000) {
  return waitFor(async () => {
    const r = await db.one(`SELECT * FROM ${S.admin}.analysis_runs WHERE id = ?`, [runId]);
    return r && ['success', 'failed'].includes(r.status) ? r : null;
  }, { timeout, message: `analysis run #${runId} 종료` });
}
const clearResults = async () => (await mongo.col('analysis_results')).deleteMany({});
const saveSample = () => analysis.saveResult(sample(), null);
/** 조건에 맞는 감사 로그가 MongoDB 에 생길 때까지 기다림 (audit-writer 후처리) */
const auditOf = (filter) => waitFor(async () => (await mongo.col('audit_log')).findOne(filter), { message: `감사 로그 ${JSON.stringify(filter)}` });

let server; let admin; let user; let worker;
before(async () => {
  await setup();
  worker = await startWorker();
  server = await startServer();
  admin = new Client(server.base);
  user = new Client(server.base);
  await admin.login(ACCOUNTS.admin, 'admin');
  await user.login(ACCOUNTS.user);
});
after(async () => { await server.close(); await worker.stop(); await cleanup(); });

describe('대시보드와 분석 결과 API (MongoDB analysis_results)', () => {
  beforeEach(clearResults);

  test('분석 결과가 없으면 API 는 404, 대시보드는 그래도 열림', async () => {
    const api = await admin.get('/admin/api/trends');
    assert.equal(api.status, 404);
    assert.match(JSON.parse(api.text).error, /분석 결과가 없습니다/);
    assert.equal((await admin.get('/admin')).status, 200);
  });

  test('분석 결과가 있으면 API 가 최신 문서를 JSON 으로 반환', async () => {
    await saveSample();
    const api = await admin.get('/admin/api/trends');
    assert.equal(api.status, 200);
    assert.equal(JSON.parse(api.text).hourly.peak_hour, sample().hourly.peak_hour);
  });

  test('분석 결과가 있으면 대시보드에 인사이트 문장이 표시', async () => {
    await saveSample();
    const res = await admin.get('/admin');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`주문이 가장 몰리는 시간은 <b>${sample().hourly.peak_hour}시</b>`));
    assert.match(res.text, /PyTorch 모델은 다음 4주 매출을/);
  });

  test('결과는 최신 20개만 보관', async () => {
    for (let i = 0; i < 22; i += 1) await analysis.saveResult({ n: i }, null);
    const c = await mongo.col('analysis_results');
    assert.equal(await c.countDocuments(), 20);
    assert.equal((await analysis.readResult()).n, 21);
  });
});

describe('분석 실행 (outbox → RabbitMQ analysis-runner)', () => {
  beforeEach(async () => {
    await clearResults();
    delete process.env.FAKE_ANALYSIS_MODE;
  });

  test('성공하면 실행 이력이 queued → success, 결과는 MongoDB 에 저장되고 result_id 로 연결', async () => {
    const r = await analysis.request({ type: 'admin', id: ACCOUNTS.admin.id, name: ACCOUNTS.admin.name });
    assert.equal(r.started, true);
    const done = await waitForRun(r.runId);
    assert.equal(done.status, 'success');
    assert.equal(done.triggered_by, ACCOUNTS.admin.id);
    assert.ok(done.finished_at);
    assert.match(done.log, /fake analysis done/);
    const doc = await (await mongo.col('analysis_results')).findOne({ run_id: r.runId });
    assert.equal(String(doc._id), done.result_id);
  });

  test('워커는 MySQL 스키마 이름을 스크립트에 넘긴다 (--mysql --catalog-schema --member-schema)', async () => {
    const r = await analysis.request(null);
    await waitForRun(r.runId);
    const args = (await analysis.readResult()).received_args;
    assert.ok(args.includes('--mysql'));
    assert.equal(args[args.indexOf('--catalog-schema') + 1], config.mysql.schemas.catalog);
    assert.equal(args[args.indexOf('--member-schema') + 1], config.mysql.schemas.member, '시간대 분석은 member.orders 를 읽어야 함');
  });

  test('스크립트가 실패하면 failed, 종료코드와 오류가 로그에 남음 (재시도하지 않음)', async () => {
    process.env.FAKE_ANALYSIS_MODE = 'fail';
    const r = await analysis.request(null);
    const done = await waitForRun(r.runId);
    assert.equal(done.status, 'failed');
    assert.match(done.log, /테스트용 오류/);
    assert.match(done.log, /exit code 3/);
  });

  test('Python 실행 파일이 없으면 failed 와 안내 문구', async () => {
    const original = config.analysis.python;
    config.analysis.python = path.join(__dirname, 'no-such-python');
    try {
      const r = await analysis.request(null);
      const done = await waitForRun(r.runId);
      assert.equal(done.status, 'failed');
      assert.match(done.log, /PYTHON 환경변수를 확인하세요/);
    } finally {
      config.analysis.python = original;
    }
  });

  test('대기·실행 중이면 중복 실행하지 않음', async () => {
    process.env.FAKE_ANALYSIS_MODE = 'slow';
    const [first, second] = [await analysis.request(null), await analysis.request(null)];
    assert.equal(first.started, true);
    assert.deepEqual(second, { started: false, runId: first.runId });
    await waitForRun(first.runId);
  });

  test('같은 analysis.requested 메시지가 두 번 와도 한 번만 실행 (이미 끝난 실행은 건너뜀)', async () => {
    const r = await analysis.request(null);
    await waitForRun(r.runId);
    const before = await (await mongo.col('analysis_results')).countDocuments();
    const handlers = require('../workers/handlers');
    await handlers['analysis-runner']({ event_id: 'dup', data: { run_id: r.runId } });
    assert.equal(await (await mongo.col('analysis_results')).countDocuments(), before);
  });

  test('관리자 화면의 실행 버튼(JSON 요청) → 시작 응답 + 작업 기록(MongoDB)', async () => {
    await admin.get('/admin');
    const res = await admin.request('POST', '/admin/analysis/run', { form: {}, headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.started, true);
    await waitForRun(body.runId);
    const log = await auditOf({ action: 'analysis.run', target: `run#${body.runId}` });
    assert.equal(log.admin_name, ACCOUNTS.admin.name);
    const status = JSON.parse((await admin.get('/admin/api/analysis/status')).text);
    assert.equal(status.status, 'success');
  });

  test('일반 폼 제출이면 대시보드로 리다이렉트', async () => {
    await admin.get('/admin');
    const res = await admin.post('/admin/analysis/run', {});
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin');
    await waitForRun((await analysis.latest()).id);
  });
});

describe('상품·재고 관리', () => {
  test('상품 관리 화면에는 판매 중지 상품도 보임 (Elasticsearch 검색)', async () => {
    const res = await admin.get('/admin/products');
    assert.equal(res.status, 200);
    assert.match(res.text, /Retired scarf/);
    assert.match(res.text, /Elasticsearch/);
  });

  test('가격/재고/판매여부 수정 → MySQL 즉시 반영, 작업 기록·검색 색인은 후처리로 반영', async () => {
    await admin.get('/admin/products');
    const res = await admin.post(`/admin/products/${TEE}`, { price_krw: '15900', stock: '42', is_active: '0' });
    assert.equal(res.status, 302);
    const p = await db.one(`SELECT * FROM ${S.catalog}.products WHERE article_id = ?`, [TEE]);
    assert.equal(p.price_krw, 15900);
    assert.equal(p.stock, 42);
    assert.equal(p.is_active, 0);
    const log = await auditOf({ action: 'product.update', target: TEE });
    assert.deepEqual(log.detail, { price_krw: [12900, 15900], stock: [5, 42], is_active: [1, 0] });
    // 검색 색인도 새 값으로
    const search = require('../search/products');
    await waitFor(async () => {
      const r = await search.search({ q: TEE });
      return r.items[0] && r.items[0].stock === 42 && r.items[0].is_active === false;
    }, { message: 'ES 색인 갱신' });
    // 판매 중지 → 이용자 화면에서 사라짐
    assert.equal((await user.get(`/products/${TEE}`)).status, 404);
    // 원복
    await admin.post(`/admin/products/${TEE}`, { price_krw: '12900', stock: '5', is_active: '1' });
    assert.equal((await user.get(`/products/${TEE}`)).status, 200);
  });

  test('음수/숫자가 아닌 값은 0 으로, 소수는 반올림', async () => {
    const id = ARTICLES.kidsDress.article_id;
    await admin.get('/admin/products');
    await admin.post(`/admin/products/${id}`, { price_krw: '-100', stock: 'abc', is_active: '1' });
    let p = await db.one(`SELECT * FROM ${S.catalog}.products WHERE article_id = ?`, [id]);
    assert.equal(p.price_krw, 0);
    assert.equal(p.stock, 0);
    await admin.post(`/admin/products/${id}`, { price_krw: '19900.6', stock: '7.4', is_active: '1' });
    p = await db.one(`SELECT * FROM ${S.catalog}.products WHERE article_id = ?`, [id]);
    assert.equal(p.price_krw, 19901);
    assert.equal(p.stock, 7);
  });

  test('없는 상품 수정은 404', async () => {
    await admin.get('/admin/products');
    const res = await admin.post('/admin/products/9999999999', { price_krw: '1', stock: '1', is_active: '1' });
    assert.equal(res.status, 404);
  });
});

describe('주문 관리', () => {
  async function userOrder() {
    await cart.add(db, ACCOUNTS.user.id, ARTICLES.teeWhite.article_id, 'M', 1);
    await user.get('/checkout');
    const res = await user.post('/checkout', { recipient: '김인하', phone: '010', address: '인천', payment_method: 'card', agree: '1' });
    const orderNo = res.location.match(/\/orders\/([^?]+)/)[1];
    return order.getForUser(orderNo, ACCOUNTS.user.id);
  }

  test('주문 목록과 상태 필터', async () => {
    const o = await userOrder();
    const all = await admin.get('/admin/orders');
    assert.equal(all.status, 200);
    assert.match(all.text, new RegExp(o.order_no));
    const shipping = await admin.get('/admin/orders?status=SHIPPING');
    assert.doesNotMatch(shipping.text, new RegExp(o.order_no));
    assert.equal((await admin.get('/admin/orders?status=HACKED')).status, 200, '알 수 없는 상태 필터는 무시');
  });

  test('상태 변경 → DB 반영 + 작업 기록(from/to) + 이용자 알림', async () => {
    const o = await userOrder();
    await admin.get('/admin/orders');
    const res = await admin.post(`/admin/orders/${o.id}/status`, { status: 'SHIPPING' });
    assert.equal(res.status, 302);
    assert.equal((await order.getForUser(o.order_no, ACCOUNTS.user.id)).status, 'SHIPPING');
    const log = await auditOf({ action: 'order.status', target: o.order_no });
    assert.deepEqual(log.detail, { from: 'PAID', to: 'SHIPPING' });
    const note = await waitFor(async () => (await mongo.col('notifications')).findOne({ order_no: o.order_no, type: 'order.status_changed' }));
    assert.equal(note.user_id, ACCOUNTS.user.id);
    assert.match(note.title, /배송중/);
  });

  test('잘못된 상태 변경은 오류 메시지로 안내 (500 아님)', async () => {
    const o = await userOrder();
    await admin.get('/admin/orders');
    const res = await admin.post(`/admin/orders/${o.id}/status`, { status: 'NOPE' });
    assert.equal(res.status, 302);
    const page = await admin.get('/admin/orders');
    assert.match(page.text, /알 수 없는 주문 상태입니다/);
  });

  test('관리자 취소 → 재고 복구', async () => {
    const stock = async () => (await db.one(`SELECT stock FROM ${S.catalog}.products WHERE article_id = ?`, [ARTICLES.teeWhite.article_id])).stock;
    const o = await userOrder();
    const before = await stock();
    await admin.get('/admin/orders');
    await admin.post(`/admin/orders/${o.id}/status`, { status: 'CANCELLED' });
    assert.equal(await stock(), before + 1);
  });

  test('작업 기록 화면에 관리자 이름과 작업이 보임', async () => {
    await auditOf({ action: 'order.status' });
    const res = await admin.get('/admin/audit');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(ACCOUNTS.admin.name));
    assert.match(res.text, /주문 상태 변경|상품 수정/);
  });
});
