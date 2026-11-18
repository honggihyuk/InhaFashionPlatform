"""
H&M Personalized Fashion Recommendations 데이터셋과 동일한 스키마의 개발용 샘플 생성기.

Kaggle 원본(articles.csv, customers.csv, transactions_train.csv)을 내려받을 수 없는
환경에서 개발/테스트용으로 사용합니다. 컬럼 이름, 타입, 값의 형식(10자리 article_id,
64자리 hex customer_id, 정규화된 price, sales_channel_id 1/2, t_dat 2018-09-20 ~ 2020-09-22)
을 원본과 동일하게 맞춥니다.

사용법:
    python analysis/generate_sample_data.py --out data/raw --articles 600 --customers 4000 --daily 320
"""
import argparse
import csv
import hashlib
import math
import os
from datetime import date, timedelta

import numpy as np

# (product_type_no, product_type_name, product_group_name, garment_group_no, garment_group_name, base_price)
PRODUCT_TYPES = [
    (255, "T-shirt", "Garment Upper body", 1002, "Jersey Basic", 0.0135),
    (252, "Sweater", "Garment Upper body", 1003, "Knitwear", 0.0339),
    (259, "Top", "Garment Upper body", 1005, "Jersey Fancy", 0.0169),
    (253, "Vest top", "Garment Upper body", 1002, "Jersey Basic", 0.0101),
    (306, "Bra", "Underwear", 1017, "Under-, Nightwear", 0.0203),
    (245, "Shirt", "Garment Upper body", 1011, "Shirts", 0.0271),
    (254, "Blouse", "Garment Upper body", 1010, "Blouses", 0.0254),
    (272, "Trousers", "Garment Lower body", 1009, "Trousers", 0.0339),
    (274, "Shorts", "Garment Lower body", 1025, "Shorts", 0.0203),
    (275, "Skirt", "Garment Lower body", 1012, "Skirts", 0.0254),
    (265, "Dress", "Garment Full body", 1013, "Dresses Ladies", 0.0423),
    (264, "Jumpsuit/Playsuit", "Garment Full body", 1013, "Dresses Ladies", 0.0406),
    (264, "Jacket", "Garment Upper body", 1007, "Outdoor", 0.0592),
    (262, "Coat", "Garment Upper body", 1007, "Outdoor", 0.0847),
    (273, "Leggings/Tights", "Garment Lower body", 1009, "Trousers", 0.0169),
    (308, "Hoodie", "Garment Upper body", 1005, "Jersey Fancy", 0.0305),
    (283, "Swimsuit", "Swimwear", 1018, "Swimwear", 0.0254),
    (286, "Underwear bottom", "Underwear", 1017, "Under-, Nightwear", 0.0085),
    (302, "Socks", "Socks & Tights", 1021, "Socks and Tights", 0.0068),
    (87, "Sneakers", "Shoes", 1020, "Shoes", 0.0508),
    (66, "Bag", "Accessories", 1019, "Accessories", 0.0254),
    (67, "Hat/beanie", "Accessories", 1019, "Accessories", 0.0118),
]
# 계절성: 해당 품목이 잘 팔리는 달 (1~12). None 이면 연중 고르게
SEASON = {
    "Shorts": [5, 6, 7, 8], "Swimsuit": [5, 6, 7], "Dress": [4, 5, 6, 7, 8],
    "Vest top": [5, 6, 7, 8], "Sweater": [10, 11, 12, 1, 2], "Coat": [10, 11, 12, 1],
    "Jacket": [9, 10, 11, 3], "Hoodie": [9, 10, 11, 12, 1, 2], "Hat/beanie": [11, 12, 1, 2],
}
INDEX = [  # index_code, index_name, index_group_no, index_group_name, weight, section
    ("A", "Ladieswear", 1, "Ladieswear", 0.36, (16, "Womens Everyday Collection")),
    ("D", "Divided", 2, "Divided", 0.16, (53, "Divided Collection")),
    ("F", "Menswear", 3, "Menswear", 0.18, (21, "Contemporary Casual")),
    ("I", "Children Sizes 134-170", 4, "Baby/Children", 0.12, (77, "Young Girl")),
    ("S", "Sport", 26, "Sport", 0.08, (5, "Ladies H&M Sport")),
    ("B", "Lingeries/Tights", 1, "Ladieswear", 0.10, (61, "Womens Lingerie")),
]
COLOURS = [  # code, name, perceived value(id,name), master(id,name), weight
    (9, "Black", (4, "Dark"), (5, "Black"), 0.24),
    (10, "White", (3, "Light"), (9, "White"), 0.11),
    (73, "Dark Blue", (4, "Dark"), (2, "Blue"), 0.10),
    (72, "Blue", (2, "Medium Dusty"), (2, "Blue"), 0.05),
    (71, "Light Blue", (3, "Light"), (2, "Blue"), 0.04),
    (7, "Grey", (2, "Medium Dusty"), (12, "Grey"), 0.06),
    (8, "Dark Grey", (4, "Dark"), (12, "Grey"), 0.04),
    (13, "Beige", (2, "Medium Dusty"), (11, "Beige"), 0.07),
    (11, "Off White", (3, "Light"), (9, "White"), 0.05),
    (42, "Red", (1, "Bright"), (18, "Red"), 0.04),
    (52, "Pink", (2, "Medium Dusty"), (4, "Pink"), 0.05),
    (51, "Light Pink", (3, "Light"), (4, "Pink"), 0.04),
    (93, "Dark Green", (4, "Dark"), (19, "Green"), 0.03),
    (19, "Greenish Khaki", (2, "Medium Dusty"), (20, "Khaki green"), 0.03),
    (62, "Yellowish Brown", (2, "Medium Dusty"), (3, "Brown"), 0.03),
    (53, "Dark Pink", (4, "Dark"), (4, "Pink"), 0.02),
]
GRAPHICS = [(1010016, "Solid", 0.62), (1010017, "Stripe", 0.08), (1010001, "All over pattern", 0.14),
            (1010005, "Melange", 0.06), (1010010, "Denim", 0.06), (1010021, "Lace", 0.04)]
