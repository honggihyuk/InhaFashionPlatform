# InhaFashionPlatform

H&M Personalized Fashion Recommendations(Kaggle) 데이터를 활용한 **의류 관리·판매 웹 서비스**입니다.

- **이용자**: H&M 상품 탐색 → 상세(사이즈·색상) → 장바구니 → 주문/결제 → 주문 내역·취소
- **관리자**: PyTorch로 분석한 **시간대별·일/주/월/요일별 판매 추이**, 다음 4주 매출 예측, 상품·재고·주문 관리, 작업 기록
- **스택**: Node.js(Express 5) + HTML(EJS 템플릿) + CSS / SQLite(`node:sqlite`) / Python + PyTorch
- **디자인**: `public/css/variables.css` 토큰과 `DESIGN.md`(흰 캔버스, Inter, IBM Plex Mono 라벨, Ledger Brown 필 버튼, Oat 카드, Espresso 패널)

## 빠른 시작

```bash
# 요구 사항: Node.js 22.13 이상, Python 3.10 이상
npm install
pip install -r analysis/requirements.txt   # torch, pandas, numpy

npm run setup     # 샘플 데이터 생성·적재 → 계정/데모 주문 생성 → PyTorch 분석
npm start         # http://localhost:3000
```

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
   python analysis/load_hm_data.py --since 2020-03-01 --max-articles 5000
   npm run seed && npm run analyze
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
  admin.js             관리자 대시보드·상품·주문·작업 기록, 분석 실행 API
models/                데이터 접근 (@Repository)
services/              비즈니스 로직 (@Service): 비밀번호 해시, 분석 실행, SVG, 라벨
middleware/            인증·권한·CSRF (Spring Security 필터)
views/                 HTML 템플릿 (templates/)  — partials/, auth/, shop/, admin/
public/                정적 파일 (static/)        — css/, js/, images/
db/schema/             DB 스키마 SQL: catalog.sql, admin.sql, member.sql
db/connection.js       SQLite 연결 + 스키마 ATTACH
db/seed.js             개발용 계정·데모 주문
analysis/              Python: 샘플 생성, CSV 적재, PyTorch 판매 추이 분석
data/                  raw CSV, SQLite DB, 분석 결과 JSON (git 제외)
```

## DB 스키마 분리

하나의 연결에서 세 개의 SQLite 파일을 별도 스키마로 붙입니다.

| 스키마 | 파일 | 테이블 | 용도 |
|---|---|---|---|
| `main` | catalog.db | articles, customers, transactions, products | H&M 원본 + 판매가·재고 |
| `admin` | admin.db | admin_users, analysis_runs, audit_log | 관리자 계정·분석 이력·감사 로그 |
| `member` | member.db | users, cart_items, orders, order_items | 이용자 계정·장바구니·주문 |

관리자 로그인은 `admin.admin_users`, 이용자 로그인은 `member.users` 만 조회하므로 계정 체계가 섞이지 않습니다.
로그인 후 세션의 role 로 화면이 나뉘며, 관리자는 쇼핑 화면 대신 `/admin` 으로, 이용자는 `/admin` 접근 시 403 이 됩니다.

## PyTorch 판매 추이 분석 (`analysis/sales_trend.py`)

- 집계: 거래를 torch 텐서로 올려 `index_add_`/`bincount` 로 일·주·월·요일·채널·카테고리·상품별 매출 계산
- 예측: `DemandModel` = 선형 성분(추세, 요일 원-핫, 연간 푸리에 계절성, 블랙프라이데이·12월·시즌세일 플래그)
  + 계절성만 보는 작은 MLP. log 매출을 Huber 손실·AdamW 로 학습하고, 마지막 28일 홀드아웃으로 MAPE/MAE 를 검증한 뒤
  전체 데이터로 재학습해 다음 28일과 90% 구간을 예측합니다. 요일 계수는 대시보드에 "요일 효과"로 표시됩니다.
- **시간대(0~23시)**: H&M `transactions_train` 에는 날짜(`t_dat`)만 있고 시각이 없습니다. 그래서 시간대별 추이와
  요일×시간 히트맵은 시각이 기록되는 이 플랫폼의 주문(`member.orders.created_at`)으로 계산합니다.
  `npm run seed` 는 최근 60일 데모 주문(`source='seed'`)을 넣어 개발 중에도 차트가 보이게 하며, 실제 주문이 쌓이면 함께 반영됩니다.
- 결과는 `data/analysis/sales_trends.json` 에 저장되고, 관리자 화면의 "PyTorch 분석 다시 실행" 버튼으로도 실행됩니다
  (실행 이력은 `admin.analysis_runs`). Python 경로는 `PYTHON` 환경변수로 바꿀 수 있습니다.

## 테스트

```bash
npm test          # Node 테스트 (node:test 내장 러너, 추가 설치 없음) — test/*.test.js
npm run test:py   # PyTorch 분석 스크립트 테스트 (unittest) — analysis/tests/  ※ torch 미설치 시 건너뜀
npm run test:all  # 둘 다
```

테스트는 파일마다 임시 폴더에 catalog/admin/member DB 를 새로 만들어 쓰므로 `data/db/*.db` 와 분석 결과를 건드리지 않습니다.
관리자 분석 실행 테스트는 PyTorch 대신 `test/fixtures/fake_analysis.js` 를 실행해 실행 이력·로그·중복 실행 방지를 검증합니다.

| 파일 | 내용 |
|---|---|
| `test/auth.test.js` | 이용자/관리자 로그인 분리(admin·member 스키마), returnTo, 회원가입 검증, 로그아웃, CSRF |
| `test/roles.test.js` | 비로그인·이용자·관리자별 접근 가능/차단 화면 (302 / 403) |
| `test/shop.test.js` | 홈·목록·검색·필터·정렬·상세·SVG, product 모델 |
| `test/orders.test.js` | 장바구니, 배송비, 결제 검증, 재고 차감·롤백, 주문 소유권, 취소·재고 복구 |
| `test/admin.test.js` | 대시보드·분석 API, 분석 실행기, 상품/재고 수정, 주문 상태 변경, 작업 기록 |
| `test/empty-catalog.test.js` | 데이터 미적재 시 503 안내 |
| `analysis/tests/test_sales_trend.py` | 일/주/월/요일 집계, 카테고리 성장률, 베스트셀러, 예측 모델, 시간대(0~23시)·히트맵, CLI |

## 환경 변수

`PORT`(3000), `SESSION_SECRET`(운영 시 반드시 변경), `PYTHON`(python3), `CATALOG_DB`, `ADMIN_DB`, `MEMBER_DB`
