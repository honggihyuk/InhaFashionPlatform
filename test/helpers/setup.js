// 테스트 공통 준비: 임시 DB(catalog/admin/member) + 고정 데이터 + 테스트 서버 + 쿠키를 유지하는 HTTP 클라이언트
//
// 반드시 앱 모듈보다 먼저 require 해야 합니다. config/index.js 가 환경변수로 DB 경로를 읽기 때문에
// 여기서 임시 폴더 경로를 지정하면 개발용 data/db/*.db 는 전혀 건드리지 않습니다.
// node --test 는 테스트 파일마다 별도 프로세스를 띄우므로, 파일마다 깨끗한 DB 를 갖습니다.
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inha-test-'));
process.env.CATALOG_DB = path.join(tmpDir, 'catalog.db');
process.env.ADMIN_DB = path.join(tmpDir, 'admin.db');
process.env.MEMBER_DB = path.join(tmpDir, 'member.db');
process.env.SESSION_SECRET = 'test-secret';

const config = require('../../config');
// 분석 결과/이미지 경로도 임시 폴더로 돌려 개발 데이터와 분리
config.analysis.resultFile = path.join(tmpDir, 'analysis', 'sales_trends.json');
config.images.dir = path.join(tmpDir, 'images');

const { db } = require('../../db/connection');

// 테스트 프로세스가 끝나면 DB 를 닫고 임시 폴더 삭제 (Windows 는 열린 파일을 지울 수 없어 먼저 close)
process.on('exit', () => {
  try { db.close(); } catch { /* 이미 닫힘 */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 무시 */ }
});

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

function seedCatalog() {
  const insA = db.prepare(`INSERT INTO articles (article_id, product_code, prod_name, product_type_name, product_group_name,
      colour_group_name, perceived_colour_master_name, index_group_name, detail_desc, garment_group_name)
    VALUES (:article_id, :product_code, :prod_name, :product_type_name, :product_group_name,
      :colour_group_name, :perceived_colour_master_name, :index_group_name, :detail_desc, 'Jersey Basic')`);
  const insP = db.prepare('INSERT INTO products (article_id, price_krw, stock, is_active, popularity) VALUES (?, ?, ?, ?, ?)');
  let pop = 100;
  for (const a of Object.values(ARTICLES)) {
    const { price_krw, stock, is_active = 1, ...art } = a;
    insA.run(art);
    insP.run(a.article_id, price_krw, stock, is_active, (pop -= 10));
  }
  // H&M 거래: tee 를 산 고객이 sneaker 도 산 기록 (함께 산 상품 추천용)
  const insT = db.prepare('INSERT INTO transactions (t_dat, customer_id, article_id, price, sales_channel_id) VALUES (?, ?, ?, ?, ?)');
  insT.run('2020-08-01', 'c1', ARTICLES.tee.article_id, 0.0129, 2);
  insT.run('2020-08-01', 'c1', ARTICLES.sneaker.article_id, 0.059, 2);
  insT.run('2020-09-01', 'c2', ARTICLES.tee.article_id, 0.0129, 1);
  insT.run('2020-09-02', 'c2', ARTICLES.sneaker.article_id, 0.059, 1);
}

function seedAccounts() {
  const adminUser = require('../../models/adminUser');
  const user = require('../../models/user');
  adminUser.create({ email: ACCOUNTS.admin.email, name: ACCOUNTS.admin.name, role: 'super', plainPassword: ACCOUNTS.admin.password });
  for (const key of ['user', 'other']) {
    const a = ACCOUNTS[key];
    const created = user.create({ email: a.email, name: a.name, phone: '010-0000-0000', address: '인천광역시 미추홀구 인하로 100', plainPassword: a.password });
    a.id = created.id;
  }
  ACCOUNTS.admin.id = adminUser.findByEmail(ACCOUNTS.admin.email).id;
}

/**
 * @param {{ catalog?: boolean }} opts catalog=false 이면 상품 없이(데이터 미적재 상태) 시작
 */
function setup({ catalog = true } = {}) {
  if (catalog) seedCatalog();
  seedAccounts();
  return { db, tmpDir, config, ACCOUNTS, ARTICLES };
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

module.exports = { setup, startServer, Client, ACCOUNTS, ARTICLES, tmpDir, db, config };
