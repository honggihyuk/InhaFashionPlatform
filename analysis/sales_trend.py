"""
PyTorch 기반 H&M 판매 추이 분석.

입력
  - catalog.db  : H&M transactions(t_dat, customer_id, article_id, price, sales_channel_id) + articles
  - member.db   : 플랫폼 자체 주문(member.orders.created_at 에 시각 정보 포함)
출력
  - data/analysis/sales_trends.json : 관리자 대시보드가 그리는 모든 지표 + 행사(할인) 상품 추천(promotions)

중요: H&M 원본 transactions_train 에는 '날짜'만 있고 '시각'이 없습니다.
      따라서
        * 일/주/월/요일/채널/카테고리별 추이와 수요 예측은 H&M 거래 데이터로,
        * 0~23시 시간대별 추이는 시각이 기록되는 플랫폼 자체 주문(member.orders)으로
      계산합니다. 집계는 모두 torch 텐서 연산(index_add_, bincount)으로 수행하고,
      다음 4주 매출은 torch.nn 회귀 모델로 학습·예측합니다.

    python analysis/sales_trend.py [--catalog data/db/catalog.db] [--member data/db/member.db]
                                   [--out data/analysis/sales_trends.json] [--epochs 1500]
"""
import argparse
import json
import math
import os
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta

import numpy as np
import torch
from torch import nn

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KRW_PER_UNIT = 1_000_000  # load_hm_data.py 와 동일한 원화 환산 계수
WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]

torch.manual_seed(7)
np.random.seed(7)


def log(msg):
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ---------------------------------------------------------------------------
# 1. 데이터 로드 → 텐서
# ---------------------------------------------------------------------------
def load_transactions(con):
    rows = con.execute("""
        SELECT t.t_dat, t.price, t.sales_channel_id,
               COALESCE(a.product_group_name, 'Unknown'), COALESCE(a.index_group_name, 'Unknown'), t.article_id
        FROM transactions t LEFT JOIN articles a ON a.article_id = t.article_id
    """).fetchall()
    if not rows:
        raise SystemExit("transactions 테이블이 비어 있습니다. load_hm_data.py 를 먼저 실행하세요.")
    dates = np.array([r[0] for r in rows])
    uniq, inv = np.unique(dates, return_inverse=True)
    d0 = date.fromisoformat(str(uniq[0]))
    d1 = date.fromisoformat(str(uniq[-1]))
    day_of_uniq = np.array([(date.fromisoformat(d) - d0).days for d in uniq])
    groups = sorted({r[3] for r in rows})
    idx_groups = sorted({r[4] for r in rows})
    arts, art_inv = np.unique(np.array([r[5] for r in rows]), return_inverse=True)
    g_index = {g: i for i, g in enumerate(groups)}
    ig_index = {g: i for i, g in enumerate(idx_groups)}
    return {
        "start": d0, "end": d1, "n_days": (d1 - d0).days + 1,
        "day": torch.from_numpy(day_of_uniq[inv]).long(),
        "price": torch.tensor([r[1] for r in rows], dtype=torch.float64) * KRW_PER_UNIT,
        "channel": torch.tensor([r[2] for r in rows], dtype=torch.long),
        "group": torch.tensor([g_index[r[3]] for r in rows], dtype=torch.long),
        "index_group": torch.tensor([ig_index[r[4]] for r in rows], dtype=torch.long),
        "article": torch.from_numpy(art_inv).long(), "article_ids": arts,
        "groups": groups, "index_groups": idx_groups,
        "customers": len({r for (r,) in con.execute("SELECT DISTINCT customer_id FROM transactions")}),
    }


def daily_aggregate(tx):
    n = tx["n_days"]
    revenue = torch.zeros(n, dtype=torch.float64).index_add_(0, tx["day"], tx["price"])
    units = torch.bincount(tx["day"], minlength=n).double()
    online = torch.zeros(n, dtype=torch.float64).index_add_(0, tx["day"], tx["price"] * (tx["channel"] == 2))
    return revenue, units, online


