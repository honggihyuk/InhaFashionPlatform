# InhaFashionPlatform

H&M Personalized Fashion Recommendations(Kaggle) 데이터를 활용한 **의류 관리·판매 웹 서비스**입니다.

- **이용자**: H&M 상품 탐색 → 상세(사이즈·색상) → 장바구니 → 주문/결제 → 주문 내역·취소
- **관리자**: PyTorch로 분석한 **시간대별·일/주/월/요일별 판매 추이**, 다음 4주 매출 예측, 행사 상품 추천, **Elasticsearch 상품 검색**·재고·주문 관리, 작업 기록, 후처리 작업 모니터·재처리
- **스택**: Node.js(Express 5) + HTML(EJS 템플릿) + CSS / **MySQL 8**(거래 데이터) + **MongoDB 7**(문서·로그) + **Elasticsearch 8**(검색) + **RabbitMQ 3**(후처리) / Python + PyTorch
- **아키텍처**: 주문·관리 작업은 MySQL 트랜잭션 + Transactional Outbox 로 처리하고, 알림·감사 로그·검색 색인·활동 로그·분석 실행은 RabbitMQ 후처리 워커가 맡습니다. 재시도(5초→30초→2분) → DLQ → 관리자 재처리까지 갖췄습니다. 자세한 흐름도는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **디자인**: `public/css/variables.css` 토큰과 `DESIGN.md`(흰 캔버스, Inter, IBM Plex Mono 라벨, Ledger Brown 필 버튼, Oat 카드, Espresso 패널)

## 빠른 시작

```bash
# 요구 사항: Node.js 22.13 이상, Python 3.10 이상, Docker Desktop
docker compose up -d --wait                # MySQL · MongoDB · Elasticsearch · RabbitMQ (npm run infra:up)
npm install
pip install -r analysis/requirements.txt   # torch, pandas, numpy, pymysql

npm run setup     # 샘플 데이터 → MySQL, 계정/데모 주문, PyTorch 분석 → MongoDB, Elasticsearch 색인
npm start         # 웹 서버  http://localhost:3000
npm run worker    # 후처리 워커 (별도 터미널) — 알림·감사 로그·검색 색인·분석 실행
```

Python 실행 파일은 Windows 에서 `python`, 그 외에서 `python3` 을 기본으로 쓰며 `PYTHON` 환경변수로 바꿀 수 있습니다. 워커를 띄우지 않아도 주문·관리 기능은 동작하고,
밀린 후처리는 워커를 켜는 순간 outbox 에서 이어서 처리됩니다.

| 서비스 | 주소 | 계정 |
|---|---|---|
| RabbitMQ 관리 화면 | http://localhost:15672 | inha / inha-pass |
| Elasticsearch | http://localhost:9200 | (보안 끔, 개발용) |
| MySQL | localhost:3306 | inha / inha-pass (스키마 `inha_catalog`, `inha_admin`, `inha_member`) |
| MongoDB | mongodb://localhost:27017 | DB `inha_docs` |

| 구분 | 이메일 | 비밀번호 | 접속 |
|---|---|---|---|
| 이용자 | user@inha.fashion | user1234 | `/login` |
| 관리자 | admin@inha.fashion | admin1234 | `/login?as=admin` |

## 실제 Kaggle H&M 데이터 사용

1. https://www.kaggle.com/competitions/h-and-m-personalized-fashion-recommendations/data 에서
   `articles.csv`, `customers.csv`, `transactions_train.csv` 를 받아 `data/raw/` 에 넣습니다.
   (CLI: `kaggle competitions download -c h-and-m-personalized-fashion-recommendations -f transactions_train.csv`)
2. 거래가 3,100만 건이라 기간을 제한해 적재하는 것을 권장합니다.
   ```bash
   python analysis/load_hm_data.py --since 2020-03-01 --max-articles 5000   # LOAD DATA LOCAL INFILE 로 MySQL 적재
   npm run seed && npm run analyze && npm run search:reindex
   ```
3. 상품 이미지(`images/0xx/0xxxxxxxxx.jpg`)를 `public/images/articles/` 에 같은 구조로 복사하면 자동으로 사용됩니다.
   이미지가 없으면 품목·색상·패턴으로 그린 SVG 일러스트가 대신 표시됩니다.

`npm run data:sample` 은 원본과 **같은 컬럼·형식**(10자리 article_id, 64자리 customer_id, 정규화 가격, 채널 1/2,
2018-09-20 ~ 2020-09-22)의 개발용 샘플(상품 600, 고객 4,000, 거래 약 27만)을 만듭니다.

## 폴더 구조 (Spring 프로젝트 구성에 대응)

