// 장바구니 컨트롤러 (이용자 전용)
const express = require('express');
const db = require('../db/mysql');
const outbox = require('../messaging/outbox');
const cart = require('../models/cart');
const product = require('../models/product');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
router.use(requireUser);

router.get('/', async (req, res) => {
  res.render('shop/cart', { title: '장바구니', cart: await cart.summary(req.session.auth.id) });
});

router.post('/add', async (req, res) => {
  const item = await product.get(req.body.article_id);
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
  const auth = req.session.auth;
  // 장바구니 저장과 활동 로그 이벤트(outbox)를 한 트랜잭션으로
  await db.transaction(async (tx) => {
    await cart.add(tx, auth.id, item.article_id, req.body.size, qty);
    await outbox.enqueue(tx, 'member', 'cart.item_added', { article_id: item.article_id, size: req.body.size, qty },
      { type: 'user', id: auth.id, name: auth.name });
  });
  if (req.body.buy_now) return res.redirect('/checkout');
  req.session.flash = { type: 'ok', text: `${item.prod_name} (${req.body.size}) 상품을 장바구니에 담았습니다.` };
  return res.redirect(`/products/${item.article_id}`);
});

router.post('/update', async (req, res) => {
  await cart.setQty(req.session.auth.id, req.body.article_id, req.body.size, Number(req.body.qty) || 0);
  res.redirect('/cart');
});

router.post('/remove', async (req, res) => {
  await cart.remove(req.session.auth.id, req.body.article_id, req.body.size);
  res.redirect('/cart');
});

module.exports = router;
