// 역할(role)에 따른 화면 분리: 관리자 ↔ 이용자 ↔ 비로그인
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, cleanup, startServer, Client, ACCOUNTS, db, S } = require('./helpers/setup');

let server; let anon; let user; let admin;
before(async () => {
  await setup();
  server = await startServer();
  anon = new Client(server.base);
  user = new Client(server.base);
  admin = new Client(server.base);
  await user.login(ACCOUNTS.user);
  await admin.login(ACCOUNTS.admin, 'admin');
});
after(async () => { await server.close(); await cleanup(); });

const ADMIN_PAGES = ['/admin', '/admin/products', '/admin/orders', '/admin/audit', '/admin/jobs', '/admin/api/analysis/status'];
const USER_PAGES = ['/cart', '/checkout', '/orders'];
const SHOP_PAGES = ['/', '/products', '/products/0108775015'];

describe('비로그인', () => {
  for (const p of ADMIN_PAGES) {
    test(`${p} → 관리자 로그인으로 이동`, async () => {
      const res = await anon.get(p);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/login?as=admin');
    });
  }
  for (const p of USER_PAGES) {
    test(`${p} → 이용자 로그인으로 이동`, async () => {
      const res = await anon.get(p);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/login');
    });
  }
  for (const p of SHOP_PAGES) {
    test(`${p} 쇼핑 화면은 누구나 볼 수 있음`, async () => {
      assert.equal((await anon.get(p)).status, 200);
    });
  }
  test('비로그인 상태로 장바구니 담기(POST)도 로그인으로 이동', async () => {
    const res = await anon.post('/cart/add', { article_id: '0108775015', size: 'M', qty: 1 });
    assert.equal(res.location, '/login');
  });
});

describe('이용자 (role=user)', () => {
  for (const p of ADMIN_PAGES) {
    test(`${p} → 403 관리자 전용`, async () => {
      const res = await user.get(p);
      assert.equal(res.status, 403);
      assert.match(res.text, /관리자 전용/);
    });
  }
  test('관리자 POST API 도 403 (상품 가격 변경 시도)', async () => {
    const res = await user.post('/admin/products/0108775015', { price_krw: 1, stock: 999, is_active: '1' });
    assert.equal(res.status, 403);
    assert.equal((await db.one(`SELECT price_krw FROM ${S.catalog}.products WHERE article_id = '0108775015'`)).price_krw, 12900, '가격이 바뀌면 안 됨');
  });
  test('관리자 POST API 도 403 (분석 실행 시도)', async () => {
    const res = await user.post('/admin/analysis/run', {});
    assert.equal(res.status, 403);
  });
  test('관리자 POST API 도 403 (실패 작업 재처리·재색인 시도)', async () => {
    assert.equal((await user.post('/admin/jobs/replay-all', {})).status, 403);
    assert.equal((await user.post('/admin/jobs/reindex', {})).status, 403);
  });
  for (const p of [...USER_PAGES.filter((x) => x !== '/checkout'), ...SHOP_PAGES]) {
    test(`${p} 접근 가능`, async () => {
      assert.equal((await user.get(p)).status, 200);
    });
  }
  test('장바구니가 비었으면 /checkout 은 /cart 로', async () => {
    assert.equal((await user.get('/checkout')).location, '/cart');
  });
});

describe('관리자 (role=admin)', () => {
  for (const p of ADMIN_PAGES) {
    test(`${p} 접근 가능`, async () => {
      assert.equal((await admin.get(p)).status, 200);
    });
  }
  for (const p of SHOP_PAGES) {
    test(`쇼핑 화면 ${p} → 관리자 콘솔(/admin)로 보냄`, async () => {
      const res = await admin.get(p);
      assert.equal(res.status, 302);
      assert.equal(res.location, '/admin');
    });
  }
  for (const p of USER_PAGES) {
    test(`구매 기능 ${p} → 403`, async () => {
      const res = await admin.get(p);
      assert.equal(res.status, 403);
      assert.match(res.text, /관리자 계정으로는 구매 기능을 사용할 수 없습니다/);
    });
  }
  test('관리자는 장바구니 담기(POST)도 403', async () => {
    const res = await admin.post('/cart/add', { article_id: '0108775015', size: 'M', qty: 1 });
    assert.equal(res.status, 403);
  });
  test('상품 이미지(SVG)는 관리자 화면에서도 쓰이므로 열림', async () => {
    const res = await admin.get('/media/article/0108775015.svg');
    assert.equal(res.status, 200);
  });
});

describe('세션 role 위조 불가', () => {
  test('세션 쿠키 서명이 틀리면 비로그인으로 취급', async () => {
    const c = new Client(server.base);
    const sid = admin.cookies.get('connect.sid');
    c.cookies.set('connect.sid', sid.replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A')));
    const res = await c.get('/admin');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/login?as=admin');
  });
});
