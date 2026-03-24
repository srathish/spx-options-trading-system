"""
Price-Based ML Model — 500 days of SPX/SPY/QQQ

Trains on pure price action + macro data (no GEX needed).
Predicts: "Is today a good day to trade directionally?"

Labels:
  1 = SPX moved 30+ pts from open (good directional day)
  0 = SPX moved <30 pts (chop/range day, avoid)

Usage: python3 scripts/train-price-ml.py
"""

import pandas as pd
import numpy as np
import json
import xgboost as xgb
from sklearn.metrics import roc_auc_score
import warnings
warnings.filterwarnings('ignore')

# ---- Load data ----
with open('data/daily-prices-2y.json') as f:
    raw = json.load(f)

dates = sorted(raw.keys())
print(f"Loaded {len(dates)} trading days ({dates[0]} to {dates[-1]})")

# ---- Build feature matrix ----
rows = []
for i in range(20, len(dates)):  # need 20 days lookback
    d = dates[i]
    today = raw[d]

    if not today.get('spx_open') or not today.get('spx_close'):
        continue

    # Today's actual move (label)
    spx_move = today['spx_close'] - today['spx_open']
    spx_range = today['spx_high'] - today['spx_low']
    abs_move = abs(spx_move)

    # Previous days
    prev1 = raw[dates[i-1]]
    prev2 = raw[dates[i-2]]
    prev3 = raw[dates[i-3]]
    prev5 = raw[dates[i-5]]

    # Overnight gap
    overnight_gap = today['spx_open'] - prev1['spx_close'] if prev1.get('spx_close') else 0
    es_gap = (today.get('es_open', 0) or 0) - (prev1.get('es_close', 0) or 0)

    # Recent momentum (1d, 3d, 5d returns)
    ret_1d = (prev1['spx_close'] - prev2['spx_close']) / prev2['spx_close'] * 100 if prev2.get('spx_close') else 0
    ret_3d = (prev1['spx_close'] - prev3['spx_close']) / prev3['spx_close'] * 100 if prev3.get('spx_close') else 0
    ret_5d = (prev1['spx_close'] - prev5['spx_close']) / prev5['spx_close'] * 100 if prev5.get('spx_close') else 0

    # Recent volatility (5-day average range)
    ranges_5d = []
    for j in range(1, 6):
        p = raw[dates[i-j]]
        if p.get('spx_high') and p.get('spx_low'):
            ranges_5d.append(p['spx_high'] - p['spx_low'])
    avg_range_5d = np.mean(ranges_5d) if ranges_5d else 0

    # Recent volatility (20-day)
    ranges_20d = []
    for j in range(1, 21):
        p = raw[dates[i-j]]
        if p.get('spx_high') and p.get('spx_low'):
            ranges_20d.append(p['spx_high'] - p['spx_low'])
    avg_range_20d = np.mean(ranges_20d) if ranges_20d else 0

    # VIX features
    vix = today.get('vix_close') or prev1.get('vix_close') or 0
    vix_open = today.get('vix_open') or vix
    vix9d = today.get('vix9d_close') or 0
    vix_prev = prev1.get('vix_close') or 0
    vix_change = vix_open - vix_prev if vix_prev else 0
    vix_term = (vix9d - vix) if vix and vix9d else 0
    vix_inverted = 1 if vix9d > vix else 0

    # 10Y yield
    tnx = today.get('tnx_close') or 0
    tnx_prev = prev1.get('tnx_close') or 0
    tnx_change = tnx - tnx_prev if tnx_prev else 0

    # Dollar
    dxy = today.get('dxy_close') or 0
    dxy_prev = prev1.get('dxy_close') or 0
    dxy_change = dxy - dxy_prev if dxy_prev else 0

    # SPY volume (normalized to 20-day avg)
    spy_vol = today.get('spy_volume') or 0
    spy_vols_20d = [raw[dates[i-j]].get('spy_volume', 0) or 0 for j in range(1, 21)]
    avg_spy_vol = np.mean(spy_vols_20d) if spy_vols_20d else 1
    vol_ratio = spy_vol / avg_spy_vol if avg_spy_vol > 0 else 1

    # SPY vs QQQ cross-asset relationships
    spy_ret = ((today.get('spy_close') or 0) - (today.get('spy_open') or 0)) / (today.get('spy_open') or 1) * 100
    qqq_ret = ((today.get('qqq_close') or 0) - (today.get('qqq_open') or 0)) / (today.get('qqq_open') or 1) * 100
    spx_ret = (today['spx_close'] - today['spx_open']) / today['spx_open'] * 100 if today.get('spx_open') else 0

    # Divergence: are SPY and QQQ moving together or apart?
    spy_qqq_divergence = spy_ret - qqq_ret  # positive = SPY outperforming QQQ (rotation into value)
    spy_qqq_both_down = 1 if spy_ret < -0.3 and qqq_ret < -0.3 else 0  # broad selloff
    spy_qqq_both_up = 1 if spy_ret > 0.3 and qqq_ret > 0.3 else 0  # broad rally

    # Previous day cross-asset patterns
    prev_spy_ret = ((prev1.get('spy_close') or 0) - (prev1.get('spy_open') or 0)) / (prev1.get('spy_open') or 1) * 100 if prev1.get('spy_open') else 0
    prev_qqq_ret = ((prev1.get('qqq_close') or 0) - (prev1.get('qqq_open') or 0)) / (prev1.get('qqq_open') or 1) * 100 if prev1.get('qqq_open') else 0
    prev_spy_qqq_div = prev_spy_ret - prev_qqq_ret

    # 5-day correlation: are SPY and QQQ moving together recently?
    spy_rets_5d = []
    qqq_rets_5d = []
    for j in range(1, 6):
        p = raw[dates[i-j]]
        if p.get('spy_close') and p.get('spy_open') and p.get('qqq_close') and p.get('qqq_open'):
            spy_rets_5d.append((p['spy_close'] - p['spy_open']) / p['spy_open'] * 100)
            qqq_rets_5d.append((p['qqq_close'] - p['qqq_open']) / p['qqq_open'] * 100)
    if len(spy_rets_5d) >= 3:
        spy_qqq_corr = float(np.corrcoef(spy_rets_5d, qqq_rets_5d)[0, 1])
        if np.isnan(spy_qqq_corr): spy_qqq_corr = 0
    else:
        spy_qqq_corr = 0

    # QQQ relative strength (is tech leading or lagging?)
    qqq_rel_strength_1d = prev_qqq_ret - prev_spy_ret
    qqq_rel_strength_5d = sum(qqq_rets_5d) - sum(spy_rets_5d) if spy_rets_5d else 0

    # Volume divergence (is volume confirming the move?)
    qqq_vol = today.get('qqq_volume') or 0
    qqq_vols_20d = [raw[dates[i-j]].get('qqq_volume', 0) or 0 for j in range(1, 21)]
    avg_qqq_vol = np.mean(qqq_vols_20d) if qqq_vols_20d else 1
    qqq_vol_ratio = qqq_vol / avg_qqq_vol if avg_qqq_vol > 0 else 1
    vol_divergence = vol_ratio - qqq_vol_ratio  # SPY vol expanding faster than QQQ = broad move

    # Consecutive direction days
    consec_down = 0
    for j in range(1, 6):
        p = raw[dates[i-j]]
        if p.get('spx_close') and p.get('spx_open') and p['spx_close'] < p['spx_open']:
            consec_down += 1
        else:
            break
    consec_up = 0
    for j in range(1, 6):
        p = raw[dates[i-j]]
        if p.get('spx_close') and p.get('spx_open') and p['spx_close'] > p['spx_open']:
            consec_up += 1
        else:
            break

    # Day of week (Mon=0, Fri=4)
    from datetime import datetime
    dow = datetime.strptime(d, '%Y-%m-%d').weekday()

    # RSI(14) from daily closes
    closes_14 = []
    for j in range(15):
        p = raw[dates[i-j]]
        if p.get('spx_close'):
            closes_14.append(p['spx_close'])
    closes_14.reverse()
    if len(closes_14) >= 15:
        gains, losses_r = 0, 0
        for k in range(1, len(closes_14)):
            ch = closes_14[k] - closes_14[k-1]
            if ch > 0: gains += ch
            else: losses_r -= ch
        rsi = 100 - (100 / (1 + (gains/14) / (losses_r/14 + 1e-9)))
    else:
        rsi = 50

    # 20-day high/low distance
    highs_20 = [raw[dates[i-j]].get('spx_high', 0) or 0 for j in range(20)]
    lows_20 = [raw[dates[i-j]].get('spx_low', 9999) or 9999 for j in range(20)]
    high_20d = max(highs_20) if highs_20 else today['spx_open']
    low_20d = min(lows_20) if lows_20 else today['spx_open']
    pct_from_20d_high = (today['spx_open'] - high_20d) / high_20d * 100
    pct_from_20d_low = (today['spx_open'] - low_20d) / low_20d * 100

    rows.append({
        'date': d,
        # Features
        'overnight_gap': overnight_gap,
        'es_gap': es_gap,
        'ret_1d': ret_1d,
        'ret_3d': ret_3d,
        'ret_5d': ret_5d,
        'avg_range_5d': avg_range_5d,
        'avg_range_20d': avg_range_20d,
        'range_expansion': avg_range_5d / (avg_range_20d + 1e-9),
        'vix': vix,
        'vix_change': vix_change,
        'vix_term_structure': vix_term,
        'vix_inverted': vix_inverted,
        'tnx_change': tnx_change,
        'dxy_change': dxy_change,
        'spy_vol_ratio': vol_ratio,
        'consec_down': consec_down,
        'consec_up': consec_up,
        'dow': dow,
        'rsi_14': rsi,
        'pct_from_20d_high': pct_from_20d_high,
        'pct_from_20d_low': pct_from_20d_low,
        'prev_day_range': ranges_5d[0] if ranges_5d else 0,
        'prev_day_move': raw[dates[i-1]]['spx_close'] - raw[dates[i-1]]['spx_open'] if raw[dates[i-1]].get('spx_close') else 0,
        # Cross-asset relationships
        'spy_qqq_divergence': spy_qqq_divergence,
        'spy_qqq_both_down': spy_qqq_both_down,
        'spy_qqq_both_up': spy_qqq_both_up,
        'prev_spy_qqq_div': prev_spy_qqq_div,
        'spy_qqq_corr_5d': spy_qqq_corr,
        'qqq_rel_strength_1d': qqq_rel_strength_1d,
        'qqq_rel_strength_5d': qqq_rel_strength_5d,
        'qqq_vol_ratio': qqq_vol_ratio,
        'vol_divergence': vol_divergence,
        # Labels
        'spx_move': spx_move,
        'abs_move': abs_move,
        'spx_range': spx_range,
        'big_move_day': 1 if abs_move >= 30 else 0,    # 30+ pt directional
        'trend_day': 1 if abs_move >= 40 else 0,        # 40+ pt trend
        'direction': 1 if spx_move > 0 else -1,
    })

