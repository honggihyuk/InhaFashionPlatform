// 이용자 쇼핑 컨트롤러: 홈, 상품 목록/검색, 상품 상세, 상품 이미지
const express = require('express');
const product = require('../models/product');
const garmentSvg = require('../services/garmentSvg');
const { redirectAdminToConsole } = require('../middleware/auth');

const router = express.Router();

router.get('/', redirectAdminToConsole, (req, res) => {
  const facets = product.facets();
  res.render('shop/home', {
    title: 'InhaFashion',
    trending: product.list({ sort: 'popular', limit: 8 }).items,
    sale: product.list({ sale: true, sort: 'discount', limit: 8 }),
    newIn: product.list({ sort: 'new', limit: 4 }).items,
    indexes: facets.indexes,
  });
});

router.get('/products', redirectAdminToConsole, (req, res) => {
  const filters = {
    q: (req.query.q || '').trim(), index: req.query.index || '', group: req.query.group || '',
    colour: req.query.colour || '', sale: req.query.sale === '1' ? '1' : '',
    sort: req.query.sort || 'popular', page: req.query.page || 1, limit: 24,
  };
  const result = product.list(filters);
  const qs = (patch) => {
    const p = new URLSearchParams();
    Object.entries({ ...filters, page: 1, limit: undefined, ...patch }).forEach(([k, v]) => { if (v && !(k === 'page' && v === 1) && !(k === 'sort' && v === 'popular')) p.set(k, v); });
    const s = p.toString();
    return s ? `/products?${s}` : '/products';
  };
  res.render('shop/list', { title: '상품', filters, result, facets: product.facets(), qs });
});

router.get('/products/:id', redirectAdminToConsole, (req, res, next) => {
  const item = product.get(req.params.id);
  if (!item || !item.is_active) return next();
  res.render('shop/detail', {
    title: item.prod_name,
    item,
    variants: product.variants(item),
    alsoBought: product.alsoBought(item.article_id),
    sales: product.monthlySales(item.article_id),
  });
});

router.get('/media/article/:id.svg', (req, res, next) => {
  const item = product.get(req.params.id);
  if (!item) return next();
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(garmentSvg.render(item));
});

module.exports = router;
