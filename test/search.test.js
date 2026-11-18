// 관리자 상품 검색 (Elasticsearch): 오타·앞글자·한글 분류 검색, 필터·패싯·정렬, 하이라이트, MySQL 대체 검색
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  setup, cleanup, startServer, Client, ACCOUNTS, ARTICLES, db, S, config,
} = require('./helpers/setup');

const search = require('../search/products');

const ids = (r) => r.items.map((i) => i.article_id).sort();
const { tee, teeWhite, sneaker, kidsDress, retired } = ARTICLES;

let server; let admin;
before(async () => {
  await setup();
  // HTML 이 들어간 상품명 (하이라이트가 이스케이프되는지 확인용)
  await db.exec(`INSERT INTO ${S.catalog}.articles (article_id, product_code, prod_name, product_group_name, index_group_name, perceived_colour_master_name)
    VALUES ('0500000001', '0500000', '<img src=x onerror=alert(1)> Denim jacket', 'Garment Upper body', 'Menswear', 'Blue')`);
  await db.exec(`INSERT INTO ${S.catalog}.products (article_id, price_krw, stock, is_active, popularity) VALUES ('0500000001', 79000, 0, 1, 1)`);
  await search.indexArticles(['0500000001'], { refresh: true });
  server = await startServer();
  admin = new Client(server.base);
  await admin.login(ACCOUNTS.admin, 'admin');
});
after(async () => { await server.close(); await cleanup(); });

describe('검색어', () => {
  test('상품명 오타 허용 (fuzzy): "sneekers" → Chunky sneakers', async () => {
    assert.deepEqual(ids(await search.search({ q: 'sneekers' })), [sneaker.article_id]);
  });

  test('앞글자 검색 (edge n-gram): "chun" → Chunky sneakers', async () => {
    assert.deepEqual(ids(await search.search({ q: 'chun' })), [sneaker.article_id]);
  });

  test('상품번호 정확 일치가 가장 위', async () => {
    const r = await search.search({ q: teeWhite.article_id });
    assert.equal(r.items[0].article_id, teeWhite.article_id);
  });

  test('product_code 로 같은 상품의 색상들', async () => {
    assert.deepEqual(ids(await search.search({ q: tee.product_code })), [tee.article_id, teeWhite.article_id]);
  });

  test('한글 분류로 검색: "여성" → Ladieswear 상품, "신발" → Shoes', async () => {
    assert.deepEqual(ids(await search.search({ q: '여성' })), [tee.article_id, teeWhite.article_id]);
    assert.deepEqual(ids(await search.search({ q: '신발' })), [sneaker.article_id]);
  });

  test('색상·상품 유형으로 검색', async () => {
    assert.ok(ids(await search.search({ q: 'pink' })).includes(kidsDress.article_id));
    assert.ok(ids(await search.search({ q: 'dress' })).includes(kidsDress.article_id));
  });

  test('하이라이트는 HTML 이스케이프 후 <mark> 만 남김', async () => {
    const r = await search.search({ q: 'denim' });
    assert.equal(r.items[0].article_id, '0500000001');
    assert.match(r.items[0].highlight, /<mark>Denim<\/mark>/);
    assert.doesNotMatch(r.items[0].highlight, /<img/);
    assert.match(r.items[0].highlight, /&lt;img/);
  });

  test('관리자 화면에서도 스크립트가 실행되지 않음', async () => {
    const res = await admin.get('/admin/products?q=denim');
    assert.doesNotMatch(res.text, /<img src=x onerror/);
    assert.match(res.text, /<mark>Denim<\/mark>/);
  });
});

