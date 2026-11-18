// 분석을 지금 바로 실행해 결과를 MongoDB 에 저장 (npm run analyze)
//   초기 설치(npm run setup)처럼 워커를 띄우기 전에 대시보드용 결과가 필요할 때 사용합니다.
//   운영 중에는 관리자 화면의 "분석 다시 실행" → RabbitMQ analysis-runner 워커가 같은 일을 합니다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../db/mysql');
const mongo = require('../db/mongo');
const analysis = require('../models/analysis');
const { runPython } = require('../workers/handlers');

(async () => {
  const outFile = path.join(os.tmpdir(), `inha-analysis-cli-${process.pid}.json`);
  const { code, log } = await runPython(outFile);
  process.stdout.write(log);
  if (code !== 0) throw new Error(`분석 스크립트 실패 (exit ${code})`);
  const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.rmSync(outFile, { force: true });
  await mongo.ensureIndexes();
  const id = await analysis.saveResult(result, null);
  console.log(`분석 결과를 MongoDB analysis_results 에 저장했습니다 (_id=${id})`);
})().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
}).finally(() => Promise.allSettled([db.close(), mongo.close()]));
