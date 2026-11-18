"""
H&M CSV(원본 Kaggle 파일 또는 샘플) -> MySQL catalog 스키마 적재 스크립트.

    python analysis/load_hm_data.py                       # data/raw 의 CSV 전체 적재
    python analysis/load_hm_data.py --since 2020-06-01    # 원본(3,100만 행)일 때 기간 제한 권장
    python analysis/load_hm_data.py --max-articles 3000   # 최근 판매량 상위 상품만 판매 목록에 등록

접속 정보: MYSQL_HOST / MYSQL_PORT / MYSQL_USER / MYSQL_PASSWORD 환경 변수 (기본값은 docker-compose.yml 과 동일)
스키마 이름: INHA_NS(기본 inha_) + catalog  → inha_catalog

원본 Kaggle 파일을 쓰려면 articles.csv, customers.csv, transactions_train.csv 를
data/raw/ 에 넣고 실행하세요. 상품 이미지(images/0xx/0xxxxxxxxx.jpg)가 있으면
public/images/articles/ 아래에 같은 구조로 복사하면 자동으로 사용됩니다.

대용량 거래는 LOAD DATA LOCAL INFILE 로 빠르게 적재하고, 서버가 local_infile 을 막아 두었으면
여러 행 INSERT(배치)로 자동 전환합니다.
적재 후 Elasticsearch 색인은 `npm run search:reindex` (또는 npm run setup) 로 다시 만듭니다.
"""
import argparse
import hashlib
import os
import sys
import tempfile

import pandas as pd
import pymysql

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KRW_PER_UNIT = 1_000_000  # 정규화 가격(예: 0.0339) -> 원화(33,900원) 환산 계수
NS = os.environ.get("INHA_NS", "inha_")


def connect():
    return pymysql.connect(
        host=os.environ.get("MYSQL_HOST", "127.0.0.1"), port=int(os.environ.get("MYSQL_PORT", "3306")),
        user=os.environ.get("MYSQL_USER", "inha"), password=os.environ.get("MYSQL_PASSWORD", "inha-pass"),
        charset="utf8mb4", autocommit=False, local_infile=True, init_command="SET time_zone = '+09:00'")


def run_schema(con, schema):
    """db/schema/catalog.sql (MySQL DDL) 실행. {{catalog}} 자리에 스키마 이름을 넣음"""
    with open(os.path.join(ROOT, "db", "schema", "catalog.sql"), encoding="utf-8") as f:
        ddl = f.read().replace("{{catalog}}", schema)
    with con.cursor() as cur:
        for stmt in ddl.split(";"):
            body = "\n".join(l for l in stmt.splitlines() if not l.strip().startswith("--")).strip()
            if body:
                cur.execute(body)


