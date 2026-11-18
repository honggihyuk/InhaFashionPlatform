// 인증 컨트롤러: 로그인(이용자/관리자 분리), 회원가입, 로그아웃
const express = require('express');
const user = require('../models/user');
const adminUser = require('../models/adminUser');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.auth) return res.redirect(req.session.auth.role === 'admin' ? '/admin' : '/');
  res.render('auth/login', { title: '로그인', as: req.query.as === 'admin' ? 'admin' : 'user', error: null, email: '' });
});

router.post('/login', async (req, res) => {
  const { email = '', password = '', as = 'user' } = req.body;
  const role = as === 'admin' ? 'admin' : 'user';
  // 관리자는 admin 스키마, 이용자는 member 스키마에서만 조회 → 계정 체계 분리
  const account = role === 'admin' ? await adminUser.authenticate(email, password) : await user.authenticate(email, password);
  if (!account) {
    return res.status(401).render('auth/login', { title: '로그인', as: role, email, error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.auth = { role, id: account.id, name: account.name, email: account.email, adminRole: account.role };
    const fallback = role === 'admin' ? '/admin' : '/';
    const safe = returnTo && returnTo.startsWith(role === 'admin' ? '/admin' : '/') && !(role === 'user' && returnTo.startsWith('/admin'));
    res.redirect(safe ? returnTo : fallback);
  });
});

router.get('/signup', (req, res) => {
  res.render('auth/signup', { title: '회원가입', error: null, form: {} });
});

router.post('/signup', async (req, res) => {
  const form = { email: (req.body.email || '').trim(), name: (req.body.name || '').trim(), phone: (req.body.phone || '').trim(), address: (req.body.address || '').trim() };
  const { password = '', password2 = '' } = req.body;
  let error = null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) error = '올바른 이메일을 입력하세요.';
  else if (!form.name) error = '이름을 입력하세요.';
  else if (password.length < 8) error = '비밀번호는 8자 이상이어야 합니다.';
  else if (password !== password2) error = '비밀번호가 일치하지 않습니다.';
  else if (await user.findByEmail(form.email)) error = '이미 가입된 이메일입니다.';
  if (error) return res.status(400).render('auth/signup', { title: '회원가입', error, form });

  let created;
  try {
    created = await user.create({ ...form, plainPassword: password });
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err; // 동시에 같은 이메일로 가입한 경우
    return res.status(400).render('auth/signup', { title: '회원가입', error: '이미 가입된 이메일입니다.', form });
  }
  req.session.regenerate(() => {
    req.session.auth = { role: 'user', id: created.id, name: created.name, email: created.email };
    res.redirect('/');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
