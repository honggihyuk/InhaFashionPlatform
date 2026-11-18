// 관리자 기능: 대시보드/분석 결과 API, 분석 실행(analysisRunner), 상품·재고 수정, 주문 상태 변경, 작업 기록
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setup, startServer, Client, ACCOUNTS, ARTICLES, db, config } = require('./helpers/setup');

setup();
const analysis = require('../models/analysis');
const runner = require('../services/analysisRunner');
const cart = require('../models/cart');
const order = require('../models/order');

const SAMPLE = path.join(__dirname, 'fixtures', 'sales_trends.sample.json');
const TEE = ARTICLES.tee.article_id;

// 실제 python/PyTorch 대신 가짜 분석 스크립트를 node 로 실행
config.analysis.python = process.execPath;
config.analysis.script = path.join(__dirname, 'fixtures', 'fake_analysis.js');

async function waitForRun(runId, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = db.prepare('SELECT * FROM admin.analysis_runs WHERE id = ?').get(runId);
    if (r.status !== 'running') return r;
    if (Date.now() > until) throw new Error(`analysis run #${runId} did not finish`);
    await new Promise((res) => { setTimeout(res, 25); });
  }
}
const removeResult = () => fs.rmSync(config.analysis.resultFile, { force: true });
const lastAudit = () => db.prepare('SELECT * FROM admin.audit_log ORDER BY id DESC LIMIT 1').get();

let server; let admin; let user;
before(async () => {
  server = await startServer();
  admin = new Client(server.base);
  user = new Client(server.base);
  await admin.login(ACCOUNTS.admin, 'admin');
  await user.login(ACCOUNTS.user);
});
after(async () => { await server.close(); });

describe('대시보드와 분석 결과 API', () => {
  beforeEach(removeResult);

  test('분석 결과가 없으면 API 는 404, 대시보드는 그래도 열림', async () => {
    const api = await admin.get('/admin/api/trends');
    assert.equal(api.status, 404);
    assert.match(JSON.parse(api.text).error, /분석 결과가 없습니다/);
    assert.equal((await admin.get('/admin')).status, 200);
  });

  test('분석 결과가 있으면 API 가 JSON 그대로 반환', async () => {
    fs.mkdirSync(path.dirname(config.analysis.resultFile), { recursive: true });
    fs.copyFileSync(SAMPLE, config.analysis.resultFile);
    const api = await admin.get('/admin/api/trends');
    assert.equal(api.status, 200);
    const json = JSON.parse(api.text);
    assert.equal(json.hourly.peak_hour, JSON.parse(fs.readFileSync(SAMPLE, 'utf8')).hourly.peak_hour);
  });

  test('분석 결과가 있으면 대시보드에 인사이트 문장이 표시', async () => {
    fs.mkdirSync(path.dirname(config.analysis.resultFile), { recursive: true });
    fs.copyFileSync(SAMPLE, config.analysis.resultFile);
    const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf8'));
    const res = await admin.get('/admin');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(`주문이 가장 몰리는 시간은 <b>${sample.hourly.peak_hour}시</b>`));
    assert.match(res.text, /PyTorch 모델은 다음 4주 매출을/);
  });

  test('결과 파일이 깨져 있으면 결과 없음으로 처리 (500 아님)', async () => {
    fs.mkdirSync(path.dirname(config.analysis.resultFile), { recursive: true });
    fs.writeFileSync(config.analysis.resultFile, '{ broken json');
    assert.equal(analysis.readResult(), null);
    assert.equal((await admin.get('/admin/api/trends')).status, 404);
    assert.equal((await admin.get('/admin')).status, 200);
  });
});