```
app.js                 진입점 (Spring Boot Application)
config/                설정 (application.properties)
routes/                컨트롤러 (@Controller)
  auth.js              로그인(이용자/관리자 분리)·회원가입·로그아웃
  shop.js              홈·상품 목록·상세·상품 이미지
  cart.js, orders.js   장바구니, 주문/결제, 주문 내역
  admin.js             관리자 대시보드·상품 검색·주문·행사·작업 기록·후처리 모니터
models/                데이터 접근 (@Repository) — MySQL 트랜잭션 + outbox 이벤트 기록
services/              비즈니스 로직 (@Service): 비밀번호 해시, SVG, 라벨
search/products.js     Elasticsearch 매핑·색인·검색 (관리자 상품 검색)
messaging/             outbox.js(이벤트 기록), relay.js(outbox → RabbitMQ), rabbit.js(토폴로지·발행), consumer.js(재시도·DLQ·멱등)
workers/handlers.js    큐별 후처리: 검색 색인, 이용자 알림, 감사 로그, 활동 로그, PyTorch 분석 실행
worker.js              후처리 워커 진입점 (npm run worker)
scripts/               analyze.js(분석 즉시 실행 → MongoDB), reindex.js(ES 전체 재색인)
middleware/            인증·권한·CSRF (Spring Security 필터)
views/                 HTML 템플릿 (templates/)  — partials/, auth/, shop/, admin/
public/                정적 파일 (static/)        — css/, js/, images/
db/schema/             MySQL DDL: catalog.sql, admin.sql, member.sql ({{스키마}} 자리표시자)
db/mysql.js            MySQL 연결 풀·트랜잭션·마이그레이션
db/mongo.js            MongoDB 연결·인덱스(TTL 포함)
db/seed.js             개발용 계정·데모 주문
docker-compose.yml     MySQL · MongoDB · Elasticsearch · RabbitMQ
analysis/              Python: 샘플 생성, CSV → MySQL 적재, PyTorch 판매 추이 분석
docs/ARCHITECTURE.md   아키텍처·워크플로 도표
data/                  raw CSV (git 제외)
```

## 저장소 분리 (MySQL · MongoDB · Elasticsearch)

| 저장소 | 스키마 / 컬렉션 | 용도 |
|---|---|---|
| MySQL `inha_catalog` | articles, customers, transactions, products, promotions | H&M 원본 + 판매가·재고·행사 (트랜잭션·잠금 필요) |
| MySQL `inha_admin` | admin_users, analysis_runs, outbox_events | 관리자 계정·분석 실행 상태·관리자 이벤트 |
| MySQL `inha_member` | users, cart_items, orders, order_items, outbox_events | 이용자 계정·장바구니·주문·이용자 이벤트 |
| MongoDB `inha_docs` | analysis_results, audit_log, notifications, activity_events(90일 TTL), failed_messages, processed_messages(14일 TTL) | 큰 JSON 문서·로그·알림·실패 메시지 |
| Elasticsearch `inha_products` | 상품 검색 문서 | 관리자 상품 검색 (MySQL 의 사본, 언제든 재색인 가능) |

관리자 로그인은 `inha_admin.admin_users`, 이용자 로그인은 `inha_member.users` 만 조회하므로 계정 체계가 섞이지 않습니다.
로그인 후 세션의 role 로 화면이 나뉘며, 관리자는 쇼핑 화면 대신 `/admin` 으로, 이용자는 `/admin` 접근 시 403 이 됩니다.

## 후처리 (RabbitMQ) 와 재처리

- 주문·취소·가격/재고 변경·행사·분석 요청은 **업무 데이터와 이벤트를 같은 MySQL 트랜잭션**으로 `outbox_events` 에 기록합니다.
- 워커의 relay 가 outbox 를 RabbitMQ topic exchange 로 발행(publisher confirm)하고, 큐 5개가 나눠 처리합니다.
  `search-indexer`, `user-notifier`, `audit-writer`, `activity-logger`, `analysis-runner`
- 실패하면 재시도 대기 큐(TTL 5초 → 30초 → 2분)를 거쳐 다시 처리하고, 그래도 실패하면 DLQ → MongoDB `failed_messages` 로 보관합니다.
- 관리자 `/admin/jobs` 에서 큐·outbox·DLQ 상태를 보고 **재처리 / 전체 재처리** 할 수 있습니다. 같은 event_id 로 다시 발행하므로
  이미 성공한 큐는 건너뛰고 실패한 큐만 다시 실행됩니다(멱등 처리).
- RabbitMQ 가 내려가 있어도 주문은 정상 처리되고 이벤트는 outbox 에 남아, 브로커가 돌아오면 자동 발행됩니다.
  Elasticsearch 가 내려가 있으면 관리자 상품 화면은 MySQL 검색으로 대체 동작합니다.

흐름도와 장애 대응표는 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 를 보세요.

## PyTorch 판매 추이 분석 (`analysis/sales_trend.py`)

- 집계: 거래를 torch 텐서로 올려 `index_add_`/`bincount` 로 일·주·월·요일·채널·카테고리·상품별 매출 계산
- 예측: `DemandModel` = 선형 성분(추세, 요일 원-핫, 연간 푸리에 계절성, 블랙프라이데이·12월·시즌세일 플래그)
  + 계절성만 보는 작은 MLP. log 매출을 Huber 손실·AdamW 로 학습하고, 마지막 28일 홀드아웃으로 MAPE/MAE 를 검증한 뒤
  전체 데이터로 재학습해 다음 28일과 90% 구간을 예측합니다. 요일 계수는 대시보드에 "요일 효과"로 표시됩니다.
