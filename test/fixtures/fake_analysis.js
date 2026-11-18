// analysisRunner 테스트용 가짜 분석 스크립트 (PyTorch 없이 실행 흐름만 검증)
// sales_trend.py 와 같은 인자(--catalog --member --out)를 받고, FAKE_ANALYSIS_MODE 로 동작을 바꿉니다.
//   ok   : 고정 결과 JSON 을 --out 에 쓰고 종료코드 0
//   fail : stderr 에 메시지를 쓰고 종료코드 3
//   slow : 0.5초 뒤 ok 와 같이 동작 (중복 실행 방지 테스트용)
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const out = args[args.indexOf('--out') + 1];
const mode = process.env.FAKE_ANALYSIS_MODE || 'ok';

function writeResult() {
  const result = JSON.parse(fs.readFileSync(path.join(__dirname, 'sales_trends.sample.json'), 'utf8'));
  result.received_args = args;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result));
  console.log('fake analysis done');
}

if (mode === 'fail') {
  console.error('분석 실패: 테스트용 오류');
  process.exit(3);
} else if (mode === 'slow') {
  setTimeout(writeResult, 500);
} else {
  writeResult();
}
