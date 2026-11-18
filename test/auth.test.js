// 로그인(이용자/관리자 계정 체계 분리), 회원가입, 로그아웃, CSRF
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, cleanup, startServer, Client, ACCOUNTS, db, S } = require('./helpers/setup');

let server;
before(async () => { await setup(); server = await startServer(); });
after(async () => { await server.close(); await cleanup(); });
const client = () => new Client(server.base);

describe('로그인 화면', () => {
  test('기본은 이용자 로그인, ?as=admin 이면 관리자 로그인 탭', async () => {
    const c = client();
    const user = await c.get('/login');
    assert.equal(user.status, 200);
    assert.match(user.text, /name="as" value="user"/);
    const admin = await c.get('/login?as=admin');
    assert.equal(admin.status, 200);
    assert.match(admin.text, /name="as" value="admin"/);
    assert.match(admin.text, /관리자 로그인/);
  });
});

describe('이용자 로그인', () => {
  test('올바른 계정이면 쇼핑 홈(/)으로 이동하고 세션이 유지된다', async () => {
    const c = client();
    const res = await c.login(ACCOUNTS.user);
    assert.equal(res.status, 302);
    assert.equal(res.location, '/');
    const cart = await c.get('/cart');
    assert.equal(cart.status, 200, '로그인 후에는 장바구니에 접근 가능');
  });

  test('이메일은 대소문자·공백을 무시한다', async () => {
    const c = client();
    const res = await c.login({ email: `  ${ACCOUNTS.user.email.toUpperCase()} `, password: ACCOUNTS.user.password });
    assert.equal(res.status, 302);
  });

  test('비밀번호가 틀리면 401 과 오류 메시지', async () => {
    const c = client();
    const res = await c.login({ email: ACCOUNTS.user.email, password: 'wrong-password' });
    assert.equal(res.status, 401);
    assert.match(res.text, /이메일 또는 비밀번호가 올바르지 않습니다/);
  });

  test('없는 계정이면 401', async () => {
    const res = await client().login({ email: 'nobody@test.local', password: 'whatever1' });
    assert.equal(res.status, 401);
  });
});

describe('관리자/이용자 계정 체계 분리 (admin 스키마 vs member 스키마)', () => {
  test('관리자 계정은 관리자 탭에서 로그인되고 /admin 으로 이동', async () => {
    const res = await client().login(ACCOUNTS.admin, 'admin');
    assert.equal(res.status, 302);
    assert.equal(res.location, '/admin');
  });

  test('관리자 계정으로 이용자 탭 로그인은 실패 (member.users 에 없음)', async () => {
    const res = await client().login(ACCOUNTS.admin, 'user');
    assert.equal(res.status, 401);
  });

  test('이용자 계정으로 관리자 탭 로그인은 실패 (admin.admin_users 에 없음)', async () => {
    const res = await client().login(ACCOUNTS.user, 'admin');
    assert.equal(res.status, 401);
  });

  test('as 값이 이상하면 이용자 로그인으로 취급', async () => {
    const c = client();
    await c.get('/login');
    const res = await c.post('/login', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, as: 'root' });
    assert.equal(res.status, 401, '관리자 권한으로 승격되면 안 됨');
  });

  test('관리자 로그인 시 last_login_at 이 기록된다', async () => {
    await client().login(ACCOUNTS.admin, 'admin');
    const row = await db.one(`SELECT last_login_at FROM ${S.admin}.admin_users WHERE email = ?`, [ACCOUNTS.admin.email]);
    assert.ok(row.last_login_at);
  });

  test('이미 로그인한 상태에서 /login 을 열면 각자의 첫 화면으로 보냄', async () => {
    const u = client();
    await u.login(ACCOUNTS.user);
    assert.equal((await u.get('/login')).location, '/');
    const a = client();
    await a.login(ACCOUNTS.admin, 'admin');
    assert.equal((await a.get('/login')).location, '/admin');
  });
});

