// Elasticsearch 상품 검색 (관리자 상품 관리 화면)
//
// - 인덱스 문서 = MySQL articles + products + promotions 를 합친 상품 1건 (article_id 를 문서 _id 로 사용)
// - 원본(진실)은 MySQL 이고 ES 는 검색용 사본입니다. 가격·재고가 바뀌면 RabbitMQ 후처리(search-indexer)가
//   MySQL 에서 최신 값을 다시 읽어 색인하므로, 같은 메시지를 여러 번 처리해도 결과가 같습니다(멱등).
// - 검색: 상품명 접두어·오타 허용(fuzzy), 상품번호 정확 일치, 한글 분류명(여성/상의/블랙…) 검색,
//   부서·품목·색상·재고 상태·판매 여부·행사 여부·가격 범위 필터, 패싯(집계), 하이라이트.
const { Client } = require('@elastic/elasticsearch');
const config = require('../config');
const db = require('../db/mysql');
const { S } = db;
const { ko } = require('../services/labels');
const { FINAL_PRICE_SQL } = require('../models/pricing');

const INDEX = config.elasticsearch.productIndex;
let client;
function es() {
  if (!client) client = new Client({ node: config.elasticsearch.url, requestTimeout: 5000, maxRetries: 1 });
  return client;
}

const MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    analysis: {
      tokenizer: {
        edge: { type: 'edge_ngram', min_gram: 1, max_gram: 15, token_chars: ['letter', 'digit'] },
      },
      analyzer: {
        name_prefix: { type: 'custom', tokenizer: 'edge', filter: ['lowercase', 'asciifolding'] },
        name_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding'] },
      },
    },
  },
  mappings: {
    properties: {
      article_id: { type: 'keyword' },
      product_code: { type: 'keyword' },
      prod_name: {
        type: 'text', analyzer: 'name_text',
        fields: { prefix: { type: 'text', analyzer: 'name_prefix', search_analyzer: 'name_text' }, raw: { type: 'keyword' } },
      },
      product_type_name: { type: 'text', fields: { raw: { type: 'keyword' } } },
      product_group_name: { type: 'keyword' },
      index_group_name: { type: 'keyword' },
      colour_group_name: { type: 'text', fields: { raw: { type: 'keyword' } } },
      perceived_colour_master_name: { type: 'keyword' },
      graphical_appearance_name: { type: 'keyword' },
      garment_group_name: { type: 'keyword' },
      section_name: { type: 'text' },
      detail_desc: { type: 'text' },
      labels_ko: { type: 'text', analyzer: 'name_prefix', search_analyzer: 'standard' }, // 여성·상의·블랙 등 한글 라벨
      price_krw: { type: 'integer' },
      final_price_krw: { type: 'integer' },
      discount_pct: { type: 'integer' },
      on_sale: { type: 'boolean' },
      stock: { type: 'integer' },
      stock_status: { type: 'keyword' }, // sold_out | low | ok
      is_active: { type: 'boolean' },
      popularity: { type: 'integer' },
      updated_at: { type: 'date', format: 'yyyy-MM-dd HH:mm:ss' },
    },
  },
};

function stockStatus(stock) {
  if (stock <= 0) return 'sold_out';
  if (stock < 10) return 'low';
  return 'ok';
}

function toDoc(r) {
  return {
    article_id: r.article_id, product_code: r.product_code, prod_name: r.prod_name,
    product_type_name: r.product_type_name, product_group_name: r.product_group_name, index_group_name: r.index_group_name,
    colour_group_name: r.colour_group_name, perceived_colour_master_name: r.perceived_colour_master_name,
    graphical_appearance_name: r.graphical_appearance_name, garment_group_name: r.garment_group_name,
    section_name: r.section_name, detail_desc: r.detail_desc,
    labels_ko: [ko(r.index_group_name), ko(r.product_group_name), ko(r.perceived_colour_master_name)].filter(Boolean).join(' '),
    price_krw: r.price_krw, final_price_krw: r.final_price_krw, discount_pct: r.discount_pct,
    on_sale: r.discount_pct != null, stock: r.stock, stock_status: stockStatus(r.stock), is_active: Boolean(r.is_active),
    popularity: r.popularity, updated_at: r.updated_at,
  };
}

const SOURCE_SQL = `SELECT a.*, p.price_krw, p.stock, p.is_active, p.popularity, p.updated_at, pr.discount_pct,
    ${FINAL_PRICE_SQL} AS final_price_krw
  FROM ${S.catalog}.products p JOIN ${S.catalog}.articles a ON a.article_id = p.article_id
  LEFT JOIN ${S.catalog}.promotions pr ON pr.article_id = p.article_id`;

async function ensureIndex() {
  const exists = await es().indices.exists({ index: INDEX });
  if (!exists) await es().indices.create({ index: INDEX, ...MAPPING });
}

/** 지정 상품을 MySQL 에서 다시 읽어 색인 (MySQL 에 없으면 ES 에서도 삭제) */
async function indexArticles(ids, { refresh = false } = {}) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return 0;
  await ensureIndex();
  const rows = await db.query(`${SOURCE_SQL} WHERE p.article_id IN (?)`, [unique]);
  const found = new Set(rows.map((r) => r.article_id));
  const ops = [];
  for (const r of rows) ops.push({ index: { _index: INDEX, _id: r.article_id } }, toDoc(r));
  for (const id of unique) if (!found.has(id)) ops.push({ delete: { _index: INDEX, _id: id } });
  const res = await es().bulk({ operations: ops, refresh });
  const errors = res.items.filter((i) => {
    const op = i.index || i.delete;
    return op.error && !(i.delete && op.status === 404);
  });
  if (errors.length) throw new Error(`ES 색인 실패 ${errors.length}건: ${JSON.stringify(errors[0]).slice(0, 300)}`);
  return rows.length;
}