- **시간대(0~23시)**: H&M `transactions_train` 에는 날짜(`t_dat`)만 있고 시각이 없습니다. 그래서 시간대별 추이와
  요일×시간 히트맵은 시각이 기록되는 이 플랫폼의 주문(`member.orders.created_at`)으로 계산합니다.
  `npm run seed` 는 최근 60일 데모 주문(`source='seed'`)을 넣어 개발 중에도 차트가 보이게 하며, 실제 주문이 쌓이면 함께 반영됩니다.
- 관리자 화면의 "PyTorch 분석 다시 실행" 은 `analysis.requested` 이벤트만 남기고, RabbitMQ `analysis-runner` 워커가
  `sales_trend.py --mysql` 을 실행해 결과를 MongoDB `analysis_results` 에 저장합니다(최근 20개 보관, 실행 상태는 `inha_admin.analysis_runs`).
  `npm run analyze` 는 워커 없이 바로 실행해 저장합니다. Python 경로는 `PYTHON` 환경변수로 바꿀 수 있습니다.

## 테스트

```bash
npm test          # Node 테스트 (node:test 내장 러너, 추가 설치 없음) — test/*.test.js
npm run test:py   # PyTorch 분석 스크립트 테스트 (unittest) — analysis/tests/  ※ torch 미설치 시 건너뜀
npm run test:all  # 둘 다
```

테스트는 `docker compose up -d` 로 띄운 서비스를 쓰되, 파일마다 고유한 네임스페이스(`t_xxxx_`)로 MySQL 스키마·MongoDB DB·
Elasticsearch 인덱스·RabbitMQ 큐를 따로 만들고 끝나면 지우므로 개발 데이터(`inha_*`)를 건드리지 않습니다.
분석 실행 테스트는 PyTorch 대신 `test/fixtures/fake_analysis.js` 를 실행합니다. Python 테스트는 SQLite 픽스처로 계산을 검증하고,
MySQL 이 떠 있으면 `--mysql` 모드도 임시 스키마로 끝까지 실행해 봅니다.

| 파일 | 내용 |
|---|---|
| `test/auth.test.js` | 이용자/관리자 로그인 분리(admin·member 스키마), returnTo, 회원가입 검증, 로그아웃, CSRF |
| `test/roles.test.js` | 비로그인·이용자·관리자별 접근 가능/차단 화면 (302 / 403) |
| `test/shop.test.js` | 홈·목록·검색·필터·정렬·상세·SVG, product 모델 |
| `test/orders.test.js` | 장바구니, 배송비, 결제 검증, 재고 차감·롤백, 주문 소유권, 취소·재고 복구 |
| `test/admin.test.js` | 대시보드·분석 API, RabbitMQ 분석 실행, 상품/재고 수정 → 감사 로그·ES 색인, 주문 상태 변경 → 알림 |
| `test/promotions.test.js` | 행사 추천·승인·종료, 할인가 적용, 감사 로그, ES 행사 필터 |
| `test/postprocessing.test.js` | outbox 원자성, 브로커 장애 시 백오프·재발행, 중복 메시지 멱등, 재시도 → DLQ → 재처리, 알림 화면 |
| `test/search.test.js` | Elasticsearch 오타·앞글자·한글 분류 검색, 필터·패싯·정렬, 하이라이트 XSS 방지, MySQL 대체 검색 |
| `test/empty-catalog.test.js` | 데이터 미적재 시 503 안내 |
| `analysis/tests/test_sales_trend.py` | 일/주/월/요일 집계, 카테고리 성장률, 베스트셀러, 예측 모델, 시간대·히트맵, 행사 추천, CLI, MySQL 모드 |

## 환경 변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 3000 | 웹 서버 포트 |
| `SESSION_SECRET` | 개발용 값 | 운영 시 반드시 변경 |
| `INHA_NS` | `inha_` | MySQL 스키마·Mongo DB·ES 인덱스·RabbitMQ 이름 접두사 |
| `MYSQL_HOST` / `MYSQL_PORT` / `MYSQL_USER` / `MYSQL_PASSWORD` | 127.0.0.1 / 3306 / inha / inha-pass | MySQL 접속 (Python 스크립트도 같은 값 사용) |
| `MONGO_URL` | mongodb://127.0.0.1:27017 | MongoDB |
| `ES_URL` | http://127.0.0.1:9200 | Elasticsearch |
| `AMQP_URL` | amqp://inha:inha-pass@127.0.0.1:5672 | RabbitMQ |
| `MQ_RETRY_DELAYS` | 5000,30000,120000 | 재시도 대기(ms). 바꾸면 기존 재시도 큐를 지우고 워커를 다시 시작 |
| `PYTHON` | python3 | 분석 스크립트 실행 파일 |