describe('필터·패싯·정렬', () => {
  test('판매 중지 상품도 검색되고(관리자), 판매 여부로 거를 수 있음', async () => {
    assert.ok(ids(await search.search({})).includes(retired.article_id));
    assert.deepEqual(ids(await search.search({ active: '0' })), [retired.article_id]);
  });

  test('재고 상태: 품절 / 10개 미만 / 충분', async () => {
    assert.deepEqual(ids(await search.search({ stock: 'sold_out' })), ['0500000001']);
    assert.deepEqual(ids(await search.search({ stock: 'low' })), [tee.article_id, kidsDress.article_id].sort()); // 5, 8
    const r = await search.search({});
    assert.deepEqual(r.facets.stock, { ok: 3, low: 2, sold_out: 1 }); // retired(30)·teeWhite(20)·sneaker(10) / tee(5)·kidsDress(8) / denim(0)
  });

  test('부서·품목·색상 필터와 패싯 개수', async () => {
    const r = await search.search({ index: 'Ladieswear', colour: 'White' });
    assert.deepEqual(ids(r), [teeWhite.article_id]);
    const all = await search.search({});
    assert.equal(all.facets.groups.find((g) => g.name === 'Garment Upper body').n, 3);
    assert.equal(all.total, 6);
  });

  test('가격 범위 (할인가 기준)', async () => {
    assert.deepEqual(ids(await search.search({ minPrice: 20000, maxPrice: 60000 })), [sneaker.article_id]);
  });

  test('정렬: 재고 적은순, 가격순, 인기순', async () => {
    const stock = (await search.search({ sort: 'stock_asc' })).items.map((i) => i.stock);
    assert.deepEqual(stock, [...stock].sort((a, b) => a - b));
    const price = (await search.search({ sort: 'price_desc' })).items.map((i) => i.final_price_krw);
    assert.deepEqual(price, [...price].sort((a, b) => b - a));
    const pop = (await search.search({})).items.map((i) => i.popularity);
    assert.deepEqual(pop, [...pop].sort((a, b) => b - a));
  });

  test('페이지 나누기', async () => {
    const p1 = await search.search({ limit: 4, page: 1 });
    const p2 = await search.search({ limit: 4, page: 2 });
    assert.equal(p1.pages, 2);
    assert.equal(p2.items.length, 2);
  });

  test('관리자 화면: 엔진 표시, 필터 유지, 패싯 개수, 품절 바로가기', async () => {
    const res = await admin.get('/admin/products?stock=low&sort=stock_asc');
    assert.equal(res.status, 200);
    assert.match(res.text, /Elasticsearch/);
    assert.match(res.text, /2건/);
    assert.match(res.text, /<option value="low" selected>10개 미만 \(2\)/);
    assert.match(res.text, /href="\/admin\/products\?stock=sold_out[^"]*"/);
  });
});

describe('MySQL 과 동기화', () => {
  test('MySQL 에서 지워진 상품은 indexArticles 가 ES 에서도 삭제', async () => {
    await db.exec(`DELETE FROM ${S.catalog}.products WHERE article_id = '0500000001'`);
    await search.indexArticles(['0500000001'], { refresh: true });
    assert.equal((await search.search({ q: '0500000001' })).total, 0);
  });

  test('reindexAll 은 MySQL 의 현재 값으로 전체를 다시 색인', async () => {
    await db.exec(`UPDATE ${S.catalog}.products SET stock = 77 WHERE article_id = ?`, [sneaker.article_id]);
    const n = await search.reindexAll();
    assert.equal(n, 5);
    assert.equal((await search.search({ q: sneaker.article_id })).items[0].stock, 77);
  });
});

describe('Elasticsearch 장애 시 대체 검색', () => {
  test('ES 에 연결할 수 없으면 MySQL 검색으로 화면이 계속 동작', async () => {
    const url = config.elasticsearch.url;
    await search.close();
    config.elasticsearch.url = 'http://127.0.0.1:1';
    try {
      const res = await admin.get('/admin/products?q=sneakers');
      assert.equal(res.status, 200);
      assert.match(res.text, /MySQL 대체 검색/);
      assert.match(res.text, /Chunky sneakers/);
      assert.doesNotMatch(res.text, /Strap top/);
      const jobs = await admin.get('/admin/jobs');
      assert.match(jobs.text, /연결 실패/);
    } finally {
      await search.close();
      config.elasticsearch.url = url;
    }
    assert.match((await admin.get('/admin/products')).text, /status-ok">Elasticsearch/);
  });
});
