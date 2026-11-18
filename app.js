// InhaFashionPlatform — Express 애플리케이션 진입점
const path = require('path');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const config = require('./config');
const { catalogReady } = require('./db/connection');
const analysis = require('./models/analysis');
const cart = require('./models/cart');
const { csrf } = require('./middleware/auth');
const { ko } = require('./services/labels');

const app = express();

// views/*.html 을 EJS 템플릿으로 렌더링
app.engine('html', ejs.renderFile);
app.set('view engine', 'html');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
}));
// 모든 템플릿에서 쓰는 공통 값
app.use((req, res, next) => {
  res.locals.auth = req.session.auth || null;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  res.locals.cartCount = req.session.auth && req.session.auth.role === 'user' ? cart.count(req.session.auth.id) : 0;
  res.locals.ko = ko;
  res.locals.won = (n) => `₩${Math.round(Number(n) || 0).toLocaleString('ko-KR')}`;
  next();
});
// CSRF 검사는 공통 값(path, auth 등) 설정 뒤에 해야 403 오류 페이지가 정상 렌더링됨
app.use(csrf);

app.use((req, res, next) => {
  if (catalogReady()) return next();
  return res.status(503).render('error', { title: '데이터 준비 필요', message: 'H&M 데이터가 아직 적재되지 않았습니다. `npm run setup` 을 실행하세요.' });
});

// 라우터 (Spring 의 @Controller 역할)
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/shop'));
app.use('/cart', require('./routes/cart'));
app.use('/', require('./routes/orders'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: '페이지를 찾을 수 없습니다', message: '주소를 다시 확인해 주세요.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: '오류가 발생했습니다', message: '잠시 후 다시 시도해 주세요.' });
});

analysis.markStaleFailed();

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`InhaFashionPlatform → http://localhost:${config.port}`);
  });
}

module.exports = app;