/** 전체 재색인 (npm run search:reindex). 새 인덱스 없이 같은 인덱스를 덮어씀 */
async function reindexAll({ recreate = false, batch = 1000 } = {}) {
  if (recreate) await es().indices.delete({ index: INDEX, ignore_unavailable: true });
  await ensureIndex();
  let last = '';
  let total = 0;
  for (;;) {
    const ids = (await db.query(`SELECT article_id FROM ${S.catalog}.products WHERE article_id > ? ORDER BY article_id LIMIT ${batch}`, [last]))
      .map((r) => r.article_id);
    if (!ids.length) break;
    total += await indexArticles(ids);
    last = ids[ids.length - 1];
  }
  await es().indices.refresh({ index: INDEX });
  return total;
}

const SORTS = {
  relevance: ['_score', { popularity: 'desc' }],
  popular: [{ popularity: 'desc' }, { article_id: 'asc' }],
  new: [{ product_code: 'desc' }, { article_id: 'asc' }],
  price_asc: [{ final_price_krw: 'asc' }, { article_id: 'asc' }],
  price_desc: [{ final_price_krw: 'desc' }, { article_id: 'asc' }],
  stock_asc: [{ stock: 'asc' }, { popularity: 'desc' }],
};

/**
 * 관리자 상품 검색
 * filters: { q, index, group, colour, stock (sold_out|low|ok), active ('1'|'0'), sale ('1'), minPrice, maxPrice, sort, page, limit }
 */
async function search(filters = {}) {
  const limit = Math.min(Number(filters.limit) || 30, 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const must = [];
  const filter = [];
  const q = (filters.q || '').trim();
  if (q) {
    must.push({
      bool: {
        should: [
          { term: { article_id: { value: q, boost: 20 } } },
          { term: { product_code: { value: q, boost: 10 } } },
          { multi_match: { query: q, type: 'bool_prefix', operator: 'and', fields: ['prod_name.prefix^4', 'labels_ko^3'] } }, // "여성 블랙" = 두 낱말 모두
          { multi_match: { query: q, fields: ['prod_name^5', 'product_type_name^3', 'colour_group_name^2', 'section_name', 'detail_desc'], fuzziness: 'AUTO', prefix_length: 1 } },
        ],
        minimum_should_match: 1,
      },
    });
  }
  if (filters.index) filter.push({ term: { index_group_name: filters.index } });
  if (filters.group) filter.push({ term: { product_group_name: filters.group } });
  if (filters.colour) filter.push({ term: { perceived_colour_master_name: filters.colour } });
  if (filters.stock) filter.push({ term: { stock_status: filters.stock } });
  if (filters.active === '1' || filters.active === '0') filter.push({ term: { is_active: filters.active === '1' } });
  if (filters.sale === '1') filter.push({ term: { on_sale: true } });
  const range = {};
  if (Number(filters.minPrice) > 0) range.gte = Number(filters.minPrice);
  if (Number(filters.maxPrice) > 0) range.lte = Number(filters.maxPrice);
  if (Object.keys(range).length) filter.push({ range: { final_price_krw: range } });

  const sortKey = filters.sort && SORTS[filters.sort] ? filters.sort : (q ? 'relevance' : 'popular');
  const res = await es().search({
    index: INDEX,
    from: (page - 1) * limit,
    size: limit,
    track_total_hits: true,
    query: { bool: { must: must.length ? must : [{ match_all: {} }], filter } },
    sort: SORTS[sortKey],
    highlight: { encoder: 'html', pre_tags: ['<mark>'], post_tags: ['</mark>'], fields: { prod_name: {}, 'prod_name.prefix': {} } },
    aggs: {
      indexes: { terms: { field: 'index_group_name', size: 20 } },
      groups: { terms: { field: 'product_group_name', size: 30 } },
      colours: { terms: { field: 'perceived_colour_master_name', size: 30 } },
      stock: { terms: { field: 'stock_status', size: 3 } },
      on_sale: { filter: { term: { on_sale: true } } },
    },
  });
  const total = res.hits.total.value;
  const bucket = (a) => a.buckets.map((b) => ({ name: b.key, n: b.doc_count }));
  return {
    engine: 'elasticsearch',
    took: res.took,
    sort: sortKey,
    items: res.hits.hits.map((h) => ({
      ...h._source,
      highlight: (h.highlight && (h.highlight.prod_name || h.highlight['prod_name.prefix']) || [])[0] || null,
      score: h._score,
    })),
    total,
    page,
    pages: Math.max(Math.ceil(total / limit), 1),
    limit,
    facets: {
      indexes: bucket(res.aggregations.indexes),
      groups: bucket(res.aggregations.groups),
      colours: bucket(res.aggregations.colours),
      stock: Object.fromEntries(res.aggregations.stock.buckets.map((b) => [b.key, b.doc_count])),
      on_sale: res.aggregations.on_sale.doc_count,
    },
  };
}

async function health() {
  try {
    const [h, c] = await Promise.all([es().cluster.health(), es().count({ index: INDEX }).catch(() => ({ count: 0 }))]);
    return { ok: true, status: h.status, docs: c.count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function deleteIndex() {
  await es().indices.delete({ index: INDEX, ignore_unavailable: true });
}

async function close() {
  if (client) { const c = client; client = null; await c.close(); }
}

module.exports = { ensureIndex, indexArticles, reindexAll, search, health, deleteIndex, close, INDEX, stockStatus };
