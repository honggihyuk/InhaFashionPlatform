// InhaFashionPlatform — Express 애플리케이션 진입점
const path = require('path');
const express = require('express');
const session = require('express-session');
const ejs = require('ejs');
const config = require('./config');
const db = require('./db/mysql');
const mongo = require('./db/mongo');
const cart = require('./models/cart');
const notification = require('./models/notification');
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
app.use(async (req, res, next) => {
  res.locals.auth = req.session.auth || null;
  res.locals.path = req.path;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  const isUser = req.session.auth && req.session.auth.role === 'user';
  res.locals.cartCount = isUser ? await cart.count(req.session.auth.id) : 0;
  // 알림은 MongoDB(후처리로 생성) — 조회 실패 시 0
  res.locals.unread = isUser ? await notification.unreadCount(req.session.auth.id) : 0;
  res.locals.ko = ko;
  res.locals.won = (n) => `₩${Math.round(Number(n) || 0).toLocaleString('ko-KR')}`;
  next();
});
// CSRF 검사는 공통 값(path, auth 등) 설정 뒤에 해야 403 오류 페이지가 정상 렌더링됨
app.use(csrf);

// 상품 데이터가 적재됐는지 확인 (한 번 확인되면 캐시)
let ready = false;
app.use(async (req, res, next) => {
  if (ready || (ready = await db.catalogReady())) return next();
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

if (require.main === module) {
  (async () => {
    await db.migrate(); // MySQL 스키마·테이블 생성 (멱등)
    await mongo.ensureIndexes().catch((err) => console.warn('[app] MongoDB 인덱스 생성 실패:', err.message));
    app.listen(config.port, () => {
      console.log(`InhaFashionPlatform → http://localhost:${config.port}`);
      console.log('후처리 워커는 별도 터미널에서 `npm run worker` 로 실행하세요.');
    });
  })().catch((err) => {
    console.error('[app] 시작 실패 — MySQL 이 실행 중인지 확인하세요 (docker compose up -d):', err.message);
    process.exit(1);
  });
}

module.exports = app;
