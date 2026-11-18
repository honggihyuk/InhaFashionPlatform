// 인증/권한 미들웨어 — 세션의 role 로 관리자(admin)와 이용자(user) 화면을 분리
const crypto = require('crypto');

function requireUser(req, res, next) {
  if (req.session.auth && req.session.auth.role === 'user') return next();
  if (req.session.auth && req.session.auth.role === 'admin') {
    return res.status(403).render('error', { title: '접근 불가', message: '관리자 계정으로는 구매 기능을 사용할 수 없습니다. 이용자 계정으로 로그인하세요.' });
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session.auth && req.session.auth.role === 'admin') return next();
  if (req.session.auth) {
    return res.status(403).render('error', { title: '접근 불가', message: '관리자 전용 화면입니다.' });
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login?as=admin');
}

/** 관리자가 쇼핑 화면에 들어오면 관리자 콘솔로 보냄 (화면 분리) */
function redirectAdminToConsole(req, res, next) {
  if (req.session.auth && req.session.auth.role === 'admin') return res.redirect('/admin');
  return next();
}

/** 간단한 세션 기반 CSRF 토큰 */
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const token = (req.body && req.body._csrf) || req.get('x-csrf-token');
    if (token !== req.session.csrf) {
      return res.status(403).render('error', { title: '요청이 만료되었습니다', message: '페이지를 새로고침한 뒤 다시 시도해 주세요.' });
    }
  }
  return next();
}

module.exports = { requireUser, requireAdmin, redirectAdminToConsole, csrf };
