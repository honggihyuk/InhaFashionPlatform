// 이용자 쇼핑 컨트롤러: 홈, 상품 목록/검색, 상품 상세, 상품 이미지
const express = require('express');
const db = require('../db/mysql');
const outbox = require('../messaging/outbox');
const product = require('../models/product');
const garmentSvg = require('../services/garmentSvg');
const { redirectAdminToConsole } = require('../middleware/auth');

const router = express.Router();

router.get('/', redirectAdminToConsole, async (req, res) => {
  const [facets, trending, sale, newIn] = await Promise.all([
    product.facets(),
    product.list({ sort: 'popular', limit: 8 }),
    product.list({ sale: true, sort: 'discount', limit: 8 }),
    product.list({ sort: 'new', limit: 4 }),
  ]);
  res.render('shop/home', { title: 'InhaFashion', trending: trending.items, sale, newIn: newIn.items, indexes: facets.indexes });
});

router.get('/products', redirectAdminToConsole, async (req, res) => {
  const filters = {
    q: (req.query.q || '').trim(), index: req.query.index || '', group: req.query.group || '',
    colour: req.query.colour || '', sale: req.query.sale === '1' ? '1' : '',
    sort: req.query.sort || 'popular', page: req.query.page || 1, limit: 24,
  };
  const [result, facets] = await Promise.all([product.list(filters), product.facets()]);
  const qs = (patch) => {
    const p = new URLSearchParams();
    Object.entries({ ...filters, page: 1, limit: undefined, ...patch }).forEach(([k, v]) => { if (v && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'popular')) p.set(k, v); });
    const s = p.toString();
    return s ? `/products?${s}` : '/products';
  };
  res.render('shop/list', { title: '상품', filters, result, facets, qs });
});

router.get('/products/:id', redirectAdminToConsole, async (req, res, next) => {
  const item = await product.get(req.params.id);
  if (!item || !item.is_active) return next();
  const [variants, alsoBought, sales] = await Promise.all([
    product.variants(item), product.alsoBought(item.article_id), product.monthlySales(item.article_id),
  ]);
  // 조회 활동 로그는 후처리(activity-logger)로 — 기록 실패가 상품 화면을 막지 않도록 응답과 분리
  const auth = req.session.auth;
  db.transaction((tx) => outbox.enqueue(tx, 'member', 'product.viewed', { article_id: item.article_id },
    auth ? { type: 'user', id: auth.id, name: auth.name } : null)).catch(() => {});
  res.render('shop/detail', { title: item.prod_name, item, variants, alsoBought, sales });
});

router.get('/media/article/:id.svg', async (req, res, next) => {
  const item = await product.get(req.params.id);
  if (!item) return next();
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(garmentSvg.render(item));
});

module.exports = router;
