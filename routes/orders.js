// 주문/결제 컨트롤러 (이용자 전용)
// 주문·취소는 MySQL 트랜잭션 + outbox 이벤트로 처리하고, 알림·검색 색인·활동 로그는 RabbitMQ 후처리가 맡습니다.
const express = require('express');
const cart = require('../models/cart');
const order = require('../models/order');
const user = require('../models/user');
const notification = require('../models/notification');
const { requireUser } = require('../middleware/auth');

const router = express.Router();
// 이 라우터는 '/' 에 마운트되므로 router.use 대신 각 경로에 requireUser 를 지정

const PAYMENTS = { card: '신용/체크카드', transfer: '계좌이체', kakaopay: '간편결제' };
const me = (req) => ({ id: req.session.auth.id, name: req.session.auth.name });

router.get('/checkout', requireUser, async (req, res) => {
  const summary = await cart.summary(req.session.auth.id);
  if (!summary.items.length) return res.redirect('/cart');
  const u = await user.findById(req.session.auth.id);
  res.render('shop/checkout', { title: '주문/결제', cart: summary, form: { recipient: u.name, phone: u.phone || '', address: u.address || '', payment_method: 'card' }, payments: PAYMENTS, error: null });
});

router.post('/checkout', requireUser, async (req, res) => {
  const form = {
    recipient: (req.body.recipient || '').trim(), phone: (req.body.phone || '').trim(),
    address: (req.body.address || '').trim(), payment_method: req.body.payment_method,
  };
  const fail = async (error) => res.status(400).render('shop/checkout', { title: '주문/결제', cart: await cart.summary(req.session.auth.id), form, payments: PAYMENTS, error });
  if (!form.recipient || !form.phone || !form.address) return fail('배송 정보를 모두 입력하세요.');
  if (!PAYMENTS[form.payment_method]) return fail('결제 수단을 선택하세요.');
  if (!req.body.agree) return fail('주문 내용 확인 및 결제 진행에 동의해 주세요.');
  try {
    const orderNo = await order.placeFromCart(me(req), form);
    return res.redirect(`/orders/${orderNo}?placed=1`);
  } catch (err) {
    if (err instanceof order.OrderError) return fail(err.message);
    throw err;
  }
});

router.get('/orders', requireUser, async (req, res) => {
  const [orders, notifications] = await Promise.all([
    order.listByUser(req.session.auth.id), notification.listForUser(req.session.auth.id, 8),
  ]);
  // 이 화면에서 알림을 보여 주므로 메뉴의 새 알림 표시는 지우고, 읽음 처리
  res.render('shop/orders', { title: '주문 내역', orders, notifications, unread: 0 });
  notification.markAllRead(req.session.auth.id).catch(() => {});
});

router.get('/orders/:orderNo', requireUser, async (req, res, next) => {
  const o = await order.getForUser(req.params.orderNo, req.session.auth.id);
  if (!o) return next();
  res.render('shop/order-detail', { title: `주문 ${o.order_no}`, order: o, placed: req.query.placed === '1', payments: PAYMENTS });
});

router.post('/orders/:orderNo/cancel', requireUser, async (req, res) => {
  try {
    await order.cancelByUser(req.params.orderNo, me(req));
    req.session.flash = { type: 'ok', text: '주문이 취소되었습니다.' };
  } catch (err) {
    if (!(err instanceof order.OrderError)) throw err;
    req.session.flash = { type: 'error', text: err.message };
  }
  res.redirect(`/orders/${req.params.orderNo}`);
});

module.exports = router;