# ---------------------------------------------------------------------------
# 2. 추이 분석 (텐서 연산)
# ---------------------------------------------------------------------------
def dates_of(tx):
    return [tx["start"] + timedelta(days=i) for i in range(tx["n_days"])]


def bucket_sum(values, keys, n):
    return torch.zeros(n, dtype=torch.float64).index_add_(0, keys, values)


def trends(tx, revenue, units, online):
    days = dates_of(tx)
    # 주별 (월요일 시작)
    week_start = [d - timedelta(days=d.weekday()) for d in days]
    w_labels = sorted(set(week_start))
    w_key = torch.tensor([w_labels.index(w) for w in week_start])
    w_rev = bucket_sum(revenue, w_key, len(w_labels))
    w_units = bucket_sum(units, w_key, len(w_labels))
    # 월별
    m_of_day = [d.strftime("%Y-%m") for d in days]
    m_labels = sorted(set(m_of_day))
    m_key = torch.tensor([m_labels.index(m) for m in m_of_day])
    m_rev = bucket_sum(revenue, m_key, len(m_labels))
    m_online = bucket_sum(online, m_key, len(m_labels))
    m_units = bucket_sum(units, m_key, len(m_labels))
    # 요일별 평균 (최근 52주) — 요일 효과 비교용
    last = max(0, tx["n_days"] - 364)
    wd = torch.tensor([d.weekday() for d in days[last:]])
    wd_rev = bucket_sum(revenue[last:], wd, 7) / torch.bincount(wd, minlength=7).double()
    wd_units = bucket_sum(units[last:], wd, 7) / torch.bincount(wd, minlength=7).double()

    # 카테고리(product_group) × 월 매출 — 상위 6개 + 기타
    tx_month = m_key[tx["day"]]
    G = len(tx["groups"])
    flat = tx_month * G + tx["group"]
    gm = torch.zeros(len(m_labels) * G, dtype=torch.float64).index_add_(0, flat, tx["price"]).view(len(m_labels), G)
    last12 = gm[-12:]
    order = torch.argsort(last12.sum(0), descending=True).tolist()
    top = order[:6]
    cat_series = [{"name": tx["groups"][g], "values": [round(v) for v in gm[:, g].tolist()],
                   "last12_revenue": round(last12[:, g].sum().item())} for g in top]
    others = [g for g in order[6:]]
    if others:
        cat_series.append({"name": "Other", "values": [round(v) for v in gm[:, others].sum(1).tolist()],
                           "last12_revenue": round(last12[:, others].sum().item())})

    # 최근 4주 vs 직전 4주 카테고리 성장률
    recent = tx["day"] >= tx["n_days"] - 28
    prev = (tx["day"] >= tx["n_days"] - 56) & ~recent
    r_g = bucket_sum(tx["price"] * recent, tx["group"], G)
    p_g = bucket_sum(tx["price"] * prev, tx["group"], G)
    growth = []
    for g in range(G):
        if p_g[g] > 0 and r_g[g] > 0:
            growth.append({"name": tx["groups"][g], "recent": round(r_g[g].item()), "previous": round(p_g[g].item()),
                           "change": round((r_g[g] / p_g[g] - 1).item() * 100, 1)})
    growth.sort(key=lambda x: -x["recent"])

    # 최근 4주 베스트셀러
    A = len(tx["article_ids"])
    a_units = torch.bincount(tx["article"][recent], minlength=A)
    a_rev = bucket_sum(tx["price"] * recent, tx["article"], A)
    best = torch.argsort(a_units, descending=True)[:10].tolist()
    best_sellers = [{"article_id": str(tx["article_ids"][i]), "units": int(a_units[i]), "revenue": round(a_rev[i].item())}
                    for i in best if a_units[i] > 0]

    return {
        "daily": {"dates": [d.isoformat() for d in days[-365:]],
                  "revenue": [round(v) for v in revenue[-365:].tolist()],
                  "units": [int(v) for v in units[-365:].tolist()]},
        "weekly": {"weeks": [w.isoformat() for w in w_labels], "revenue": [round(v) for v in w_rev.tolist()],
                   "units": [int(v) for v in w_units.tolist()]},
        "monthly": {"months": m_labels, "revenue": [round(v) for v in m_rev.tolist()],
                    "units": [int(v) for v in m_units.tolist()],
                    "online_share": [round((o / r).item() * 100, 1) if r > 0 else None for o, r in zip(m_online, m_rev)]},
        "weekday": {"labels": WEEKDAYS, "avg_revenue": [round(v) for v in wd_rev.tolist()],
                    "avg_units": [round(v, 1) for v in wd_units.tolist()]},
        "categories": {"months": m_labels, "series": cat_series},
        "category_growth": growth[:10],
        "best_sellers": best_sellers,
    }


