// 개발용 초기 데이터: 관리자/이용자 계정 + (선택) 시간대 분석용 데모 주문
//   node db/seed.js            계정만 생성
//   node db/seed.js --orders   최근 60일 데모 주문(source='seed')도 생성
const { db, transaction, catalogReady } = require('./connection');
const adminUser = require('../models/adminUser');
const user = require('../models/user');

if (!catalogReady()) {
  console.error('catalog.db 에 상품이 없습니다. 먼저 `npm run data:sample` (또는 data:load) 를 실행하세요.');
  process.exit(1);
}

if (!adminUser.findByEmail('admin@inha.fashion')) {
  adminUser.create({ email: 'admin@inha.fashion', name: '운영 관리자', role: 'super', plainPassword: 'admin1234' });
  console.log('관리자 계정: admin@inha.fashion / admin1234');
}
if (!user.findByEmail('user@inha.fashion')) {
  const hm = db.prepare('SELECT customer_id FROM customers LIMIT 1').get();
  user.create({ email: 'user@inha.fashion', name: '김인하', phone: '010-1234-5678', address: '인천광역시 미추홀구 인하로 100',
    plainPassword: 'user1234', hmCustomerId: hm && hm.customer_id });
  console.log('이용자 계정: user@inha.fashion / user1234');
}

if (process.argv.includes('--orders')) {
  const exists = db.prepare("SELECT COUNT(*) AS n FROM member.orders WHERE source = 'seed'").get().n;
  if (exists) {
    console.log(`데모 주문이 이미 ${exists}건 있습니다. 건너뜁니다.`);
  } else {
    // 결정적 난수 (재실행해도 같은 데이터)
    let s = 20201;
    const rand = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
    // 시간대 가중치: 점심(12~13시), 퇴근 후(20~22시) 피크
    const hourW = [2, 1, 0.6, 0.4, 0.3, 0.4, 0.8, 1.6, 2.4, 3, 3.6, 4.4, 6, 5.6, 4.4, 4, 4.2, 4.6, 5.2, 6.4, 7.6, 8, 6.4, 4];
    const sumW = hourW.reduce((a, b) => a + b, 0);
    const pickHour = () => { let r = rand() * sumW; for (let h = 0; h < 24; h += 1) { r -= hourW[h]; if (r <= 0) return h; } return 23; };
    const products = db.prepare('SELECT p.article_id, p.price_krw, a.prod_name FROM products p JOIN articles a USING(article_id) ORDER BY p.popularity DESC LIMIT 200').all();
    const buyers = [];
    for (let i = 1; i <= 40; i += 1) {
      const email = `demo${i}@inha.fashion`;
      buyers.push((user.findByEmail(email) || user.create({ email, name: `데모고객${i}`, plainPassword: 'demo1234' })).id);
    }
    const insOrder = db.prepare(`INSERT INTO member.orders (order_no, user_id, status, total_krw, recipient, phone, address, payment_method, source, created_at)
      VALUES (?, ?, ?, ?, ?, '010-0000-0000', '인천광역시 미추홀구', 'card', 'seed', ?)`);
    const insItem = db.prepare('INSERT INTO member.order_items (order_id, article_id, prod_name, size, qty, unit_price_krw) VALUES (?, ?, ?, ?, ?, ?)');
    let n = 0;
    transaction(() => {
      for (let day = 60; day >= 1; day -= 1) {
        const date = new Date(Date.now() - day * 86400000);
        const weekend = [0, 6].includes(date.getDay());
        const orders = Math.round((weekend ? 26 : 18) + rand() * 10);
        for (let k = 0; k < orders; k += 1) {
          const h = pickHour();
          const ts = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(Math.floor(rand() * 60)).padStart(2, '0')}:00`;
          const lines = 1 + Math.floor(rand() * 3);
          const picked = Array.from({ length: lines }, () => products[Math.floor(Math.pow(rand(), 2) * products.length)]);
          const total = picked.reduce((t, p) => t + p.price_krw, 0);
          const status = day > 7 ? 'DELIVERED' : day > 2 ? 'SHIPPING' : 'PAID';
          n += 1;
          const info = insOrder.run(`SEED-${String(n).padStart(5, '0')}`, buyers[Math.floor(rand() * buyers.length)], status,
            total + (total >= 50000 ? 0 : 3000), `데모고객`, ts);
          for (const p of picked) insItem.run(Number(info.lastInsertRowid), p.article_id, p.prod_name, 'M', 1, p.price_krw);
        }
      }
    });
    console.log(`데모 주문 ${n}건 생성 (source='seed', 최근 60일)`);
  }
}