ADJ = ["Basic", "Relaxed", "Slim", "Oversized", "Cropped", "Linen", "Cotton", "Ribbed", "Soft",
       "Classic", "Wide", "Fitted", "Light", "Knit", "Padded", "Studio", "Weekend", "City", "Pima", "Wool-blend"]
NOUN = ["Ava", "Bella", "Luna", "Nora", "Theo", "Milo", "Ella", "Ivy", "Otto", "Mia", "Hugo", "Lea",
        "Sam", "Vera", "Juno", "Lily", "Max", "Elsa", "Noah", "Iris"]
DESC = {
    "Garment Upper body": "Top in soft {mat} with {detail}. Regular fit.",
    "Garment Lower body": "{fit} {name} in {mat} with an elasticated waist and {detail}.",
    "Garment Full body": "Calf-length {name} in {mat} with {detail}.",
    "Underwear": "{name} in {mat} with {detail}.",
    "Swimwear": "Fully lined {name} with {detail}.",
    "Socks & Tights": "Fine-knit {name} in a {mat} blend.",
    "Shoes": "{name} with padded uppers and {detail}. Rubber soles.",
    "Accessories": "{name} in {mat} with {detail}.",
}
MATS = ["cotton jersey", "organic cotton", "linen-blend weave", "rib-knit fabric", "recycled polyester",
        "viscose", "wool-blend knit", "stretch denim", "soft modal"]
DETAILS = ["a round neckline", "dropped shoulders", "side pockets", "a V-neck", "short sleeves",
           "long sleeves", "a drawstring", "button fastening", "a concealed zip", "lace trims"]


def weighted(rng, items, weights):
    w = np.array(weights, dtype=float)
    return items[rng.choice(len(items), p=w / w.sum())]


def make_articles(rng, n):
    rows = []
    product_code = 108775
    while len(rows) < n:
        product_code += int(rng.integers(150, 3000))
        pt = PRODUCT_TYPES[rng.integers(len(PRODUCT_TYPES))]
        idx = weighted(rng, INDEX, [i[4] for i in INDEX])
        if pt[2] == "Underwear" and idx[0] not in ("B", "F"):
            idx = INDEX[5]
        name = f"{rng.choice(ADJ)} {rng.choice(NOUN)} {pt[1].split('/')[0].lower()}"
        dept_no = 1000 + idx[2] * 100 + pt[0] % 97
        n_colours = int(rng.choice([1, 1, 2, 2, 3, 4]))
        colour_ids = rng.choice(len(COLOURS), size=n_colours, replace=False,
                                p=np.array([c[4] for c in COLOURS]) / sum(c[4] for c in COLOURS))
        graphic = weighted(rng, GRAPHICS, [g[2] for g in GRAPHICS])
        for k, ci in enumerate(colour_ids):
            if len(rows) >= n:
                break
            c = COLOURS[ci]
            article_id = int(f"{product_code:07d}{k + 1:03d}")
            tpl = DESC.get(pt[2], "{name} in {mat}.")
            desc = tpl.format(mat=rng.choice(MATS), detail=rng.choice(DETAILS),
                              name=pt[1].lower(), fit=rng.choice(["Relaxed-fit", "Slim-fit", "Wide-leg"]))
            rows.append({
                "article_id": f"{article_id:010d}", "product_code": f"{product_code:07d}", "prod_name": name.title(),
                "product_type_no": pt[0], "product_type_name": pt[1], "product_group_name": pt[2],
                "graphical_appearance_no": graphic[0], "graphical_appearance_name": graphic[1],
                "colour_group_code": f"{c[0]:02d}", "colour_group_name": c[1],
                "perceived_colour_value_id": c[2][0], "perceived_colour_value_name": c[2][1],
                "perceived_colour_master_id": c[3][0], "perceived_colour_master_name": c[3][1],
                "department_no": dept_no, "department_name": f"{idx[1]} {pt[4]}",
                "index_code": idx[0], "index_name": idx[1], "index_group_no": idx[2], "index_group_name": idx[3],
                "section_no": idx[5][0], "section_name": idx[5][1],
                "garment_group_no": pt[3], "garment_group_name": pt[4], "detail_desc": desc[0].upper() + desc[1:],
                "_base_price": pt[5] * float(rng.uniform(0.7, 1.6)),
                "_pop": float(min(rng.pareto(1.3) + 0.2, 4.0)), "_season": SEASON.get(pt[1]),
                "_launch": int(rng.integers(0, 640)),
            })
    return rows