df = pd.DataFrame(rows)
print(f"Built {len(df)} samples")
print(f"\nLabel distribution:")
print(f"  big_move_day (30+):  {df['big_move_day'].mean():.1%}")
print(f"  trend_day (40+):     {df['trend_day'].mean():.1%}")
print(f"  avg abs_move:        {df['abs_move'].mean():.1f} pts")
print(f"  avg range:           {df['spx_range'].mean():.1f} pts")

# ---- Train: predict big_move_day ----
feature_cols = [
    'overnight_gap', 'es_gap', 'ret_1d', 'ret_3d', 'ret_5d',
    'avg_range_5d', 'avg_range_20d', 'range_expansion',
    'vix', 'vix_change', 'vix_term_structure', 'vix_inverted',
    'tnx_change', 'dxy_change', 'spy_vol_ratio',
    'consec_down', 'consec_up', 'dow', 'rsi_14',
    'pct_from_20d_high', 'pct_from_20d_low',
    'prev_day_range', 'prev_day_move',
    # Cross-asset
    'spy_qqq_divergence', 'spy_qqq_both_down', 'spy_qqq_both_up',
    'prev_spy_qqq_div', 'spy_qqq_corr_5d',
    'qqq_rel_strength_1d', 'qqq_rel_strength_5d',
    'qqq_vol_ratio', 'vol_divergence',
]

