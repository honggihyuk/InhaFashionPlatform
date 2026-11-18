// 상품 탐색: 홈, 목록/검색/필터/정렬, 상세, SVG 이미지 + product 모델 단위 테스트
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, cleanup, startServer, Client, ARTICLES } = require('./helpers/setup');

const product = require('../models/product');
const { ko } = require('../services/labels');

let server; let c;
before(async () => { await setup(); server = await startServer(); c = new Client(server.base); });
after(async () => { await server.close(); await cleanup(); });

describe('쇼핑 화면 (HTTP)', () => {
  test('홈: 인기 상품이 보이고 판매 중지 상품은 안 보임', async () => {
    const res = await c.get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /Strap top/);
    assert.doesNotMatch(res.text, /Retired scarf/);
  });

  test('목록: 검색어(q)로 상품명 검색', async () => {
    const res = await c.get('/products?q=sneakers');
    assert.equal(res.status, 200);
    assert.match(res.text, /Chunky sneakers/);
    assert.doesNotMatch(res.text, /Strap top/);
  });

  test('목록: article_id 로 정확히 검색', async () => {
    const res = await c.get(`/products?q=${ARTICLES.kidsDress.article_id}`);
    assert.match(res.text, /Kids dress/);
  });

  test('목록: index 필터 (아동)', async () => {
    const res = await c.get('/products?index=Baby%2FChildren');
    assert.match(res.text, /Kids dress/);
    assert.doesNotMatch(res.text, /Chunky sneakers/);
  });

  test('목록: 이상한 sort/page 값에도 500 이 나지 않음', async () => {
    for (const qs of ['sort=;DROP TABLE products', 'page=-5', 'page=abc', 'limit=99999']) {
      assert.equal((await c.get(`/products?${qs}`)).status, 200, qs);
    }
  });

  test('목록: 검색어의 SQL 특수문자는 그대로 문자열로 취급', async () => {
    const res = await c.get(`/products?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /Strap top/);
  });

  test('상세: 판매 중 상품은 200, 같은 product_code 의 다른 색상이 함께 보임', async () => {
    const res = await c.get(`/products/${ARTICLES.tee.article_id}`);
    assert.equal(res.status, 200);
    assert.match(res.text, new RegExp(ARTICLES.teeWhite.article_id));
  });

  test('상세: 판매 중지 상품은 404', async () => {
    assert.equal((await c.get(`/products/${ARTICLES.retired.article_id}`)).status, 404);
  });

  test('상세: 없는 상품은 404', async () => {
    assert.equal((await c.get('/products/9999999999')).status, 404);
  });

  test('없는 주소는 404 페이지', async () => {
    const res = await c.get('/no-such-page');
    assert.equal(res.status, 404);
    assert.match(res.text, /페이지를 찾을 수 없습니다/);
  });

  test('이미지가 없으면 SVG 일러스트를 돌려줌', async () => {
    const res = await c.get(`/media/article/${ARTICLES.sneaker.article_id}.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(res.text, /^<svg/);
  });

  test('없는 상품의 SVG 는 404', async () => {
    assert.equal((await c.get('/media/article/9999999999.svg')).status, 404);
  });

  test('정적 파일(css) 제공', async () => {
    const res = await c.get('/css/base.css');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
  });
});

describe('product 모델', () => {
  test('list: 판매 중인 상품만, 인기순 기본 정렬', async () => {
    const r = await product.list();
    assert.equal(r.total, 4);
    assert.ok(r.items.every((i) => i.is_active === 1));
    const pops = r.items.map((i) => i.popularity);
    assert.deepEqual(pops, [...pops].sort((a, b) => b - a));
  });

  test('list: includeInactive 이면 관리자용으로 전체', async () => {
    assert.equal((await product.list({ includeInactive: true })).total, 5);
  });

  test('list: 가격 오름차순/내림차순', async () => {
    const asc = (await product.list({ sort: 'price_asc' })).items.map((i) => i.price_krw);
    const desc = (await product.list({ sort: 'price_desc' })).items.map((i) => i.price_krw);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    assert.deepEqual(desc, [...desc].sort((a, b) => b - a));
  });

  test('list: 페이지 나누기', async () => {
    const p1 = await product.list({ limit: 3, page: 1 });
    const p2 = await product.list({ limit: 3, page: 2 });
    assert.equal(p1.pages, 2);
    assert.equal(p1.items.length, 3);
    assert.equal(p2.items.length, 1);
    assert.ok(!p1.items.some((a) => p2.items.some((b) => a.article_id === b.article_id)));
  });

  test('list: limit 은 최대 100', async () => {
    assert.equal((await product.list({ limit: 5000 })).limit, 100);
  });

  test('sizesFor: 아동/신발/액세서리/일반 의류', async () => {
    assert.deepEqual(product.sizesFor({ index_group_name: 'Baby/Children', product_group_name: 'Shoes' }).slice(0, 2), ['134', '140'], '아동이 우선');
    assert.ok(product.sizesFor({ product_group_name: 'Shoes' }).includes('42'));
    assert.deepEqual(product.sizesFor({ product_group_name: 'Accessories' }), ['ONE SIZE']);
    assert.deepEqual(product.sizesFor({ product_group_name: 'Socks & Tights' }), ['ONE SIZE']);
    assert.deepEqual(product.sizesFor({ product_group_name: 'Garment Upper body' }), ['XS', 'S', 'M', 'L', 'XL']);
  });

  test('imageUrl: 사진이 없으면 SVG 경로', async () => {
    assert.equal(product.imageUrl('0108775015'), '/media/article/0108775015.svg');
  });

  test('variants: 같은 product_code 의 판매 중 상품', async () => {
    const v = (await product.variants(await product.get(ARTICLES.tee.article_id))).map((x) => x.article_id);
    assert.deepEqual(v, [ARTICLES.tee.article_id, ARTICLES.teeWhite.article_id]);
  });

  test('alsoBought: H&M 거래에서 함께 산 상품', async () => {
    const r = await product.alsoBought(ARTICLES.tee.article_id);
    assert.deepEqual(r.map((x) => x.article_id), [ARTICLES.sneaker.article_id]);
  });

  test('monthlySales: 월별 판매량', async () => {
    assert.deepEqual((await product.monthlySales(ARTICLES.tee.article_id)).map((r) => ({ ...r })), [{ month: '2020-08', units: 1 }, { month: '2020-09', units: 1 }]);
  });

  test('facets: 판매 중 상품 기준 분류별 개수', async () => {
    const f = await product.facets();
    assert.ok(!f.groups.some((g) => g.name === 'Accessories'), '판매 중지 상품의 분류는 제외');
    assert.equal(f.groups.find((g) => g.name === 'Garment Upper body').n, 2);
  });

  test('inventorySummary: 품절/재고 부족 집계', async () => {
    const s = await product.inventorySummary();
    assert.equal(s.total, 5);
    assert.equal(s.active, 4);
    assert.equal(s.sold_out, 0);
    assert.equal(s.low_stock, 2); // tee(5), kidsDress(8)
  });
});

describe('한글 라벨', () => {
  test('알려진 분류는 한글, 모르는 값은 그대로', async () => {
    assert.equal(ko('Ladieswear'), '여성');
    assert.equal(ko('Garment Upper body'), '상의');
    assert.equal(ko('Something new'), 'Something new');
  });
});
