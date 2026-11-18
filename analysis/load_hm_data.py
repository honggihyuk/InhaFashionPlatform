"""
H&M CSV(원본 Kaggle 파일 또는 샘플) -> catalog.db 적재 스크립트.

    python analysis/load_hm_data.py                       # data/raw 의 CSV 전체 적재
    python analysis/load_hm_data.py --since 2020-06-01    # 원본(3,100만 행)일 때 기간 제한 권장
    python analysis/load_hm_data.py --max-articles 3000   # 최근 판매량 상위 상품만 판매 목록에 등록

원본 Kaggle 파일을 쓰려면 articles.csv, customers.csv, transactions_train.csv 를
data/raw/ 에 넣고 실행하세요. 상품 이미지(images/0xx/0xxxxxxxxx.jpg)가 있으면
public/images/articles/ 아래에 같은 구조로 복사하면 자동으로 사용됩니다.
"""
import argparse
import hashlib
import os
import sqlite3
import sys

import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KRW_PER_UNIT = 1_000_000  # 정규화 가격(예: 0.0339) -> 원화(33,900원) 환산 계수


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=os.path.join(ROOT, "data", "raw"))
    ap.add_argument("--db", default=os.path.join(ROOT, "data", "db", "catalog.db"))
    ap.add_argument("--since", default=None, help="이 날짜(YYYY-MM-DD) 이후 거래만 적재")
    ap.add_argument("--max-articles", type=int, default=0, help="판매 목록에 올릴 상품 수 (0=전체)")
    ap.add_argument("--chunksize", type=int, default=1_000_000)
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.db), exist_ok=True)
    con = sqlite3.connect(args.db)
    con.executescript("PRAGMA journal_mode=WAL; DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS transactions;"
                      "DROP TABLE IF EXISTS customers; DROP TABLE IF EXISTS articles; DROP TABLE IF EXISTS promotions;")
    with open(os.path.join(ROOT, "db", "schema", "catalog.sql"), encoding="utf-8") as f:
        con.executescript(f.read())

    # 1) articles
    arts = pd.read_csv(os.path.join(args.raw, "articles.csv"), dtype={"article_id": str, "product_code": str,
                                                                     "colour_group_code": str})
    arts["article_id"] = arts["article_id"].str.zfill(10)
    arts["product_code"] = arts["product_code"].str.zfill(7)
    arts["colour_group_code"] = arts["colour_group_code"].str.zfill(2)
    arts.to_sql("articles", con, if_exists="append", index=False)
    print(f"articles: {len(arts):,}")

    # 2) customers
    cust = pd.read_csv(os.path.join(args.raw, "customers.csv"))
    cust["age"] = pd.to_numeric(cust["age"], errors="coerce").astype("Int64")
    cust.to_sql("customers", con, if_exists="append", index=False)
    print(f"customers: {len(cust):,}")

    # 3) transactions (청크 단위 적재)
    total = 0
    for chunk in pd.read_csv(os.path.join(args.raw, "transactions_train.csv"),
                             dtype={"article_id": str, "customer_id": str}, chunksize=args.chunksize):
        if args.since:
            chunk = chunk[chunk["t_dat"] >= args.since]
        chunk["article_id"] = chunk["article_id"].str.zfill(10)
        chunk.to_sql("transactions", con, if_exists="append", index=False)
        total += len(chunk)
        print(f"  transactions ... {total:,}", end="\r", file=sys.stderr)
    print(f"transactions: {total:,}")

    # 4) products: 거래 가격 중앙값으로 판매가 산정, 최근 8주 판매량 = 인기도
    stats = pd.read_sql_query(
        """
        WITH last AS (SELECT MAX(t_dat) AS d FROM transactions)
        SELECT a.article_id,
               (SELECT AVG(price) FROM transactions t WHERE t.article_id = a.article_id) AS avg_price,
               (SELECT COUNT(*) FROM transactions t, last
                 WHERE t.article_id = a.article_id AND t.t_dat >= date(last.d, '-56 day')) AS recent
        FROM articles a
        """, con)
    stats = stats.dropna(subset=["avg_price"])
    stats = stats.sort_values("recent", ascending=False)
    if args.max_articles:
        stats = stats.head(args.max_articles)

    def stock_for(aid):  # 결정적(재현 가능한) 초기 재고
        h = int(hashlib.md5(aid.encode()).hexdigest(), 16)
        return 0 if h % 23 == 0 else 5 + h % 116

    rows = [(r.article_id, int(round(r.avg_price * KRW_PER_UNIT / 100.0) * 100) or 1000,
             stock_for(r.article_id), 1, int(r.recent)) for r in stats.itertuples()]
    con.executemany("INSERT INTO products(article_id, price_krw, stock, is_active, popularity) VALUES (?,?,?,?,?)", rows)
    con.commit()
    con.execute("ANALYZE")
    con.close()
    print(f"products: {len(rows):,} -> {args.db}")


if __name__ == "__main__":
    main()