for target in ['big_move_day', 'trend_day']:
    print(f"\n{'='*60}")
    print(f"MODEL: {target}")
    print(f"{'='*60}")

    X = df[feature_cols].fillna(0).values
    y = df[target].values.astype(int)

    # Walk-forward: train on first 70%, test on last 30%
    split = int(len(df) * 0.7)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]
    dates_test = df['date'].values[split:]

    print(f"Train: {split} days | Test: {len(df)-split} days")
    print(f"Train period: {df['date'].values[0]} → {df['date'].values[split-1]}")
    print(f"Test period:  {dates_test[0]} → {dates_test[-1]}")
    print(f"Train positive rate: {y_train.mean():.1%} | Test: {y_test.mean():.1%}")

    model = xgb.XGBClassifier(
        max_depth=3, n_estimators=150, learning_rate=0.05,
        min_child_weight=5, subsample=0.8, colsample_bytree=0.8,
        reg_alpha=1.0, reg_lambda=2.0, random_state=42,
        eval_metric='logloss', verbosity=0,
    )
    model.fit(X_train, y_train)

    preds = model.predict_proba(X_test)[:, 1]
    auc = roc_auc_score(y_test, preds) if len(np.unique(y_test)) > 1 else 0.5
    print(f"\nOOS AUC: {auc:.3f}")

    # Threshold analysis
    print(f"\nThreshold analysis:")
    for thresh in [0.3, 0.4, 0.5, 0.6]:
        mask = preds >= thresh
        if mask.sum() == 0: continue
        tp = (mask & (y_test == 1)).sum()
        fp = (mask & (y_test == 0)).sum()
        fn = (~mask & (y_test == 1)).sum()
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        print(f"  >= {thresh}: {mask.sum():3d} days pass | precision={prec:.0%} | recall={recall:.0%}")

    # Feature importances
    imps = model.feature_importances_
    imp_sorted = sorted(zip(feature_cols, imps), key=lambda x: -x[1])
    print(f"\nTop 10 features:")
    for feat, imp in imp_sorted[:10]:
        print(f"  {feat:25s} {imp:.4f}")

    # Save model
    model.save_model(f'data/ml-price-{target}.json')
    print(f"\nModel saved to data/ml-price-{target}.json")

    # Show predictions on our GEX backtest dates
    print(f"\nPredictions on GEX backtest dates (test set):")
    gex_dates = ['2026-01-20', '2026-02-03', '2026-02-05', '2026-02-06',
                 '2026-02-12', '2026-02-23', '2026-03-06', '2026-03-12', '2026-03-20']
    for gd in gex_dates:
        idx = np.where(dates_test == gd)[0]
        if len(idx) > 0:
            prob = preds[idx[0]]
            actual = y_test[idx[0]]
            move = df[df['date'] == gd]['spx_move'].values[0]
            print(f"  {gd}: pred={prob:.2f} actual={actual} (SPX {move:+.0f})")

# Export for use in Node.js
trees = model.get_booster().get_dump(dump_format='json')
parsed_trees = [json.loads(t) for t in trees]
with open('data/ml-price-model-trees.json', 'w') as f:
    json.dump({'n_trees': len(parsed_trees), 'base_score': 0.5, 'trees': parsed_trees,
               'features': feature_cols}, f)
print(f"\nExported {len(parsed_trees)} trees for Node.js")