# ---------------------------------------------------------------------------
# 3. PyTorch 수요 예측 모델 (다음 28일 일매출)
# ---------------------------------------------------------------------------
def features(day_index, dates, n_total):
    """추세 + 요일 원-핫 + 연간 푸리에 계절성 + 이벤트(블랙프라이데이/연말/시즌세일) 특성"""
    t = torch.tensor(day_index, dtype=torch.float32) / n_total
    wd = torch.nn.functional.one_hot(torch.tensor([d.weekday() for d in dates]), 7).float()
    doy = torch.tensor([d.timetuple().tm_yday for d in dates], dtype=torch.float32)
    fourier = [f(2 * math.pi * k * doy / 365.25) for k in range(1, 5) for f in (torch.sin, torch.cos)]
    events = torch.tensor([[
        1.0 if (d.month == 11 and 22 <= d.day <= 30) else 0.0,
        1.0 if (d.month == 12 and d.day <= 22) else 0.0,
        1.0 if (d.month in (1, 7) and d.day <= 10) else 0.0,
    ] for d in dates])
    return torch.cat([t.unsqueeze(1), wd, torch.stack(fourier, 1), events], 1)


class DemandModel(nn.Module):
    """선형 성분(추세·요일·계절성, 해석 가능) + 계절/이벤트 특성만 보는 작은 MLP 잔차 성분.
    MLP 에는 연간 계절성·이벤트 특성만 넣고 추세(t)·요일은 선형 성분이 담당하게 하여 미래 구간에서 비선형 외삽이 폭주하지 않도록 합니다."""

    def __init__(self, n_in):
        super().__init__()
        self.linear = nn.Linear(n_in, 1)
        self.mlp = nn.Sequential(nn.Linear(n_in - 8, 32), nn.GELU(), nn.Linear(32, 1))

    def forward(self, x):
        return (self.linear(x) + 0.3 * self.mlp(x[:, 8:])).squeeze(1)


def fit(x, y, epochs):
    model = DemandModel(x.shape[1])
    opt = torch.optim.AdamW(model.parameters(), lr=0.03, weight_decay=1e-3)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, epochs)
    for _ in range(epochs):
        opt.zero_grad()
        loss = nn.functional.huber_loss(model(x), y, delta=0.3)
        loss.backward()
        opt.step()
        sched.step()
    return model, loss.item()


