// Python 스크립트 실행 도우미 (npm run data:*): Windows 는 python, 그 외는 python3. PYTHON 환경변수가 있으면 그 값을 사용
const { spawnSync } = require('child_process');
const config = require('../config');

const r = spawnSync(config.analysis.python, process.argv.slice(2), { stdio: 'inherit', cwd: config.root });
if (r.error) console.error(`Python 실행 실패 (${config.analysis.python}): ${r.error.message}. PYTHON 환경변수를 확인하세요.`);
process.exit(r.status == null ? 1 : r.status);
