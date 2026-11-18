// 상품 모델: H&M articles + 판매 정보(products)
const fs = require('fs');
const path = require('path');
const { db } = require('../db/connection');
const config = require('../config');
const { FINAL_PRICE_SQL } = require('./promotion');

// price_krw: 정가, final_price_krw: 실제 판매가(행사 중이면 할인가), discount_pct: 행사 할인율(없으면 NULL)
const FROM = `FROM products p JOIN articles a ON a.article_id = p.article_id
  LEFT JOIN promotions pr ON pr.article_id = p.article_id`;
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

function list(filters = {}) {
  const limit = Math.min(Number(filters.limit) || 24, 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const { sql, params } = buildWhere(filters);
  const order = SORTS[filters.sort] || SORTS.popular;
  const total = db.prepare(`SELECT COUNT(*) AS n ${FROM} ${sql}`).get(params).n;
  const items = db.prepare(`${SELECT} ${sql} ORDER BY ${order} LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit, offset: (page - 1) * limit }).map(decorate);
  return { items, total, page, pages: Math.max(Math.ceil(total / limit), 1), limit };
}

function facets() {
  const col = (c) => db.prepare(`SELECT a.${c} AS name, COUNT(*) AS n FROM products p JOIN articles a USING(article_id)
    WHERE p.is_active = 1 GROUP BY a.${c} ORDER BY n DESC`).all();
  return {
    indexes: col('index_group_name'),
    groups: col('product_group_name'),
    colours: col('perceived_colour_master_name'),
  };
}

function get(articleId) {
  return decorate(db.prepare(`${SELECT} WHERE p.article_id = ?`).get(articleId));
}

/** 같은 product_code 의 다른 색상 */
function variants(product) {
  return db.prepare(`${SELECT} WHERE a.product_code = ? AND p.is_active = 1 ORDER BY a.article_id`)
    .all(product.product_code).map(decorate);
}

/** 이 상품을 산 고객이 함께 산 상품 (H&M 거래 기반 간단한 공동구매 추천) */
function alsoBought(articleId, limit = 4) {
  return db.prepare(`
    WITH buyers AS (SELECT DISTINCT customer_id FROM transactions WHERE article_id = :id LIMIT 400)
    SELECT t.article_id, COUNT(*) AS n FROM transactions t JOIN buyers b USING(customer_id)
    JOIN products p ON p.article_id = t.article_id AND p.is_active = 1
    WHERE t.article_id <> :id GROUP BY t.article_id ORDER BY n DESC LIMIT :limit`)
    .all({ id: articleId, limit }).map((r) => get(r.article_id));
}

/** 해당 상품의 H&M 월별 판매량 (최근 12개월) */
function monthlySales(articleId) {
  return db.prepare(`
    SELECT substr(t_dat, 1, 7) AS month, COUNT(*) AS units FROM transactions
    WHERE article_id = ? AND t_dat >= date((SELECT MAX(t_dat) FROM transactions), '-365 day')
    GROUP BY month ORDER BY month`).all(articleId);
}

function update(articleId, { price_krw, stock, is_active }) {
  db.prepare(`UPDATE products SET price_krw = :price, stock = :stock, is_active = :active,
      updated_at = datetime('now') WHERE article_id = :id`)
    .run({ id: articleId, price: price_krw, stock, active: is_active ? 1 : 0 });
}

function inventorySummary() {
  return db.prepare(`SELECT COUNT(*) AS total, SUM(is_active) AS active,
      SUM(CASE WHEN stock = 0 THEN 1 ELSE 0 END) AS sold_out,
      SUM(CASE WHEN stock BETWEEN 1 AND 9 THEN 1 ELSE 0 END) AS low_stock FROM products`).get();
}

module.exports = { list, facets, get, variants, alsoBought, monthlySales, update, inventorySummary, sizesFor, imageUrl };