def make_customers(rng, n):
    rows = []
    for i in range(n):
        cid = hashlib.sha256(f"inha-sample-customer-{i}".encode()).hexdigest()
        age = int(np.clip(rng.normal(36, 13) if rng.random() > 0.35 else rng.normal(24, 3), 16, 90))
        club = weighted(rng, ["ACTIVE", "PRE-CREATE", "LEFT CLUB", ""], [0.92, 0.06, 0.005, 0.015])
        news = weighted(rng, ["NONE", "Regularly", "Monthly", ""], [0.63, 0.35, 0.005, 0.015])
        fn = "1.0" if news == "Regularly" else ""
        rows.append({
            "customer_id": cid, "FN": fn, "Active": fn, "club_member_status": club,
            "fashion_news_frequency": news, "age": age if rng.random() > 0.01 else "",
            "postal_code": hashlib.sha256(f"postal-{int(rng.integers(0, 900))}".encode()).hexdigest(),
            "_w": float(rng.pareto(1.6) + 0.1),
        })
    return rows


def make_transactions(rng, articles, customers, daily, start, end):
    cust_w = np.array([c["_w"] for c in customers]); cust_w /= cust_w.sum()
    pop = np.array([a["_pop"] for a in articles])
    launch = np.array([a["_launch"] for a in articles])
    base_price = np.array([a["_base_price"] for a in articles])
    season_mask = {m: np.array([1.0 if (a["_season"] is None or m in a["_season"]) else 0.25 for a in articles])
                   for m in range(1, 13)}
    out = []
    n_days = (end - start).days + 1
    for d in range(n_days):
        day = start + timedelta(days=d)
        doy = day.timetuple().tm_yday
        # 장기 추세 + 연간 계절성(여름·연말 피크) + 요일 패턴 + 이벤트
        level = daily * (1 + 0.18 * d / n_days)
        level *= 1 + 0.22 * math.sin(2 * math.pi * (doy - 80) / 365.25) + 0.10 * math.cos(4 * math.pi * doy / 365.25)
        level *= [0.98, 0.95, 0.97, 1.0, 1.08, 1.22, 1.05][day.weekday()]
        if day.month == 11 and 22 <= day.day <= 30:  # Black Friday 주간
            level *= 1.7
        if day.month == 12 and day.day <= 22:
            level *= 1.25
        if day.month in (1, 7) and day.day <= 10:  # 시즌 세일
            level *= 1.35
        covid = date(2020, 3, 15) <= day <= date(2020, 5, 10)
        if covid:
            level *= 0.72
        n = int(rng.poisson(max(level, 1)))
        if n == 0:
            continue
        alive = (launch <= d) & (launch + 420 >= d)
        w = pop * alive * season_mask[day.month]
        # 출시 직후 4주 신상품 부스트
        w = w * np.where((d - launch >= 0) & (d - launch < 28), 2.2, 1.0)
        w = w / w.sum()
        art_idx = rng.choice(len(articles), size=n, p=w)
        cust_idx = rng.choice(len(customers), size=n, p=cust_w)
        online_p = 0.70 if covid else (0.62 + 0.08 * d / n_days)
        sale = 0.6 if (day.month in (1, 7) and day.day <= 20) else 1.0
        for ai, ci in zip(art_idx, cust_idx):
            price = base_price[ai] * sale * float(rng.choice([1.0, 1.0, 1.0, 0.8, 0.6]))
            out.append((day.isoformat(), customers[ci]["customer_id"], articles[ai]["article_id"],
                        f"{price:.16f}".rstrip("0"), 2 if rng.random() < online_p else 1))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/raw")
    ap.add_argument("--articles", type=int, default=600)
    ap.add_argument("--customers", type=int, default=4000)
    ap.add_argument("--daily", type=float, default=320, help="하루 평균 거래 건수")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    os.makedirs(args.out, exist_ok=True)

    articles = make_articles(rng, args.articles)
    customers = make_customers(rng, args.customers)
    tx = make_transactions(rng, articles, customers, args.daily, date(2018, 9, 20), date(2020, 9, 22))

    a_cols = [k for k in articles[0] if not k.startswith("_")]
    with open(os.path.join(args.out, "articles.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=a_cols, extrasaction="ignore"); w.writeheader(); w.writerows(articles)
    c_cols = [k for k in customers[0] if not k.startswith("_")]
    with open(os.path.join(args.out, "customers.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=c_cols, extrasaction="ignore"); w.writeheader(); w.writerows(customers)
    with open(os.path.join(args.out, "transactions_train.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f); w.writerow(["t_dat", "customer_id", "article_id", "price", "sales_channel_id"]); w.writerows(tx)
    print(f"articles={len(articles)} customers={len(customers)} transactions={len(tx)} -> {args.out}")


if __name__ == "__main__":
    main()
