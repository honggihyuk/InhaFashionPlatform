// H&M 데이터를 아직 적재하지 않은 상태: 모든 화면이 503 안내 페이지
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, startServer, Client } = require('./helpers/setup');

setup({ catalog: false });
let server;
before(async () => { server = await startServer(); });
after(async () => { await server.close(); });

for (const p of ['/', '/products', '/login', '/admin']) {
  test(`상품 데이터가 없으면 ${p} 은 503 과 setup 안내`, async () => {
    const res = await new Client(server.base).get(p);
    assert.equal(res.status, 503);
    assert.match(res.text, /npm run setup/);
  });
}

test('정적 파일은 데이터가 없어도 제공', async () => {
  assert.equal((await new Client(server.base).get('/css/base.css')).status, 200);
});
