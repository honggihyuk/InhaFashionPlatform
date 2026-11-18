// 장바구니 컨트롤러 (이용자 전용)
const express = require('express');
const cart = require('../models/cart');
const product = require('../models/product');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireUser);

router.get('/', (req, res) => {
  res.render('shop/cart', { title: '장바구니', cart: cart.summary(req.session.auth.id) });
});

router.post('/add', (req, res) => {
  const item = product.get(req.body.article_id);
  const qty = Math.max(1, Math.min(Number(req.body.qty) || 1, 10));
  if (!item || !item.is_active) {
    req.session.flash = { type: 'error', text: '판매 중인 상품이 아닙니다.' };
    return res.redirect(req.get('referer') || '/products');
  }
  if (!item.sizes.includes(req.body.size)) {
    req.session.flash = { type: 'error', text: '사이즈를 선택하세요.' };
    return res.redirect(`/products/${item.article_id}`);
  }
  if (item.stock < qty) {
    req.session.flash = { type: 'error', text: `재고가 부족합니다. (남은 수량 ${item.stock}개)` };
    return res.redirect(`/products/${item.article_id}`);
  }
  cart.add(req.session.auth.id, item.article_id, req.body.size, qty);
  if (req.body.buy_now) return res.redirect('/checkout');
  req.session.flash = { type: 'ok', text: `${item.prod_name} (${req.body.size}) 상품을 장바구니에 담았습니다.` };
  return res.redirect(`/products/${item.article_id}`);
});

router.post('/update', (req, res) => {
  cart.setQty(req.session.auth.id, req.body.article_id, req.body.size, Number(req.body.qty) || 0);
  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  cart.remove(req.session.auth.id, req.body.article_id, req.body.size);
  res.redirect('/cart');
});

module.exports = router;