def forecast(tx, revenue, epochs, horizon=28, holdout=28):
    days = dates_of(tx)
    n = tx["n_days"]
    # 영업이 없던 날(0원)은 학습에서 제외
    valid = revenue > 0
    y_all = torch.log1p(revenue).float()
    mu, sd = y_all[valid].mean(), y_all[valid].std()
    x_all = features(list(range(n)), days, n + horizon)
    y_norm = (y_all - mu) / sd

    # (a) 홀드아웃 검증: 마지막 28일을 빼고 학습 → 정확도 측정
    tr = valid.clone(); tr[-holdout:] = False
    m_val, _ = fit(x_all[tr], y_norm[tr], epochs)
    with torch.no_grad():
        pred_val = torch.expm1(m_val(x_all[-holdout:]) * sd + mu).double()
    actual_val = revenue[-holdout:]
    mask = actual_val > 0
    mape = ((pred_val - actual_val).abs()[mask] / actual_val[mask]).mean().item() * 100
    mae = (pred_val - actual_val).abs().mean().item()

    # (b) 전체 데이터로 재학습 → 미래 28일 예측
    model, final_loss = fit(x_all[valid], y_norm[valid], epochs)
    fut_dates = [tx["end"] + timedelta(days=i) for i in range(1, horizon + 1)]
    x_fut = features(list(range(n, n + horizon)), fut_dates, n + horizon)
    with torch.no_grad():
        fitted = torch.expm1(model(x_all) * sd + mu).double()
        pred = torch.expm1(model(x_fut) * sd + mu).double()
    resid = torch.log1p(revenue[valid]) - torch.log1p(fitted[valid])
    band = 1.64 * resid.std().item()  # ~90% 구간
    # 선형 성분의 요일 가중치 → 요일 효과(%) 해석
    w = model.linear.weight.detach()[0]
    wd_w = w[1:8] * sd
    wd_effect = [round((math.exp(v - wd_w.mean().item()) - 1) * 100, 1) for v in wd_w.tolist()]

    return {
        "model": "PyTorch DemandModel (Linear + MLP residual, Huber loss, AdamW)",
        "features": "linear trend, weekday one-hot, yearly Fourier(k=1..4), Black Friday / December / season-sale flags",
        "epochs": epochs, "train_days": int(valid.sum()), "final_loss": round(final_loss, 4),
        "holdout": {"days": holdout, "mape_pct": round(mape, 2), "mae_krw": round(mae),
                    "dates": [d.isoformat() for d in days[-holdout:]],
                    "actual": [round(v) for v in actual_val.tolist()], "predicted": [round(v) for v in pred_val.tolist()]},
        "dates": [d.isoformat() for d in fut_dates],
        "predicted": [round(v) for v in pred.tolist()],
        "lower": [round(v * math.exp(-band)) for v in pred.tolist()],
        "upper": [round(v * math.exp(band)) for v in pred.tolist()],
        "fitted_last90": [round(v) for v in fitted[-90:].tolist()],
        "next_4w_total": round(pred.sum().item()),
        "last_4w_total": round(revenue[-28:].sum().item()),
        "weekday_effect_pct": wd_effect,
    }


# ---------------------------------------------------------------------------
# 4. 시간대(0~23시) 분석: 플랫폼 자체 주문
# ---------------------------------------------------------------------------
def hourly(member_db):
    if not os.path.exists(member_db):
        return None
    con = sqlite3.connect(member_db)
    try:
        rows = con.execute("""SELECT created_at, total_krw, source FROM orders WHERE status <> 'CANCELLED'""").fetchall()
    except sqlite3.OperationalError:
        return None
    finally:
        con.close()
    if not rows:
        return {"orders": 0}
    ts = [datetime.fromisoformat(r[0]) for r in rows]
    hour = torch.tensor([t.hour for t in ts])
    wday = torch.tensor([t.weekday() for t in ts])
    amount = torch.tensor([float(r[1]) for r in rows], dtype=torch.float64)
    n_days = max((max(ts).date() - min(ts).date()).days + 1, 1)
    h_orders = torch.bincount(hour, minlength=24).double()
    h_rev = bucket_sum(amount, hour, 24)
    heat = torch.bincount(wday * 24 + hour, minlength=168).view(7, 24)
    # 최근 7일 vs 이전 기간의 시간대 비중 변화
    cutoff = max(ts) - timedelta(days=7)
    recent = torch.tensor([t >= cutoff for t in ts])
    share_recent = torch.bincount(hour[recent], minlength=24).double()
    share_prev = torch.bincount(hour[~recent], minlength=24).double()
    share_recent = (share_recent / share_recent.sum().clamp(min=1) * 100)
    share_prev = (share_prev / share_prev.sum().clamp(min=1) * 100)
    peak = int(torch.argmax(h_orders))
    by_slot = {
        "새벽 (0-5시)": range(0, 6), "오전 (6-11시)": range(6, 12),
        "오후 (12-17시)": range(12, 18), "저녁 (18-23시)": range(18, 24),
    }
    slots = [{"name": k, "orders": int(h_orders[list(v)].sum()), "revenue": round(h_rev[list(v)].sum().item())}
             for k, v in by_slot.items()]
    return {
        "orders": len(rows), "days": n_days,
        "seed_orders": sum(1 for r in rows if r[2] == "seed"),
        "from": min(ts).isoformat(sep=" "), "to": max(ts).isoformat(sep=" "),
        "avg_orders_per_hour": [round(v / n_days, 2) for v in h_orders.tolist()],
        "avg_revenue_per_hour": [round(v / n_days) for v in h_rev.tolist()],
        "share_recent_7d": [round(v, 1) for v in share_recent.tolist()],
        "share_before": [round(v, 1) for v in share_prev.tolist()],
        "heatmap": {"weekdays": WEEKDAYS, "counts": heat.tolist()},
        "peak_hour": peak, "slots": slots,
    }



