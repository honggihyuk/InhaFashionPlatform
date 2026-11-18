// 테스트 공통 준비: 테스트 파일마다 고유한 네임스페이스(NS)로
//   MySQL 스키마(t_<id>_catalog/admin/member), MongoDB DB, Elasticsearch 인덱스, RabbitMQ exchange·큐를 따로 만들고
//   고정 데이터 + 테스트 서버 + 쿠키를 유지하는 HTTP 클라이언트 + 후처리 워커를 제공합니다.
//
// 반드시 앱 모듈보다 먼저 require 해야 합니다 (config/index.js 가 INHA_NS 를 읽어 이름을 정하기 때문).
// 개발 데이터(inha_*)는 전혀 건드리지 않고, cleanup() 이 이 NS 의 모든 자원을 지웁니다.
// 필요한 서비스: docker compose up -d (MySQL, MongoDB, Elasticsearch, RabbitMQ)
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const id = `${process.pid.toString(36)}${crypto.randomBytes(2).toString('hex')}`;
process.env.INHA_NS = `t_${id}_`;
process.env.SESSION_SECRET = 'test-secret';
// 재시도 대기를 짧게: 1회차 150ms, 2회차 300ms 뒤 재처리, 그래도 실패하면 DLQ
process.env.MQ_RETRY_DELAYS = process.env.MQ_RETRY_DELAYS || '150,300';
process.env.OUTBOX_POLL_MS = '50';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inha-test-'));
const config = require('../../config');

config.images.dir = path.join(tmpDir, 'images');

const db = require('../../db/mysql');
const mongo = require('../../db/mongo');
const rabbit = require('../../messaging/rabbit');
const relay = require('../../messaging/relay');
const search = require('../../search/products');

const { S } = db;

const ACCOUNTS = {
  admin: { email: 'admin@test.local', password: 'admin-pass-1', name: '테스트 관리자' },
  user: { email: 'user@test.local', password: 'user-pass-1', name: '테스트 이용자' },
  other: { email: 'other@test.local', password: 'other-pass-1', name: '다른 이용자' },
};

// 상품 고정 데이터 (H&M articles 컬럼 형식 유지: 10자리 article_id, 7자리 product_code)
const ARTICLES = {
  tee: { article_id: '0108775015', product_code: '0108775', prod_name: 'Strap top', product_type_name: 'Vest top',
    product_group_name: 'Garment Upper body', colour_group_name: 'Black', perceived_colour_master_name: 'Black',
    index_group_name: 'Ladieswear', detail_desc: 'Jersey top with narrow shoulder straps.', price_krw: 12900, stock: 5 },
  teeWhite: { article_id: '0108775044', product_code: '0108775', prod_name: 'Strap top', product_type_name: 'Vest top',
    product_group_name: 'Garment Upper body', colour_group_name: 'White', perceived_colour_master_name: 'White',
    index_group_name: 'Ladieswear', detail_desc: 'Jersey top with narrow shoulder straps.', price_krw: 12900, stock: 20 },
  sneaker: { article_id: '0200000001', product_code: '0200000', prod_name: 'Chunky sneakers', product_type_name: 'Sneakers',
    product_group_name: 'Shoes', colour_group_name: 'White', perceived_colour_master_name: 'White',
    index_group_name: 'Menswear', detail_desc: 'Trainers with a chunky sole.', price_krw: 59000, stock: 10 },
  kidsDress: { article_id: '0300000001', product_code: '0300000', prod_name: 'Kids dress', product_type_name: 'Dress',
    product_group_name: 'Garment Full body', colour_group_name: 'Pink', perceived_colour_master_name: 'Pink',
    index_group_name: 'Baby/Children', detail_desc: 'Dress in soft cotton.', price_krw: 19900, stock: 8 },
  retired: { article_id: '0400000001', product_code: '0400000', prod_name: 'Retired scarf', product_type_name: 'Scarf',
    product_group_name: 'Accessories', colour_group_name: 'Grey', perceived_colour_master_name: 'Grey',
    index_group_name: 'Divided', detail_desc: 'No longer sold.', price_krw: 9900, stock: 30, is_active: 0 },
};

async function seedCatalog() {
  let pop = 100;
  for (const a of Object.values(ARTICLES)) {
    const { price_krw, stock, is_active = 1, ...art } = a;
    await db.exec(`INSERT INTO ${S.catalog}.articles (article_id, product_code, prod_name, product_type_name, product_group_name,
        colour_group_name, perceived_colour_master_name, index_group_name, detail_desc, garment_group_name)
      VALUES (:article_id, :product_code, :prod_name, :product_type_name, :product_group_name,
        :colour_group_name, :perceived_colour_master_name, :index_group_name, :detail_desc, 'Jersey Basic')`, art);
    await db.exec(`INSERT INTO ${S.catalog}.products (article_id, price_krw, stock, is_active, popularity) VALUES (?, ?, ?, ?, ?)`,
      [a.article_id, price_krw, stock, is_active, (pop -= 10)]);
  }
  // H&M 거래: tee 를 산 고객이 sneaker 도 산 기록 (함께 산 상품 추천용)
  await db.exec(`INSERT INTO ${S.catalog}.transactions (t_dat, customer_id, article_id, price, sales_channel_id) VALUES ?`, [[
    ['2020-08-01', 'c1', ARTICLES.tee.article_id, 0.0129, 2],
    ['2020-08-01', 'c1', ARTICLES.sneaker.article_id, 0.059, 2],
    ['2020-09-01', 'c2', ARTICLES.tee.article_id, 0.0129, 1],
    ['2020-09-02', 'c2', ARTICLES.sneaker.article_id, 0.059, 1],
  ]]);
}