describe('분석 실행 (services/analysisRunner)', () => {
  beforeEach(() => {
    removeResult();
    delete process.env.FAKE_ANALYSIS_MODE;
  });

  test('성공하면 실행 이력이 success, 요약(summary)과 로그 저장', async () => {
    const r = runner.run(ACCOUNTS.admin.id);
    assert.equal(r.started, true);
    assert.equal(analysis.running().id, r.runId);
    const done = await waitForRun(r.runId);
    assert.equal(done.status, 'success');
    assert.equal(done.triggered_by, ACCOUNTS.admin.id);
    assert.ok(done.finished_at);
    assert.ok(JSON.parse(done.summary_json).transactions > 0);
    assert.match(done.log, /fake analysis done/);
  });

  test('스크립트에 catalog/member DB 경로와 결과 경로를 넘긴다', async () => {
    const r = runner.run(ACCOUNTS.admin.id);
    await waitForRun(r.runId);
    const args = analysis.readResult().received_args;
    assert.equal(args[args.indexOf('--catalog') + 1], config.db.catalog);
    assert.equal(args[args.indexOf('--member') + 1], config.db.member, '시간대 분석은 member.orders 를 읽어야 함');
    assert.equal(args[args.indexOf('--out') + 1], config.analysis.resultFile);
  });

  test('스크립트가 실패하면 failed, 종료코드와 오류가 로그에 남음', async () => {
    process.env.FAKE_ANALYSIS_MODE = 'fail';
    const r = runner.run(ACCOUNTS.admin.id);
    const done = await waitForRun(r.runId);
    assert.equal(done.status, 'failed');
    assert.match(done.log, /테스트용 오류/);
    assert.match(done.log, /exit code 3/);
  });

  test('Python 실행 파일이 없으면 failed 와 안내 문구', async () => {
    const original = config.analysis.python;
    config.analysis.python = path.join(__dirname, 'no-such-python');
    try {
      const r = runner.run(ACCOUNTS.admin.id);
      const done = await waitForRun(r.runId);
      assert.equal(done.status, 'failed');
      assert.match(done.log, /PYTHON 환경변수를 확인하세요/);
    } finally {
      config.analysis.python = original;
    }
  });

  test('실행 중이면 중복 실행하지 않음', async () => {
    process.env.FAKE_ANALYSIS_MODE = 'slow';
    const first = runner.run(ACCOUNTS.admin.id);
    const second = runner.run(ACCOUNTS.admin.id);
    assert.equal(first.started, true);
    assert.deepEqual(second, { started: false, runId: first.runId });
    await waitForRun(first.runId);
  });

  test('서버 재시작 시 끝나지 않은 실행은 failed 로 정리', () => {
    const id = analysis.start(ACCOUNTS.admin.id);
    analysis.markStaleFailed();
    const r = db.prepare('SELECT * FROM admin.analysis_runs WHERE id = ?').get(id);
    assert.equal(r.status, 'failed');
    assert.match(r.log, /서버 재시작/);
  });

  test('관리자 화면의 실행 버튼(JSON 요청) → 시작 응답 + 작업 기록', async () => {
    await admin.get('/admin');
    const res = await admin.request('POST', '/admin/analysis/run', { form: {}, headers: { accept: 'application/json' } });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text);
    assert.equal(body.started, true);
    await waitForRun(body.runId);
    const log = lastAudit();
    assert.equal(log.action, 'analysis.run');
    assert.equal(log.target, `run#${body.runId}`);
    const status = JSON.parse((await admin.get('/admin/api/analysis/status')).text);
    assert.equal(status.status, 'success');
  });

  test('일반 폼 제출이면 대시보드로 리다이렉트', async () => {
    await admin.get('/admin');
    const res = await admin.post('/admin/analysis/run', {});
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin');
    await waitForRun(analysis.latest().id);
  });
});

describe('상품·재고 관리', () => {
  test('상품 관리 화면에는 판매 중지 상품도 보임', async () => {
    const res = await admin.get('/admin/products');
    assert.equal(res.status, 200);
    assert.match(res.text, /Retired scarf/);
  });

  test('가격/재고/판매여부 수정 + 작업 기록(변경 전후)', async () => {
    await admin.get('/admin/products');
    const res = await admin.post(`/admin/products/${TEE}`, { price_krw: '15900', stock: '42', is_active: '0' });
    assert.equal(res.status, 302);
    const p = db.prepare('SELECT * FROM products WHERE article_id = ?').get(TEE);
    assert.equal(p.price_krw, 15900);
    assert.equal(p.stock, 42);
    assert.equal(p.is_active, 0);
    const log = lastAudit();
    assert.equal(log.action, 'product.update');
    assert.equal(log.target, TEE);
    assert.deepEqual(JSON.parse(log.detail), { price_krw: [12900, 15900], stock: [5, 42], is_active: [1, 0] });
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
    let p = db.prepare('SELECT * FROM products WHERE article_id = ?').get(id);
    assert.equal(p.price_krw, 0);
    assert.equal(p.stock, 0);
    await admin.post(`/admin/products/${id}`, { price_krw: '19900.6', stock: '7.4', is_active: '1' });
    p = db.prepare('SELECT * FROM products WHERE article_id = ?').get(id);
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
    cart.add(ACCOUNTS.user.id, ARTICLES.teeWhite.article_id, 'M', 1);
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

  test('상태 변경 → DB 반영 + 작업 기록(from/to)', async () => {
    const o = await userOrder();
    await admin.get('/admin/orders');
    const res = await admin.post(`/admin/orders/${o.id}/status`, { status: 'SHIPPING' });
    assert.equal(res.status, 302);
    assert.equal(order.getForUser(o.order_no, ACCOUNTS.user.id).status, 'SHIPPING');
    const log = lastAudit();
    assert.equal(log.action, 'order.status');
    assert.equal(log.target, o.order_no);
    assert.deepEqual(JSON.parse(log.detail), { from: 'PAID', to: 'SHIPPING' });
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
    const stock = () => db.prepare('SELECT stock FROM products WHERE article_id = ?').get(ARTICLES.teeWhite.article_id).stock;
    const o = await userOrder();
    const before = stock();
    await admin.get('/admin/orders');
    await admin.post(`/admin/orders/${o.id}/status`, { status: 'CANCELLED' });
    assert.equal(stock(), before + 1);
  });

  test('작업 기록 화면에 관리자 이름과 작업이 보임', async () => {
    const res = await admin.get('/admin/audit');
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(ACCOUNTS.admin.name));
    assert.match(res.text, /주문 상태 변경|상품 수정/);
  });
});