# ---------------------------------------------------------------------------
# 5. 행사(할인) 상품 추천: 재고는 많은데 판매가 줄어드는 상품
# ---------------------------------------------------------------------------
def load_products(con):
    """판매 중이고 재고가 있는 상품 {article_id: (stock, price_krw, prod_name, product_group_name)}"""
    try:
        rows = con.execute("""
            SELECT p.article_id, p.stock, p.price_krw, a.prod_name, COALESCE(a.product_group_name, 'Unknown')
            FROM products p JOIN articles a ON a.article_id = p.article_id
            WHERE p.is_active = 1 AND p.stock > 0""").fetchall()
    except sqlite3.OperationalError:  # products 테이블 없음
        return {}
    return {r[0]: (r[1], r[2], r[3], r[4]) for r in rows}


def promotion_candidates(tx, products, weeks=8, top_n=12):
    """상품별 최근 8주 주간 판매량을 텐서로 만들고
         - 재고 소진 기간(weeks of cover) = 재고 / 최근 4주 주평균 판매량
         - 판매 추세 = 주간 판매량의 최소제곱 기울기 / 평균 판매량 (주당 증감률)
       를 계산해 '재고 과다 + 판매 하락' 점수가 높은 상품을 행사 후보로 추천합니다.
       점수 = 0.6 × 재고 과다 점수 + 0.4 × 하락 추세 점수 (각 0~1)"""
    if not products:
        return []
    ids = sorted(products)
    pos = {aid: i for i, aid in enumerate(ids)}
    P = len(ids)
    # H&M 거래의 article 인덱스 → 판매 중 상품 인덱스 (-1: 판매 목록에 없음)
    to_p = torch.tensor([pos.get(str(a), -1) for a in tx["article_ids"]], dtype=torch.long)
    art_p = to_p[tx["article"]]
    week_back = (tx["n_days"] - 1 - tx["day"]) // 7  # 0 = 가장 최근 주
    mask = (week_back < weeks) & (art_p >= 0)
    flat = art_p[mask] * weeks + (weeks - 1 - week_back[mask])  # 열: 오래된 주 → 최근 주
    units = torch.bincount(flat, minlength=P * weeks).view(P, weeks).double()

    recent = units[:, -4:].sum(1)
    prev = units[:, :4].sum(1)
    xs = torch.arange(weeks, dtype=torch.float64) - (weeks - 1) / 2
    slope = (units * xs).sum(1) / (xs ** 2).sum()
    rel_trend = slope / units.mean(1).clamp(min=0.5)  # 주당 증감률
    stock = torch.tensor([products[a][0] for a in ids], dtype=torch.float64)
    weekly_rate = recent / 4
    cover = stock / weekly_rate.clamp(min=0.25)

    lo, hi = math.log1p(8), math.log1p(52)
    cover_score = ((torch.log1p(cover) - lo) / (hi - lo)).clamp(0, 1)
    decline_score = (-rel_trend / 0.15).clamp(0, 1)  # 주당 -15% 이상 하락이면 1
    score = 0.6 * cover_score + 0.4 * decline_score
    eligible = (cover >= 12) | ((decline_score >= 0.5) & (cover >= 4))  # 재고 3개월분 이상 또는 하락 + 1개월분 이상
    score = torch.where(eligible, score, torch.full_like(score, -1.0))

    # 점수가 같으면 묶여 있는 재고 금액(재고 × 판매가)이 큰 상품 우선
    tied_value = stock * torch.tensor([products[a][1] for a in ids], dtype=torch.float64)
    order = sorted(range(P), key=lambda i: (-round(score[i].item(), 3), -tied_value[i].item()))
    out = []
    for i in order[:top_n]:
        if score[i] < 0:
            break
        st_, price, name, group = products[ids[i]]
        r, p_ = int(recent[i]), int(prev[i])
        change = round((r / p_ - 1) * 100, 1) if p_ > 0 else None
        reasons = []
        if r == 0 and p_ == 0:
            reasons.append("최근 8주 판매 없음")
        elif cover[i] >= 52:
            reasons.append("재고 1년치 이상")
        elif cover[i] >= 12:
            reasons.append(f"재고 {cover[i].item():.0f}주분")
        if change is not None and change <= -20:
            reasons.append(f"최근 4주 판매 {change:+.0f}%")
        elif rel_trend[i] <= -0.05 and r + p_ > 0:
            reasons.append(f"판매 하락 추세 (주 {rel_trend[i].item() * 100:+.0f}%)")
        sc = score[i].item()
        out.append({
            "article_id": ids[i], "prod_name": name, "product_group": group,
            "stock": int(st_), "price_krw": int(price),
            "weekly_units": [int(v) for v in units[i].tolist()],
            "recent_4w_units": r, "prev_4w_units": p_, "change_pct": change,
            "weeks_of_cover": round(min(cover[i].item(), 999), 1),
            "trend_pct_per_week": round(rel_trend[i].item() * 100, 1),
            "score": round(sc, 3),
            "suggested_discount_pct": 30 if sc >= 0.75 else 20 if sc >= 0.5 else 10,
            "reasons": reasons,
        })
    return out


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default=os.path.join(ROOT, "data", "db", "catalog.db"))
    ap.add_argument("--member", default=os.path.join(ROOT, "data", "db", "member.db"))
    ap.add_argument("--out", default=os.path.join(ROOT, "data", "analysis", "sales_trends.json"))
    ap.add_argument("--epochs", type=int, default=1500)
    args = ap.parse_args()
    t0 = time.time()
    log(f"torch {torch.__version__} | device=cpu")

    con = sqlite3.connect(args.catalog)
    tx = load_transactions(con)
    products = load_products(con)
    con.close()
    log(f"거래 {len(tx['price']):,}건 로드 ({tx['start']} ~ {tx['end']})")

    revenue, units, online = daily_aggregate(tx)
    result = {"generated_at": datetime.now().isoformat(timespec="seconds"), "torch_version": torch.__version__}
    result.update(trends(tx, revenue, units, online))
    log("추이 집계 완료")
    result["forecast"] = forecast(tx, revenue, args.epochs)
    log(f"예측 모델 학습 완료 (holdout MAPE {result['forecast']['holdout']['mape_pct']}%)")
    result["hourly"] = hourly(args.member)
    log("시간대 분석 완료")
    result["promotions"] = promotion_candidates(tx, products)
    log(f"행사 상품 후보 {len(result['promotions'])}개 추천")

    last28 = revenue[-28:].sum().item(); prev28 = revenue[-56:-28].sum().item()
    result["summary"] = {
        "period": {"from": tx["start"].isoformat(), "to": tx["end"].isoformat(), "days": tx["n_days"]},
        "transactions": int(len(tx["price"])),
        "revenue_krw": round(tx["price"].sum().item()),
        "customers": tx["customers"],
        "articles_sold": int(len(tx["article_ids"])),
        "avg_price_krw": round(tx["price"].mean().item()),
        "online_share_pct": round((tx["price"] * (tx["channel"] == 2)).sum().item() / tx["price"].sum().item() * 100, 1),
        "last_28d_revenue": round(last28), "prev_28d_revenue": round(prev28),
        "last_28d_change_pct": round((last28 / prev28 - 1) * 100, 1) if prev28 else None,
        "elapsed_sec": round(time.time() - t0, 1),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False)
    os.replace(tmp, args.out)
    log(f"결과 저장: {args.out} ({result['summary']['elapsed_sec']}s)")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # 관리자 화면에 로그로 표시
        print(f"분석 실패: {e!r}", file=sys.stderr)
        raise