describe('로그인 후 원래 가려던 화면으로 복귀 (returnTo)', () => {
  test('비로그인으로 /orders 접근 → 로그인 → /orders 로 복귀', async () => {
    const c = client();
    const first = await c.get('/orders');
    assert.equal(first.status, 302);
    assert.equal(first.location, '/login');
    const res = await c.post('/login', { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, as: 'user' });
    assert.equal(res.location, '/orders');
  });

  test('비로그인으로 /admin/orders 접근 → 관리자 로그인 → /admin/orders 로 복귀', async () => {
    const c = client();
    const first = await c.get('/admin/orders');
    assert.equal(first.location, '/login?as=admin');
    await c.get(first.location);
    const res = await c.post('/login', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, as: 'admin' });
    assert.equal(res.location, '/admin/orders');
  });

  test('이용자가 로그인할 때 returnTo 가 /admin 이면 무시하고 홈으로', async () => {
    const c = client();
    await c.get('/admin');
    const res = await c.post('/login', { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, as: 'user' });
    assert.equal(res.location, '/');
  });

  test('관리자가 로그인할 때 returnTo 가 쇼핑 화면이면 무시하고 /admin 으로', async () => {
    const c = client();
    await c.get('/checkout');
    await c.get('/login?as=admin');
    const res = await c.post('/login', { email: ACCOUNTS.admin.email, password: ACCOUNTS.admin.password, as: 'admin' });
    assert.equal(res.location, '/admin');
  });
});

describe('회원가입', () => {
  const valid = { email: 'new.member@test.local', name: '신규 회원', phone: '010-1111-2222', address: '인천', password: 'new-pass-123', password2: 'new-pass-123' };

  for (const [label, patch, message] of [
    ['이메일 형식 오류', { email: 'not-an-email' }, /올바른 이메일/],
    ['이름 누락', { name: '   ' }, /이름을 입력/],
    ['비밀번호 8자 미만', { password: 'short', password2: 'short' }, /8자 이상/],
    ['비밀번호 확인 불일치', { password2: 'different-pass' }, /일치하지 않습니다/],
    ['이미 가입된 이메일', { email: ACCOUNTS.user.email.toUpperCase() }, /이미 가입된 이메일/],
  ]) {
    test(`${label} → 400`, async () => {
      const res = await client().post('/signup', { ...valid, ...patch });
      assert.equal(res.status, 400);
      assert.match(res.text, message);
    });
  }

  test('정상 가입 → member 스키마에 저장되고 바로 로그인된다', async () => {
    const c = client();
    const res = await c.post('/signup', valid);
    assert.equal(res.status, 302);
    assert.equal(res.location, '/');
    const row = await db.one(`SELECT * FROM ${S.member}.users WHERE email = ?`, [valid.email]);
    assert.ok(row, 'member.users 에 저장');
    assert.notEqual(row.password_hash, valid.password, '비밀번호는 해시로 저장');
    assert.match(row.password_hash, /^scrypt\$/);
    assert.equal((await db.one(`SELECT COUNT(*) AS n FROM ${S.admin}.admin_users WHERE email = ?`, [valid.email])).n, 0, 'admin 스키마에는 생기지 않음');
    await c.get('/');
    assert.equal((await c.get('/cart')).status, 200);
  });
});

describe('로그아웃', () => {
  test('세션이 사라져 다시 로그인이 필요하다', async () => {
    const c = client();
    await c.login(ACCOUNTS.user);
    await c.get('/');
    const out = await c.post('/logout');
    assert.equal(out.location, '/login');
    const cart = await c.get('/cart');
    assert.equal(cart.status, 302);
    assert.equal(cart.location, '/login');
  });
});

describe('CSRF 보호', () => {
  test('토큰 없이 POST 하면 403', async () => {
    const c = client();
    await c.get('/login');
    const res = await c.post('/login', { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, as: 'user' }, { csrf: false });
    assert.equal(res.status, 403);
  });

  test('틀린 토큰이면 403', async () => {
    const c = client();
    await c.get('/login');
    const res = await c.post('/login', { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, _csrf: 'forged' });
    assert.equal(res.status, 403);
  });

  test('X-CSRF-Token 헤더로도 통과', async () => {
    const c = client();
    await c.get('/login');
    const res = await c.request('POST', '/login', {
      form: { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, as: 'user' }, csrf: false,
      headers: { 'x-csrf-token': c.csrf },
    });
    assert.equal(res.status, 302);
  });

  test('로그인하면 세션이 새로 발급된다 (세션 고정 공격 방지)', async () => {
    const c = client();
    await c.get('/login');
    const before = c.cookies.get('connect.sid');
    await c.post('/login', { email: ACCOUNTS.user.email, password: ACCOUNTS.user.password, as: 'user' });
    assert.ok(before);
    assert.notEqual(c.cookies.get('connect.sid'), before);
  });
});