class Loader:
    def __init__(self, con, schema):
        self.con, self.schema = con, schema
        self.use_infile = True

    def load(self, table, df):
        if df.empty:
            return
        cols = list(df.columns)
        if self.use_infile:
            try:
                self._infile(table, df, cols)
                return
            except pymysql.err.MySQLError as e:  # local_infile 비활성 등
                self.con.rollback()
                print(f"  LOAD DATA 사용 불가 → INSERT 배치로 적재 ({e.args[-1] if e.args else e})", file=sys.stderr)
                self.use_infile = False
        self._insert(table, df, cols)

    def _infile(self, table, df, cols):
        out = df.copy()
        for c in out.columns:
            if out[c].dtype == object:
                out[c] = out[c].map(lambda v: v.replace("\\", "\\\\") if isinstance(v, str) else v)
        fd, path = tempfile.mkstemp(suffix=".csv")
        os.close(fd)
        try:
            out.to_csv(path, index=False, header=False, na_rep="\\N", lineterminator="\n", encoding="utf-8")
            with self.con.cursor() as cur:
                cur.execute(
                    f"LOAD DATA LOCAL INFILE %s INTO TABLE `{self.schema}`.`{table}` CHARACTER SET utf8mb4 "
                    "FIELDS TERMINATED BY ',' OPTIONALLY ENCLOSED BY '\"' ESCAPED BY '\\\\' LINES TERMINATED BY '\\n' "
                    f"({', '.join('`' + c + '`' for c in cols)})", (path.replace("\\", "/"),))
            self.con.commit()
        finally:
            os.remove(path)

    def _insert(self, table, df, cols, batch=5000):
        sql = (f"INSERT INTO `{self.schema}`.`{table}` ({', '.join('`' + c + '`' for c in cols)}) "
               f"VALUES ({', '.join(['%s'] * len(cols))})")
        values = df.astype(object).where(pd.notna(df), None).values.tolist()
        with self.con.cursor() as cur:
            for i in range(0, len(values), batch):
                cur.executemany(sql, values[i:i + batch])
        self.con.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", default=os.path.join(ROOT, "data", "raw"))
    ap.add_argument("--schema", default=NS + "catalog", help="적재할 MySQL 스키마 (기본 inha_catalog)")
    ap.add_argument("--since", default=None, help="이 날짜(YYYY-MM-DD) 이후 거래만 적재")
    ap.add_argument("--max-articles", type=int, default=0, help="판매 목록에 올릴 상품 수 (0=전체)")
    ap.add_argument("--chunksize", type=int, default=1_000_000)
    args = ap.parse_args()
    S = args.schema

    con = connect()
    with con.cursor() as cur:
        cur.execute(f"CREATE DATABASE IF NOT EXISTS `{S}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
        for t in ("promotions", "products", "transactions", "customers", "articles"):
            cur.execute(f"DROP TABLE IF EXISTS `{S}`.`{t}`")
    run_schema(con, S)
    con.commit()
    loader = Loader(con, S)

    # 1) articles
    arts = pd.read_csv(os.path.join(args.raw, "articles.csv"), dtype={"article_id": str, "product_code": str,
                                                                     "colour_group_code": str})
    arts["article_id"] = arts["article_id"].str.zfill(10)
    arts["product_code"] = arts["product_code"].str.zfill(7)
    arts["colour_group_code"] = arts["colour_group_code"].str.zfill(2)
    loader.load("articles", arts)
    print(f"articles: {len(arts):,}")

    # 2) customers
    cust = pd.read_csv(os.path.join(args.raw, "customers.csv"))
    cust["age"] = pd.to_numeric(cust["age"], errors="coerce").astype("Int64")
    loader.load("customers", cust)
    print(f"customers: {len(cust):,}")

    # 3) transactions (청크 단위 적재)
    total = 0
    for chunk in pd.read_csv(os.path.join(args.raw, "transactions_train.csv"),
                             dtype={"article_id": str, "customer_id": str}, chunksize=args.chunksize):
        if args.since:
            chunk = chunk[chunk["t_dat"] >= args.since]
        chunk = chunk.copy()
        chunk["article_id"] = chunk["article_id"].str.zfill(10)
        loader.load("transactions", chunk[["t_dat", "customer_id", "article_id", "price", "sales_channel_id"]])
        total += len(chunk)
        print(f"  transactions ... {total:,}", end="\r", file=sys.stderr)
    print(f"transactions: {total:,}")

    # 4) products: 거래 평균가로 판매가 산정, 최근 8주 판매량 = 인기도
    with con.cursor() as cur:
        cur.execute(f"""
            SELECT t.article_id, AVG(t.price) AS avg_price,
                   SUM(t.t_dat >= DATE_SUB(l.d, INTERVAL 56 DAY)) AS recent
            FROM `{S}`.transactions t
            JOIN `{S}`.articles a ON a.article_id = t.article_id
            CROSS JOIN (SELECT MAX(t_dat) AS d FROM `{S}`.transactions) l
            GROUP BY t.article_id
            ORDER BY recent DESC, t.article_id""")
        stats = cur.fetchall()
    if args.max_articles:
        stats = stats[:args.max_articles]

    def stock_for(aid):  # 결정적(재현 가능한) 초기 재고
        h = int(hashlib.md5(aid.encode()).hexdigest(), 16)
        return 0 if h % 23 == 0 else 5 + h % 116

    rows = [(aid, int(round(float(avg) * KRW_PER_UNIT / 100.0) * 100) or 1000, stock_for(aid), 1, int(recent or 0))
            for aid, avg, recent in stats]
    with con.cursor() as cur:
        for i in range(0, len(rows), 5000):
            cur.executemany(f"INSERT INTO `{S}`.products(article_id, price_krw, stock, is_active, popularity) VALUES (%s,%s,%s,%s,%s)",
                            rows[i:i + 5000])
        cur.execute(f"ANALYZE TABLE `{S}`.transactions, `{S}`.products, `{S}`.articles")
        cur.fetchall()
    con.commit()
    con.close()
    print(f"products: {len(rows):,} -> MySQL `{S}`")


if __name__ == "__main__":
    main()