async function seedAccounts() {
  const adminUser = require('../../models/adminUser');
  const user = require('../../models/user');
  await adminUser.create({ email: ACCOUNTS.admin.email, name: ACCOUNTS.admin.name, role: 'super', plainPassword: ACCOUNTS.admin.password });
  for (const key of ['user', 'other']) {
    const a = ACCOUNTS[key];
    const created = await user.create({ email: a.email, name: a.name, phone: '010-0000-0000', address: '인천광역시 미추홀구 인하로 100', plainPassword: a.password });
    a.id = created.id;
  }
  ACCOUNTS.admin.id = (await adminUser.findByEmail(ACCOUNTS.admin.email)).id;
}

/**
 * 이 테스트 파일 전용 스키마·컬렉션·인덱스·큐를 만들고 고정 데이터를 넣음
 * @param {{ catalog?: boolean, index?: boolean }} opts catalog=false 이면 상품 없이(데이터 미적재 상태) 시작
 */
async function setup({ catalog = true, index = true } = {}) {
  await db.migrate();
  await mongo.ensureIndexes();
  await rabbit.setupTopology();
  if (catalog) {
    await seedCatalog();
    if (index) await search.reindexAll();
  }
  await seedAccounts();
  return { db, S, mongo, tmpDir, config, ACCOUNTS, ARTICLES };
}

/** 이 NS 의 모든 자원 삭제 + 연결 종료. 각 테스트 파일의 after() 에서 호출 */
async function cleanup() {
  await relay.stop().catch(() => {});
  await Promise.allSettled([
    db.dropSchemas(), mongo.dropDatabase(), search.deleteIndex(), rabbit.deleteTopology(),
  ]);
  await Promise.allSettled([db.close(), mongo.close(), search.close(), rabbit.close()]);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
}

/** 앱을 임의 포트로 띄우고 base URL 을 돌려줌 */
async function startServer() {
  const app = require('../../app');
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/**
 * 후처리 워커(같은 프로세스) 시작. 처리 결과를 settled 목록에 모아 테스트에서 기다릴 수 있게 함
 *   handlers: 큐별 핸들러 바꿔치기 (실패 주입용)
 */
async function startWorker({ handlers, relay: withRelay = true } = {}) {
  const worker = require('../../worker');
  const settled = [];
  const archived = [];
  const w = await worker.start({
    handlers, relay: withRelay,
    onSettled: (e) => settled.push(e),
    onArchived: (e) => archived.push(e),
  });
  return { ...w, settled, archived };
}

/** 조건이 참이 될 때까지 기다림 (후처리는 비동기라 바로 반영되지 않음) */
async function waitFor(fn, { timeout = 8000, interval = 40, message = '조건' } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    if (Date.now() > until) throw new Error(`${message} 을(를) ${timeout}ms 안에 만족하지 못함 (마지막 값: ${last && last.message ? last.message : JSON.stringify(last)})`);
    await new Promise((r) => { setTimeout(r, interval); });
  }
}

/** outbox 가 비고 모든 큐(대기·재시도)가 빈 상태가 연속 3번 확인될 때까지 기다림 */
async function drained(timeout = 8000) {
  let streak = 0;
  await waitFor(async () => {
    const ok = await isIdle();
    streak = ok ? streak + 1 : 0;
    return streak >= 3;
  }, { timeout, interval: 60, message: 'outbox·큐 비우기' });
}

async function isIdle() {
  const [a, m] = await Promise.all([
    db.one(`SELECT COUNT(*) AS n FROM ${S.admin}.outbox_events WHERE status = 'PENDING'`),
    db.one(`SELECT COUNT(*) AS n FROM ${S.member}.outbox_events WHERE status = 'PENDING'`),
  ]);
  if (a.n + m.n) return false;
  const qs = await rabbit.queueStats();
  return qs.every((q) => q.ready === 0 && q.retry === 0);
}

/** 쿠키(세션)와 CSRF 토큰을 자동으로 유지하는 간단한 브라우저 흉내 클라이언트 */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = null;
  }

  async request(method, url, { form, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) {
      const data = { ...form };
      if (csrf && this.csrf && data._csrf === undefined) data._csrf = this.csrf;
      body = new URLSearchParams(data).toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(this.base + url, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const text = await res.text();
    const m = text.match(/<meta name="csrf-token" content="([^"]+)">/) || text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), headers: res.headers, text };
  }

  get(url, opts) { return this.request('GET', url, opts); }

  /** CSRF 토큰이 아직 없으면 먼저 페이지를 하나 열어 토큰을 받음 */
  async post(url, form = {}, opts = {}) {
    if (!this.csrf && opts.csrf !== false) await this.get('/login');
    return this.request('POST', url, { ...opts, form });
  }

  /** 로그인 후 이동한 페이지까지 열어 새 세션의 CSRF 토큰을 받아 둠 */
  async login(account, as = 'user') {
    await this.get(as === 'admin' ? '/login?as=admin' : '/login');
    const res = await this.post('/login', { email: account.email, password: account.password, as });
    if (res.status === 302) await this.get(res.location);
    return res;
  }
}

module.exports = {
  setup, cleanup, startServer, startWorker, waitFor, drained, Client, ACCOUNTS, ARTICLES, tmpDir, db, S, mongo, config,
};
