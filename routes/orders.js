// 주문/결제 컨트롤러 (이용자 전용)
const express = require('express');
const cart = require('../models/cart');
const order = require('../models/order');
const user = require('../models/user');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
// 이 라우터는 '/' 에 마운트되므로 router.use 대신 각 경로에 requireUser 를 지정

const PAYMENTS = { card: '신용/체크카드', transfer: '계좌이체', kakaopay: '간편결제' };

router.get('/checkout', requireUser, (req, res) => {
  const summary = cart.summary(req.session.auth.id);
  if (!summary.items.length) return res.redirect('/cart');
  const me = user.findById(req.session.auth.id);
  res.render('shop/checkout', { title: '주문/결제', cart: summary, form: { recipient: me.name, phone: me.phone || '', address: me.address || '', payment_method: 'card' }, payments: PAYMENTS, error: null });
});

router.post('/checkout', requireUser, (req, res) => {
  const form = {
    recipient: (req.body.recipient || '').trim(), phone: (req.body.phone || '').trim(),
    address: (req.body.address || '').trim(), payment_method: req.body.payment_method,
  };
  const summary = cart.summary(req.session.auth.id);
  const fail = (error) => res.status(400).render('shop/checkout', { title: '주문/결제', cart: summary, form, payments: PAYMENTS, error });
  if (!form.recipient || !form.phone || !form.address) return fail('배송 정보를 모두 입력하세요.');
  if (!PAYMENTS[form.payment_method]) return fail('결제 수단을 선택하세요.');
  if (!req.body.agree) return fail('주문 내용 확인 및 결제 진행에 동의해 주세요.');
  try {
    const orderNo = order.placeFromCart(req.session.auth.id, form);
    return res.redirect(`/orders/${orderNo}?placed=1`);
  } catch (err) {
    if (err instanceof order.OrderError) return fail(err.message);
    throw err;
  }
});

router.get('/orders', requireUser, (req, res) => {
  res.render('shop/orders', { title: '주문 내역', orders: order.listByUser(req.session.auth.id) });
});

router.get('/orders/:orderNo', requireUser, (req, res, next) => {
  const o = order.getForUser(req.params.orderNo, req.session.auth.id);
  if (!o) return next();
  res.render('shop/order-detail', { title: `주문 ${o.order_no}`, order: o, placed: req.query.placed === '1', payments: PAYMENTS });
});

router.post('/orders/:orderNo/cancel', requireUser, (req, res) => {
  try {
    order.cancelByUser(req.params.orderNo, req.session.auth.id);
    req.session.flash = { type: 'ok', text: '주문이 취소되었습니다.' };
  } catch (err) {
    if (!(err instanceof order.OrderError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect(`/orders/${req.params.orderNo}`);
});

module.exports = router;
