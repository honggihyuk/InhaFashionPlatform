"""
analysis/sales_trend.py 테스트 (Python 표준 unittest)

    python -m unittest discover -s analysis/tests -t .      # 또는  npm run test:py

임시 폴더에 작은 SQLite catalog.db / member.db 를 만들어 값을 손으로 계산할 수 있는 데이터로 검증합니다.
(운영 DDL 은 MySQL 이므로, 같은 테이블 구조의 SQLite DDL 을 tests/fixtures 에 둡니다.)
MySQL 이 떠 있으면(docker compose up -d) --mysql 모드도 임시 스키마로 끝까지 검증합니다.
torch 가 설치되어 있지 않으면 전체를 건너뜁니다 (pip install -r analysis/requirements.txt).
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SCRIPT = os.path.join(ROOT, "analysis", "sales_trend.py")
sys.path.insert(0, os.path.join(ROOT, "analysis"))

try:
    import torch  # noqa: F401
    import sales_trend as st
except ImportError as e:  # torch/numpy 미설치
    st = None
    SKIP_REASON = f"PyTorch 분석 의존성이 없습니다: {e}"

KRW = 1_000_000  # sales_trend.KRW_PER_UNIT 과 동일
UTF8_ENV = {**os.environ, "PYTHONIOENCODING": "utf-8"}  # Windows(cp949) 콘솔에서도 한글 로그를 안전하게 읽기 위해


def read_schema(name):
    """SQLite 테스트용 DDL (catalog.sql → fixtures/catalog_sqlite.sql)"""
    with open(os.path.join(HERE, "fixtures", name.replace(".sql", "_sqlite.sql")), encoding="utf-8") as f:
        return f.read()


def wrap(con):
    """sales_trend 가 쓰는 DB 래퍼 (날짜·DECIMAL 정규화, 오류는 DbError)"""
    return st.Conn(con, "sqlite")


def make_catalog(path, start=date(2020, 1, 1), days=120):
    """매일 거래 3건: 상의(온라인) 2건 + 신발(매장) 1건. 일매출 = (0.01*2 + 0.05) * 1,000,000 = 70,000원
    단, 마지막 28일은 상의 판매가 하루 1건 더 늘어남(카테고리 성장률 검증용)."""
    con = sqlite3.connect(path)
    con.executescript(read_schema("catalog.sql"))
    con.executemany(
        "INSERT INTO articles (article_id, product_code, prod_name, product_group_name, index_group_name) VALUES (?, ?, ?, ?, ?)",
        [("0100000001", "0100000", "Top", "Garment Upper body", "Ladieswear"),
         ("0200000001", "0200000", "Shoe", "Shoes", "Menswear")])
    rows = []
    for i in range(days):
        d = (start + timedelta(days=i)).isoformat()
        rows += [(d, f"c{i}", "0100000001", 0.01, 2), (d, f"c{i}", "0100000001", 0.01, 2), (d, f"d{i}", "0200000001", 0.05, 1)]
        if i >= days - 28:
            rows.append((d, f"e{i}", "0100000001", 0.01, 2))
    con.executemany("INSERT INTO transactions VALUES (?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return rows


def make_member(path, orders):
    """orders: [(created_at 'YYYY-MM-DD HH:MM:SS', total_krw, status, source)]"""
    con = sqlite3.connect(path)
    # member.sql 은 'member.' 접두사를 쓰므로 ATTACH 해서 실행
    con.execute("ATTACH DATABASE ? AS member", (path,))
    con.executescript(read_schema("member.sql"))
    con.execute("INSERT INTO member.users (email, password_hash, name) VALUES ('u@test', 'x', 'u')")
    for i, (ts, total, status, source) in enumerate(orders):
        con.execute("""INSERT INTO member.orders (order_no, user_id, status, total_krw, recipient, phone, address, payment_method, source, created_at)
                       VALUES (?, 1, ?, ?, 'r', 'p', 'a', 'card', ?, ?)""", (f"T{i}", status, total, source, ts))
    con.commit()
    con.close()


@unittest.skipIf(st is None, globals().get("SKIP_REASON", ""))
class SalesTrendTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="inha-analysis-")
        self.catalog = os.path.join(self.tmp, "catalog.db")
        self.member = os.path.join(self.tmp, "member.db")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def load(self, **kw):
        self.rows = make_catalog(self.catalog, **kw)
        con = sqlite3.connect(self.catalog)
        try:
            return st.load_transactions(wrap(con))
        finally:
            con.close()


class TestLoadAndAggregate(SalesTrendTestBase):
    def test_load_transactions_period_and_tensors(self):
        tx = self.load(days=120)
        self.assertEqual(tx["start"], date(2020, 1, 1))
        self.assertEqual(tx["n_days"], 120)
        self.assertEqual(len(tx["price"]), len(self.rows))
        self.assertAlmostEqual(tx["price"][0].item(), 0.01 * KRW)  # 원화 환산
        self.assertEqual(tx["groups"], ["Garment Upper body", "Shoes"])
        self.assertEqual(tx["customers"], len({r[1] for r in self.rows}))

    def test_empty_transactions_exits_with_message(self):
        con = sqlite3.connect(self.catalog)
        con.executescript(read_schema("catalog.sql"))
        with self.assertRaises(SystemExit) as cm:
            st.load_transactions(wrap(con))
        con.close()
        self.assertIn("transactions", str(cm.exception))

    def test_daily_aggregate_revenue_units_online(self):
        tx = self.load(days=60)
        revenue, units, online = st.daily_aggregate(tx)
        self.assertEqual(len(revenue), 60)
        self.assertAlmostEqual(revenue[0].item(), 70_000)
        self.assertAlmostEqual(online[0].item(), 20_000)  # 채널 2(온라인)만
        self.assertEqual(units[0].item(), 3)
        self.assertAlmostEqual(revenue[-1].item(), 80_000)  # 마지막 28일은 상의 1건 추가
        self.assertAlmostEqual(revenue.sum().item(), sum(r[3] for r in self.rows) * KRW)

    def test_days_without_sales_are_zero(self):
        con = sqlite3.connect(self.catalog)
        con.executescript(read_schema("catalog.sql"))
        con.executemany("INSERT INTO transactions VALUES (?, 'c', 'a', ?, 1)", [("2020-01-01", 0.01), ("2020-01-04", 0.02)])
        con.commit()
        tx = st.load_transactions(wrap(con))
        con.close()
        revenue, _, _ = st.daily_aggregate(tx)
        self.assertEqual([round(v) for v in revenue.tolist()], [10_000, 0, 0, 20_000])


class TestTrends(SalesTrendTestBase):
    def setUp(self):
        super().setUp()
        self.tx = self.load(days=120)
        self.revenue, self.units, self.online = st.daily_aggregate(self.tx)
        self.t = st.trends(self.tx, self.revenue, self.units, self.online)

    def test_weekly_and_monthly_totals_match_daily(self):
        total = round(self.revenue.sum().item())
        self.assertEqual(sum(self.t["weekly"]["revenue"]), total)
        self.assertEqual(sum(self.t["monthly"]["revenue"]), total)
        self.assertEqual(self.t["monthly"]["months"], ["2020-01", "2020-02", "2020-03", "2020-04"])
        # 주 시작은 월요일
        for w in self.t["weekly"]["weeks"]:
            self.assertEqual(date.fromisoformat(w).weekday(), 0)

    def test_online_share(self):
        jan = self.t["monthly"]["online_share"][0]
        self.assertAlmostEqual(jan, round(20_000 / 70_000 * 100, 1))

    def test_weekday_average(self):
        self.assertEqual(self.t["weekday"]["labels"], ["월", "화", "수", "목", "금", "토", "일"])
        self.assertEqual(len(self.t["weekday"]["avg_revenue"]), 7)
        for v in self.t["weekday"]["avg_units"]:
            self.assertGreaterEqual(v, 3)
            self.assertLessEqual(v, 4)

    def test_category_growth_recent_vs_previous_4_weeks(self):
        g = {x["name"]: x for x in self.t["category_growth"]}
        # 상의: 직전 28일 하루 20,000 → 최근 28일 하루 30,000 = +50%
        self.assertEqual(g["Garment Upper body"]["previous"], 28 * 20_000)
        self.assertEqual(g["Garment Upper body"]["recent"], 28 * 30_000)
        self.assertEqual(g["Garment Upper body"]["change"], 50.0)
        self.assertEqual(g["Shoes"]["change"], 0.0)

    def test_best_sellers_last_4_weeks(self):
        best = self.t["best_sellers"]
        self.assertEqual(best[0]["article_id"], "0100000001")
        self.assertEqual(best[0]["units"], 28 * 3)
        self.assertEqual(best[1]["units"], 28)
        self.assertIsInstance(best[0]["article_id"], str)  # 앞자리 0 유지

    def test_category_series_cover_all_revenue(self):
        per_month = [sum(s["values"][m] for s in self.t["categories"]["series"]) for m in range(4)]
        self.assertEqual(per_month, self.t["monthly"]["revenue"])

    def test_daily_is_last_365_days(self):
        self.assertEqual(len(self.t["daily"]["dates"]), 120)
        self.assertEqual(self.t["daily"]["dates"][-1], (date(2020, 1, 1) + timedelta(days=119)).isoformat())


class TestForecast(SalesTrendTestBase):
    def test_features_shape_and_event_flags(self):
        days = [date(2019, 11, 25), date(2019, 12, 5), date(2020, 1, 3), date(2020, 3, 15)]
        x = st.features(list(range(4)), days, 10)
        self.assertEqual(tuple(x.shape), (4, 1 + 7 + 8 + 3))
        self.assertEqual(x[0, 1:8].tolist(), [1, 0, 0, 0, 0, 0, 0])  # 2019-11-25 는 월요일
        self.assertEqual(x[:, -3:].tolist(), [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0]])  # 블프 / 12월 / 시즌세일 / 없음

    def test_model_output_shape(self):
        model = st.DemandModel(19)
        self.assertEqual(tuple(model(torch.zeros(5, 19)).shape), (5,))

    def test_forecast_structure_and_sanity(self):
        tx = self.load(days=200)
        revenue, _, _ = st.daily_aggregate(tx)
        f = st.forecast(tx, revenue, epochs=150)
        self.assertEqual(len(f["dates"]), 28)
        self.assertEqual(f["dates"][0], (tx["end"] + timedelta(days=1)).isoformat())
        self.assertEqual(len(f["predicted"]), 28)
        for lo, p, hi in zip(f["lower"], f["predicted"], f["upper"]):
            self.assertLessEqual(lo, p)
            self.assertLessEqual(p, hi)
            self.assertGreater(p, 0)
        self.assertEqual(f["last_4w_total"], 28 * 80_000)
        self.assertEqual(f["holdout"]["days"], 28)
        self.assertEqual(len(f["holdout"]["actual"]), 28)
        self.assertEqual(len(f["weekday_effect_pct"]), 7)
        self.assertEqual(f["train_days"], 200)
        # 거의 일정한 매출이므로 예측도 같은 규모여야 함 (폭주하지 않음)
        self.assertLess(abs(f["next_4w_total"] / f["last_4w_total"] - 1), 0.5)
        self.assertLess(f["holdout"]["mape_pct"], 50)

    def test_forecast_is_deterministic_with_seed(self):
        tx = self.load(days=100)
        revenue, _, _ = st.daily_aggregate(tx)
        torch.manual_seed(7)
        a = st.forecast(tx, revenue, epochs=50)
        torch.manual_seed(7)
        b = st.forecast(tx, revenue, epochs=50)
        self.assertEqual(a["predicted"], b["predicted"])


class TestHourly(SalesTrendTestBase):
    """0~23시 시간대 분석: H&M 데이터에는 시각이 없으므로 플랫폼 주문(member.orders.created_at)으로 계산"""

    def test_missing_member_db_returns_none(self):
        self.assertIsNone(st.hourly(st.connect_sqlite(os.path.join(self.tmp, "nope.db"))))

    def test_member_db_without_orders_table_returns_none(self):
        sqlite3.connect(self.member).close()
        self.assertIsNone(st.hourly(st.connect_sqlite(self.member)))

    def test_no_orders(self):
        make_member(self.member, [])
        self.assertEqual(st.hourly(st.connect_sqlite(self.member)), {"orders": 0})

    def test_peak_hour_slots_and_heatmap(self):
        orders = [
            ("2020-09-14 21:05:00", 30000, "PAID", "web"),       # 월 21시
            ("2020-09-14 21:40:00", 20000, "DELIVERED", "seed"),  # 월 21시
            ("2020-09-15 21:10:00", 10000, "SHIPPING", "web"),    # 화 21시
            ("2020-09-15 12:30:00", 50000, "PAID", "web"),        # 화 12시
            ("2020-09-16 03:00:00", 5000, "PAID", "seed"),        # 수 03시
            ("2020-09-16 12:00:00", 99999, "CANCELLED", "web"),   # 취소 → 제외
        ]
        make_member(self.member, orders)
        h = st.hourly(st.connect_sqlite(self.member))
        self.assertEqual(h["orders"], 5)
        self.assertEqual(h["seed_orders"], 2)
        self.assertEqual(h["days"], 3)
        self.assertEqual(h["peak_hour"], 21)
        self.assertEqual(h["from"], "2020-09-14 21:05:00")
        self.assertEqual(h["to"], "2020-09-16 03:00:00")
        # 하루 평균 = 시간대 합계 / 기간 일수
        self.assertEqual(h["avg_orders_per_hour"][21], round(3 / 3, 2))
        self.assertEqual(h["avg_revenue_per_hour"][12], round(50000 / 3))
        slots = {s["name"]: s for s in h["slots"]}
        self.assertEqual(slots["저녁 (18-23시)"]["orders"], 3)
        self.assertEqual(slots["저녁 (18-23시)"]["revenue"], 60000)
        self.assertEqual(slots["오후 (12-17시)"]["orders"], 1)
        self.assertEqual(slots["새벽 (0-5시)"]["orders"], 1)
        self.assertEqual(slots["오전 (6-11시)"]["orders"], 0)
        self.assertEqual(sum(s["orders"] for s in h["slots"]), 5)
        heat = h["heatmap"]["counts"]
        self.assertEqual((len(heat), len(heat[0])), (7, 24))
        self.assertEqual(heat[0][21], 2)  # 월요일 21시
        self.assertEqual(heat[1][21], 1)  # 화요일 21시
        self.assertEqual(heat[1][12], 1)
        self.assertEqual(heat[2][3], 1)   # 수요일 3시
        self.assertEqual(sum(map(sum, heat)), 5)

    def test_recent_7_days_share(self):
        base = datetime(2020, 9, 1, 0, 0)
        orders = [((base + timedelta(days=d, hours=10)).strftime("%Y-%m-%d %H:%M:%S"), 1000, "PAID", "web") for d in range(5)]
        orders += [((base + timedelta(days=d, hours=20)).strftime("%Y-%m-%d %H:%M:%S"), 1000, "PAID", "web") for d in range(20, 24)]
        make_member(self.member, orders)
        h = st.hourly(st.connect_sqlite(self.member))
        self.assertEqual(h["share_before"][10], 100.0)
        self.assertEqual(h["share_recent_7d"][20], 100.0)
        self.assertAlmostEqual(sum(h["share_recent_7d"]), 100.0, places=0)


def add_products(path, rows):
    """rows: [(article_id, stock, price_krw, is_active)] — articles 가 없으면 함께 만듦"""
    con = sqlite3.connect(path)
    for aid, stock, price, active in rows:
        con.execute("INSERT OR IGNORE INTO articles (article_id, product_code, prod_name, product_group_name) VALUES (?, ?, ?, 'Garment Upper body')",
                    (aid, aid[:7], f"P{aid}"))
        con.execute("INSERT INTO products (article_id, price_krw, stock, is_active) VALUES (?, ?, ?, ?)", (aid, price, stock, active))
    con.commit()
    con.close()


class TestPromotionCandidates(SalesTrendTestBase):
    """행사(할인) 추천: 재고 과다 + 판매 하락 상품"""

    def build(self, weekly):
        """weekly: {article_id: [최근 8주 주간 판매량(오래된 주 → 최근 주)]}, 마지막 날 = 2020-03-01"""
        con = sqlite3.connect(self.catalog)
        con.executescript(read_schema("catalog.sql"))
        end = date(2020, 3, 1)
        rows = []
        for aid, units in weekly.items():
            con.execute("INSERT INTO articles (article_id, product_code, prod_name, product_group_name) VALUES (?, ?, ?, 'Garment Upper body')",
                        (aid, aid[:7], f"P{aid}"))
            for w, n in enumerate(units):
                d = end - timedelta(days=7 * (len(units) - 1 - w))  # 각 주의 마지막 날
                rows += [(d.isoformat(), f"c{aid}{w}{k}", aid, 0.02, 2) for k in range(n)]
        # 기간을 맞추기 위한 다른 상품 거래 (8주 전 ~ 마지막 날)
        rows += [((end - timedelta(days=i)).isoformat(), "z", "0999999999", 0.01, 1) for i in range(0, 63)]
        con.executemany("INSERT INTO transactions VALUES (?, ?, ?, ?, ?)", rows)
        con.commit()
        tx = st.load_transactions(wrap(con))
        con.close()
        return tx

    def products(self):
        con = sqlite3.connect(self.catalog)
        try:
            return st.load_products(wrap(con))
        finally:
            con.close()

    def test_load_products_only_active_in_stock(self):
        make_catalog(self.catalog, days=10)
        add_products(self.catalog, [("0100000001", 50, 12900, 1), ("0200000001", 0, 59000, 1), ("0300000001", 10, 9900, 0)])
        self.assertEqual(self.products(), {"0100000001": (50, 12900, "Top", "Garment Upper body")})

    def test_load_products_without_products_table(self):
        con = sqlite3.connect(self.catalog)
        self.assertEqual(st.load_products(wrap(con)), {})
        con.close()

    def test_declining_overstock_ranked_first(self):
        tx = self.build({
            "0100000001": [10, 9, 8, 6, 4, 3, 1, 0],   # 하락 + 재고 많음 → 1순위
            "0200000001": [5, 5, 5, 5, 5, 5, 5, 5],    # 꾸준히 팔림, 재고 적당 → 제외
            "0300000001": [1, 2, 3, 5, 6, 8, 9, 10],   # 상승 중 → 제외
            "0400000001": [0, 0, 0, 0, 0, 0, 0, 0],    # 8주 판매 없음 + 재고 → 후보
        })
        add_products(self.catalog, [("0100000001", 120, 12900, 1), ("0200000001", 40, 12900, 1),
                                    ("0300000001", 30, 12900, 1), ("0400000001", 15, 19900, 1)])
        c = st.promotion_candidates(tx, self.products())
        ids = [x["article_id"] for x in c]
        self.assertEqual(ids[0], "0100000001")
        self.assertIn("0400000001", ids)
        self.assertNotIn("0200000001", ids)
        self.assertNotIn("0300000001", ids)
        top = c[0]
        self.assertEqual(top["weekly_units"], [10, 9, 8, 6, 4, 3, 1, 0])
        self.assertEqual(top["recent_4w_units"], 8)
        self.assertEqual(top["prev_4w_units"], 33)
        self.assertEqual(top["change_pct"], round((8 / 33 - 1) * 100, 1))
        self.assertEqual(top["weeks_of_cover"], round(120 / 2, 1))
        self.assertLess(top["trend_pct_per_week"], 0)
        self.assertIn("최근 4주 판매 -76%", top["reasons"])
        self.assertIn(top["suggested_discount_pct"], (10, 20, 30))
        dead = c[ids.index("0400000001")]
        self.assertIn("최근 8주 판매 없음", dead["reasons"])
        self.assertIsNone(dead["change_pct"])

    def test_score_and_discount_are_monotonic(self):
        tx = self.build({"0100000001": [4, 4, 4, 4, 3, 3, 2, 2], "0200000001": [4, 4, 4, 4, 3, 3, 2, 2]})
        add_products(self.catalog, [("0100000001", 40, 10000, 1), ("0200000001", 400, 10000, 1)])
        c = {x["article_id"]: x for x in st.promotion_candidates(tx, self.products())}
        self.assertGreater(c["0200000001"]["score"], c["0100000001"]["score"], "재고가 많을수록 점수가 높음")
        self.assertGreaterEqual(c["0200000001"]["suggested_discount_pct"], c["0100000001"]["suggested_discount_pct"])
        for x in c.values():
            self.assertGreaterEqual(x["score"], 0)
            self.assertLessEqual(x["score"], 1)

    def test_excludes_inactive_sold_out_and_unknown(self):
        tx = self.build({"0100000001": [5, 4, 3, 2, 1, 0, 0, 0]})
        add_products(self.catalog, [("0100000001", 0, 10000, 1)])  # 품절
        self.assertEqual(st.promotion_candidates(tx, self.products()), [])
        self.assertEqual(st.promotion_candidates(tx, {}), [])

    def test_top_n_and_ties_by_inventory_value(self):
        weekly = {f"0{i}00000001": [0] * 8 for i in range(1, 6)}
        tx = self.build(weekly)
        add_products(self.catalog, [(aid, 100, 1000 * (i + 1), 1) for i, aid in enumerate(sorted(weekly))])
        c = st.promotion_candidates(tx, self.products(), top_n=3)
        self.assertEqual(len(c), 3)
        self.assertEqual([x["article_id"] for x in c], ["0500000001", "0400000001", "0300000001"])


@unittest.skipIf(st is None, globals().get("SKIP_REASON", ""))
class TestCommandLine(unittest.TestCase):
    """관리자 화면의 '분석 다시 실행' 과 같은 방식으로 스크립트를 실행해 결과 JSON 검증"""

    def test_end_to_end_json(self):
        tmp = tempfile.mkdtemp(prefix="inha-analysis-cli-")
        try:
            catalog, member = os.path.join(tmp, "catalog.db"), os.path.join(tmp, "member.db")
            out = os.path.join(tmp, "nested", "sales_trends.json")
            make_catalog(catalog, days=90)
            add_products(catalog, [("0100000001", 5, 12900, 1), ("0200000001", 500, 59000, 1)])
            make_member(member, [("2020-03-30 20:00:00", 10000, "PAID", "web")])
            p = subprocess.run([sys.executable, SCRIPT, "--catalog", catalog, "--member", member, "--out", out, "--epochs", "40"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", env=UTF8_ENV, timeout=300)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(out, encoding="utf-8") as f:
                r = json.load(f)
            for key in ["generated_at", "torch_version", "daily", "weekly", "monthly", "weekday", "categories",
                        "category_growth", "best_sellers", "forecast", "hourly", "promotions", "summary"]:
                self.assertIn(key, r)
            s = r["summary"]
            self.assertEqual(s["transactions"], 90 * 3 + 28)
            self.assertEqual(s["period"], {"from": "2020-01-01", "to": "2020-03-30", "days": 90})
            self.assertEqual(s["articles_sold"], 2)
            self.assertEqual(s["last_28d_revenue"], 28 * 80_000)
            self.assertEqual(s["prev_28d_revenue"], 28 * 70_000)
            self.assertEqual(s["last_28d_change_pct"], round((80 / 70 - 1) * 100, 1))
            self.assertEqual(r["hourly"]["peak_hour"], 20)
            # 신발: 주 7개 판매인데 재고 500 → 71주분, 행사 후보 / 상의: 재고 5 → 후보 아님
            self.assertEqual([p["article_id"] for p in r["promotions"]], ["0200000001"])
            self.assertEqual(r["promotions"][0]["reasons"], ["재고 1년치 이상"])
            self.assertFalse(os.path.exists(out + ".tmp"), "임시 파일은 남지 않아야 함")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_empty_catalog_fails_with_nonzero_exit(self):
        tmp = tempfile.mkdtemp(prefix="inha-analysis-cli-")
        try:
            catalog = os.path.join(tmp, "catalog.db")
            con = sqlite3.connect(catalog)
            con.executescript(read_schema("catalog.sql"))
            con.close()
            out = os.path.join(tmp, "out.json")
            p = subprocess.run([sys.executable, SCRIPT, "--catalog", catalog, "--member", os.path.join(tmp, "m.db"), "--out", out],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", env=UTF8_ENV, timeout=120)
            self.assertNotEqual(p.returncode, 0)
            self.assertFalse(os.path.exists(out))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def mysql_or_none():
    try:
        import pymysql
        return pymysql.connect(host=os.environ.get("MYSQL_HOST", "127.0.0.1"), port=int(os.environ.get("MYSQL_PORT", "3306")),
                               user=os.environ.get("MYSQL_USER", "inha"), password=os.environ.get("MYSQL_PASSWORD", "inha-pass"),
                               charset="utf8mb4", connect_timeout=2, autocommit=True)
    except Exception:
        return None


@unittest.skipIf(st is None, globals().get("SKIP_REASON", ""))
class TestMySqlMode(unittest.TestCase):
    """운영과 같은 --mysql 모드: 임시 스키마(t_py_*)에 db/schema/*.sql(MySQL DDL)을 만들고 끝까지 실행"""

    def setUp(self):
        self.con = mysql_or_none()
        if self.con is None:
            self.skipTest("MySQL 에 연결할 수 없습니다 (docker compose up -d 후 다시 실행)")
        tag = f"{os.getpid()}"
        self.schemas = {"catalog": f"t_py{tag}_catalog", "admin": f"t_py{tag}_admin", "member": f"t_py{tag}_member"}
        for name in ("catalog", "member"):
            with open(os.path.join(ROOT, "db", "schema", f"{name}.sql"), encoding="utf-8") as f:
                ddl = f.read()
            for k, v in self.schemas.items():
                ddl = ddl.replace("{{" + k + "}}", v)
            with self.con.cursor() as cur:
                for stmt in [x.strip() for x in ddl.split(";")]:
                    if stmt and not all(line.strip().startswith("--") or not line.strip() for line in stmt.splitlines()):
                        cur.execute(stmt)

    def tearDown(self):
        if self.con is not None:
            with self.con.cursor() as cur:
                for v in self.schemas.values():
                    cur.execute(f"DROP DATABASE IF EXISTS `{v}`")
            self.con.close()

    def test_end_to_end_mysql(self):
        c, m = self.schemas["catalog"], self.schemas["member"]
        with self.con.cursor() as cur:
            cur.executemany(f"INSERT INTO `{c}`.articles (article_id, product_code, prod_name, product_group_name, index_group_name) VALUES (%s,%s,%s,%s,%s)",
                            [("0100000001", "0100000", "Top", "Garment Upper body", "Ladieswear"),
                             ("0200000001", "0200000", "Shoe", "Shoes", "Menswear")])
            rows = []
            for i in range(90):
                d = (date(2020, 1, 1) + timedelta(days=i)).isoformat()
                rows += [(d, f"c{i}", "0100000001", 0.01, 2), (d, f"d{i}", "0200000001", 0.05, 1)]
            cur.executemany(f"INSERT INTO `{c}`.transactions (t_dat, customer_id, article_id, price, sales_channel_id) VALUES (%s,%s,%s,%s,%s)", rows)
            cur.execute(f"INSERT INTO `{c}`.products (article_id, price_krw, stock, is_active) VALUES ('0200000001', 59000, 500, 1)")
            cur.execute(f"INSERT INTO `{m}`.users (email, password_hash, name) VALUES ('u@test', 'x', 'u')")
            cur.execute(f"""INSERT INTO `{m}`.orders (order_no, user_id, status, total_krw, recipient, phone, address, payment_method, source, created_at)
                            VALUES ('T1', LAST_INSERT_ID(), 'PAID', 10000, 'r', 'p', 'a', 'card', 'web', '2020-02-28 21:15:00')""")
        tmp = tempfile.mkdtemp(prefix="inha-analysis-mysql-")
        try:
            out = os.path.join(tmp, "out.json")
            p = subprocess.run([sys.executable, SCRIPT, "--mysql", "--catalog-schema", c, "--member-schema", m, "--out", out, "--epochs", "30"],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", env=UTF8_ENV, timeout=300)
            self.assertEqual(p.returncode, 0, p.stderr)
            with open(out, encoding="utf-8") as f:
                r = json.load(f)
            self.assertEqual(r["summary"]["transactions"], 180)
            self.assertEqual(r["summary"]["period"], {"from": "2020-01-01", "to": "2020-03-30", "days": 90})
            self.assertEqual(r["hourly"]["orders"], 1)
            self.assertEqual(r["hourly"]["peak_hour"], 21)
            self.assertEqual(r["hourly"]["from"], "2020-02-28 21:15:00")
            self.assertEqual([x["article_id"] for x in r["promotions"]], ["0200000001"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
