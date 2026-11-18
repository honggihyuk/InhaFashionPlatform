// 상품 모델: H&M articles + 판매 정보(products) — MySQL catalog 스키마
// 이용자 쇼핑 화면은 MySQL 로 조회하고, 관리자 상품 검색은 Elasticsearch(search/products.js)를 씁니다.
const fs = require('fs');
const path = require('path');
const db = require('../db/mysql');
const config = require('../config');
const { FINAL_PRICE_SQL } = require('./pricing');

const { S } = db;

// price_krw: 정가, final_price_krw: 실제 판매가(행사 중이면 할인가), discount_pct: 행사 할인율(없으면 NULL)
const FROM = `FROM ${S.catalog}.products p JOIN ${S.catalog}.articles a ON a.article_id = p.article_id
  LEFT JOIN ${S.catalog}.promotions pr ON pr.article_id = p.article_id`;
const SELECT = `
  SELECT a.*, p.price_krw, p.stock, p.is_active, p.popularity, p.updated_at,
         pr.discount_pct, ${FINAL_PRICE_SQL} AS final_price_krw
  ${FROM}`;

const SORTS = {
  popular: 'p.popularity DESC, a.article_id',
  new: 'a.product_code DESC, a.article_id',
  price_asc: 'final_price_krw ASC, a.article_id',
  price_desc: 'final_price_krw DESC, a.article_id',
  discount: 'COALESCE(pr.discount_pct, 0) DESC, p.popularity DESC, a.article_id',
};

/** H&M 이미지 경로 규칙: images/010/0108775015.jpg. 파일이 없으면 SVG 일러스트로 대체 */
const imageCache = new Map();
function imageUrl(articleId) {
  if (!imageCache.has(articleId)) {
    const rel = path.join(articleId.slice(0, 3), `${articleId}.jpg`);
    imageCache.set(articleId, fs.existsSync(path.join(config.images.dir, rel))
      ? `/images/articles/${articleId.slice(0, 3)}/${articleId}.jpg`
      : `/media/article/${articleId}.svg`);
  }
  return imageCache.get(articleId);
}

function sizesFor(article) {
  if (article.index_group_name === 'Baby/Children') return ['134', '140', '146', '152', '158', '164', '170'];
  switch (article.product_group_name) {
    case 'Shoes': return ['36', '37', '38', '39', '40', '41', '42', '43', '44'];
    case 'Accessories':
    case 'Socks & Tights': return ['ONE SIZE'];
    default: return ['XS', 'S', 'M', 'L', 'XL'];
  }
}

function decorate(row) {
  if (!row) return row;
  return { ...row, image: imageUrl(row.article_id), sizes: sizesFor(row) };
}

function buildWhere({ q, index, group, colour, sale, includeInactive }) {
  const where = [];
  const params = {};
  if (!includeInactive) where.push('p.is_active = 1');
  if (q) {
    where.push('(a.prod_name LIKE :q OR a.product_type_name LIKE :q OR a.detail_desc LIKE :q OR a.article_id = :qid)');
    params.q = `%${q}%`;
    params.qid = q;
  }
  if (index) { where.push('a.index_group_name = :index'); params.index = index; }
  if (group) { where.push('a.product_group_name = :group'); params.group = group; }
  if (colour) { where.push('a.perceived_colour_master_name = :colour'); params.colour = colour; }
  if (sale) where.push('pr.article_id IS NOT NULL');
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

async function list(filters = {}) {
  const limit = Math.min(Number(filters.limit) || 24, 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const { sql, params } = buildWhere(filters);
  const order = SORTS[filters.sort] || SORTS.popular;
  const total = (await db.one(`SELECT COUNT(*) AS n ${FROM} ${sql}`, params)).n;
  const items = (await db.query(`${SELECT} ${sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, params)).map(decorate);
  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1), limit };
}

async function facets() {
  const col = (c) => db.query(`SELECT a.${c} AS name, COUNT(*) AS n FROM ${S.catalog}.products p
    JOIN ${S.catalog}.articles a ON a.article_id = p.article_id
    WHERE p.is_active = 1 GROUP BY a.${c} ORDER BY n DESC, name`);
  const [indexes, groups, colours] = await Promise.all([col('index_group_name'), col('product_group_name'), col('perceived_colour_master_name')]);
  return { indexes, groups, colours };
}

async function get(articleId) {
  return decorate(await db.one(`${SELECT} WHERE p.article_id = ?`, [String(articleId)]));
}

/** 같은 product_code 의 다른 색상 */
async function variants(product) {
  return (await db.query(`${SELECT} WHERE a.product_code = ? AND p.is_active = 1 ORDER BY a.article_id`, [product.product_code])).map(decorate);
}

/** 이 상품을 산 고객이 함께 산 상품 (H&M 거래 기반 간단한 공동구매 추천) */
async function alsoBought(articleId, limit = 4) {
  const rows = await db.query(`
    SELECT t.article_id, COUNT(*) AS n
    FROM (SELECT DISTINCT customer_id FROM ${S.catalog}.transactions WHERE article_id = :id LIMIT 400) b
    JOIN ${S.catalog}.transactions t ON t.customer_id = b.customer_id
    JOIN ${S.catalog}.products p ON p.article_id = t.article_id AND p.is_active = 1
    WHERE t.article_id <> :id GROUP BY t.article_id ORDER BY n DESC, t.article_id LIMIT ${Number(limit)}`, { id: articleId });
  return Promise.all(rows.map((r) => get(r.article_id)));
}

/** 해당 상품의 H&M 월별 판매량 (최근 12개월) */
function monthlySales(articleId) {
  return db.query(`
    SELECT DATE_FORMAT(t_dat, '%Y-%m') AS month, COUNT(*) AS units FROM ${S.catalog}.transactions
    WHERE article_id = ? AND t_dat >= (SELECT MAX(t_dat) FROM ${S.catalog}.transactions) - INTERVAL 365 DAY
    GROUP BY month ORDER BY month`, [articleId]);
}

/** 가격·재고·노출 수정 (tx: 같은 트랜잭션에서 outbox 를 함께 기록하기 위함) */
function update(tx, articleId, { price_krw, stock, is_active }) {
  return tx.exec(`UPDATE ${S.catalog}.products SET price_krw = :price, stock = :stock, is_active = :active WHERE article_id = :id`,
    { id: articleId, price: price_krw, stock, active: is_active ? 1 : 0 });
}

async function inventorySummary() {
  const r = await db.one(`SELECT COUNT(*) AS total, COALESCE(SUM(is_active), 0) AS active,
      COALESCE(SUM(stock = 0), 0) AS sold_out, COALESCE(SUM(stock BETWEEN 1 AND 9), 0) AS low_stock FROM ${S.catalog}.products`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

module.exports = { list, facets, get, variants, alsoBought, monthlySales, update, inventorySummary, sizesFor, imageUrl, decorate };
