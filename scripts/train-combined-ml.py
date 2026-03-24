"""
Combined ML — GEX + Price + Cross-Asset

Merges the GEX intraday features (55 days) with the daily price context
(500 days of learned relationships) into one model.

The model sees:
- WHERE dealers are positioned (GEX magnets, pins, squeezes on SPXW/SPY/QQQ)
- HOW the three tickers relate to each other (divergence, correlation, relative strength)
- WHAT the broader market context is (VIX, yields, momentum, volume)

Then predicts: "Will SPX move 15+ pts favorably from this entry?"

Usage: python3 scripts/train-combined-ml.py
"""

import pandas as pd
import numpy as np
import json
import xgboost as xgb
from sklearn.metrics import roc_auc_score
import warnings
warnings.filterwarnings('ignore')

# ---- Load GEX training data (2546 intraday snapshots) ----
gex_df = pd.read_csv('data/ml-training.csv')
print(f"GEX data: {len(gex_df)} snapshots across {gex_df['date'].nunique()} days")

# ---- Load daily price data ----
with open('data/daily-prices-2y.json') as f:
    daily_raw = json.load(f)

# ---- Build daily price features for each date ----
daily_dates = sorted(daily_raw.keys())

def get_daily_features(date_str):
    """Compute daily price context features for a given date."""
    idx = daily_dates.index(date_str) if date_str in daily_dates else -1
    if idx < 5:
        return None

    today = daily_raw[date_str]
    prev1 = daily_raw[daily_dates[idx-1]]
    prev2 = daily_raw[daily_dates[idx-2]]
    prev3 = daily_raw[daily_dates[idx-3]]
    prev5 = daily_raw[daily_dates[idx-5]] if idx >= 5 else prev3

    overnight_gap = (today.get('spx_open') or 0) - (prev1.get('spx_close') or 0)
    es_gap = (today.get('es_open') or 0) - (prev1.get('es_close') or 0)

    ret_1d = ((prev1.get('spx_close') or 0) - (prev2.get('spx_close') or 1)) / (prev2.get('spx_close') or 1) * 100
    ret_3d = ((prev1.get('spx_close') or 0) - (prev3.get('spx_close') or 1)) / (prev3.get('spx_close') or 1) * 100

    # 5d avg range
    ranges = []
    for j in range(1, min(6, idx)):
        p = daily_raw[daily_dates[idx-j]]
        if p.get('spx_high') and p.get('spx_low'):
            ranges.append(p['spx_high'] - p['spx_low'])
    avg_range_5d = np.mean(ranges) if ranges else 0

    # 20d avg range
    ranges_20 = []
    for j in range(1, min(21, idx)):
        p = daily_raw[daily_dates[idx-j]]
        if p.get('spx_high') and p.get('spx_low'):
            ranges_20.append(p['spx_high'] - p['spx_low'])
    avg_range_20d = np.mean(ranges_20) if ranges_20 else 0

    vix = today.get('vix_close') or prev1.get('vix_close') or 0
    vix9d = today.get('vix9d_close') or 0
    vix_term = (vix9d - vix) if vix and vix9d else 0

    tnx_change = (today.get('tnx_close') or 0) - (prev1.get('tnx_close') or 0)
    dxy_change = (today.get('dxy_close') or 0) - (prev1.get('dxy_close') or 0)

    # Volume ratios
    spy_vol = today.get('spy_volume') or prev1.get('spy_volume') or 0
    spy_vols = [daily_raw[daily_dates[idx-j]].get('spy_volume', 0) or 0 for j in range(1, min(21, idx))]
    spy_vol_ratio = spy_vol / (np.mean(spy_vols) + 1) if spy_vols else 1

    qqq_vol = today.get('qqq_volume') or 0
    qqq_vols = [daily_raw[daily_dates[idx-j]].get('qqq_volume', 0) or 0 for j in range(1, min(21, idx))]
    qqq_vol_ratio = qqq_vol / (np.mean(qqq_vols) + 1) if qqq_vols else 1

    # Cross-asset: previous day SPY vs QQQ
    prev_spy_ret = ((prev1.get('spy_close') or 0) - (prev1.get('spy_open') or 1)) / (prev1.get('spy_open') or 1) * 100
    prev_qqq_ret = ((prev1.get('qqq_close') or 0) - (prev1.get('qqq_open') or 1)) / (prev1.get('qqq_open') or 1) * 100
    prev_both_down = 1 if prev_spy_ret < -0.3 and prev_qqq_ret < -0.3 else 0

    # 5d SPY-QQQ correlation
    spy_rets_5d, qqq_rets_5d = [], []
    for j in range(1, min(6, idx)):
        p = daily_raw[daily_dates[idx-j]]
        if p.get('spy_close') and p.get('spy_open') and p.get('qqq_close') and p.get('qqq_open'):
            spy_rets_5d.append((p['spy_close'] - p['spy_open']) / p['spy_open'] * 100)
            qqq_rets_5d.append((p['qqq_close'] - p['qqq_open']) / p['qqq_open'] * 100)
    corr_5d = float(np.corrcoef(spy_rets_5d, qqq_rets_5d)[0, 1]) if len(spy_rets_5d) >= 3 else 0
    if np.isnan(corr_5d): corr_5d = 0

    # 20d high distance
    highs_20 = [daily_raw[daily_dates[idx-j]].get('spx_high', 0) or 0 for j in range(min(20, idx))]
    high_20d = max(highs_20) if highs_20 else today.get('spx_open', 0)
    pct_from_20d_high = ((today.get('spx_open') or 0) - high_20d) / (high_20d + 1) * 100

    # RSI(14)
    closes = []
    for j in range(min(16, idx)):
        c = daily_raw[daily_dates[idx-j]].get('spx_close')
        if c: closes.insert(0, c)
    rsi = 50
    if len(closes) >= 15:
        gains, losses = 0, 0
        for k in range(1, len(closes)):
            ch = closes[k] - closes[k-1]
            if ch > 0: gains += ch
            else: losses -= ch
        rsi = 100 - (100 / (1 + (gains/14) / (losses/14 + 1e-9)))

    return {
        'daily_overnight_gap': overnight_gap,
        'daily_es_gap': es_gap,
        'daily_ret_1d': ret_1d,
        'daily_ret_3d': ret_3d,
        'daily_avg_range_5d': avg_range_5d,
        'daily_avg_range_20d': avg_range_20d,
        'daily_range_expansion': avg_range_5d / (avg_range_20d + 1e-9),
        'daily_vix': vix,
        'daily_vix_term': vix_term,
        'daily_tnx_change': tnx_change,
        'daily_dxy_change': dxy_change,
        'daily_spy_vol_ratio': spy_vol_ratio,
        'daily_qqq_vol_ratio': qqq_vol_ratio,
        'daily_prev_both_down': prev_both_down,
        'daily_spy_qqq_corr': corr_5d,
        'daily_pct_from_20d_high': pct_from_20d_high,
        'daily_rsi': rsi,
    }

# ---- Merge: GEX snapshots + daily price context ----
print("\nMerging GEX + daily price features...")
daily_features_cache = {}
merged_rows = []
skipped = 0

for _, row in gex_df.iterrows():
    date = row['date']
    if date not in daily_features_cache:
        daily_features_cache[date] = get_daily_features(date)

    df_feats = daily_features_cache[date]
    if df_feats is None:
        skipped += 1
        continue

    merged = {**row.to_dict(), **df_feats}
    merged_rows.append(merged)

merged_df = pd.DataFrame(merged_rows)
print(f"Merged: {len(merged_df)} samples ({skipped} skipped, missing daily data)")

# ---- Feature columns: GEX + Daily Price ----
gex_features = [
    'best_magnet_dist', 'best_magnet_pct_of_total', 'regime_negative',
    'squeeze_up', 'squeeze_down', 'king_stability_pct', 'day_move', 'day_range',
    'minute_of_day', 'king_dist', 'king_abs_value_M', 'king_is_negative',
    'concentration', 'opening_gamma_M', 'price_trend_10', 'price_trend_30',
    'move_from_hod', 'move_from_lod', 'unique_kings_count', 'net_gex_M',
    # GEX cross-asset
    'spy_king_agrees', 'qqq_king_agrees', 'trinity_alignment',
    'spy_magnet_dist', 'qqq_magnet_dist',
    # Technicals
    'rsi_14', 'price_vs_vwap', 'ema9_above_ema21', 'atr_14',
    # Day context
    'trade_fighting_day', 'day_move_magnitude',
    'es_overnight_change', 'vix_term_structure',
]

daily_features = [
    'daily_overnight_gap', 'daily_es_gap', 'daily_ret_1d', 'daily_ret_3d',
    'daily_avg_range_5d', 'daily_avg_range_20d', 'daily_range_expansion',
    'daily_vix', 'daily_vix_term', 'daily_tnx_change', 'daily_dxy_change',
    'daily_spy_vol_ratio', 'daily_qqq_vol_ratio',
    'daily_prev_both_down', 'daily_spy_qqq_corr',
    'daily_pct_from_20d_high', 'daily_rsi',
]

all_features = gex_features + daily_features
print(f"Total features: {len(all_features)} ({len(gex_features)} GEX + {len(daily_features)} daily)")

# ---- Train: walk-forward validation ----
X = merged_df[all_features].fillna(0).values
y = merged_df['profitable_entry'].values.astype(int)
dates_arr = merged_df['date'].values

unique_dates = sorted(merged_df['date'].unique())
n_dates = len(unique_dates)

print(f"\n{'='*60}")
print(f"COMBINED MODEL: profitable_entry")
print(f"{'='*60}")
print(f"Samples: {len(y)} ({y.mean():.1%} positive)")

# Walk-forward: 5 folds
fold_size = n_dates // 5
all_preds = np.zeros(len(y))
all_true = np.zeros(len(y))
fold_aucs = []

for fold in range(5):
    train_end = (fold + 1) * fold_size
    test_end = min(train_end + fold_size, n_dates)
    if train_end >= n_dates or test_end <= train_end:
        continue

    train_dates = set(unique_dates[:train_end])
    test_dates = set(unique_dates[train_end:test_end])

    train_mask = merged_df['date'].isin(train_dates).values
    test_mask = merged_df['date'].isin(test_dates).values

    X_train, X_test = X[train_mask], X[test_mask]
    y_train, y_test = y[train_mask], y[test_mask]

    if len(y_test) == 0 or len(np.unique(y_test)) < 2:
        continue

    model = xgb.XGBClassifier(
        max_depth=3, n_estimators=150, learning_rate=0.05,
        min_child_weight=5, subsample=0.8, colsample_bytree=0.8,
        reg_alpha=1.0, reg_lambda=2.0, random_state=42,
        eval_metric='logloss', verbosity=0,
    )
    model.fit(X_train, y_train)

    preds = model.predict_proba(X_test)[:, 1]
    all_preds[test_mask] = preds
    all_true[test_mask] = y_test

    auc = roc_auc_score(y_test, preds)
    fold_aucs.append(auc)

    print(f"  Fold {fold+1}: AUC={auc:.3f} | train={len(train_dates)}d | test={len(test_dates)}d | {sorted(test_dates)[0]}→{sorted(test_dates)[-1]}")

mean_auc = np.mean(fold_aucs)
print(f"\nMean AUC: {mean_auc:.3f} (±{np.std(fold_aucs):.3f})")

# Threshold analysis
print(f"\nThreshold analysis:")
for thresh in [0.3, 0.4, 0.5, 0.6]:
    mask = all_preds >= thresh
    valid = all_true > -1  # all valid
    mask = mask & valid
    if mask.sum() == 0: continue
    tp = (mask & (all_true == 1)).sum()
    fp = (mask & (all_true == 0)).sum()
    fn = (~mask & (all_true == 1) & valid).sum()
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0
    print(f"  >= {thresh}: {mask.sum():3d} pass | precision={prec:.0%} | recall={recall:.0%}")

# ---- Train final model on all data ----
final_model = xgb.XGBClassifier(
    max_depth=3, n_estimators=150, learning_rate=0.05,
    min_child_weight=5, subsample=0.8, colsample_bytree=0.8,
    reg_alpha=1.0, reg_lambda=2.0, random_state=42,
    eval_metric='logloss', verbosity=0,
)
final_model.fit(X, y)

# Feature importances
imps = final_model.feature_importances_
imp_sorted = sorted(zip(all_features, imps), key=lambda x: -x[1])
print(f"\nTop 15 features:")
for i, (feat, imp) in enumerate(imp_sorted[:15]):
    source = 'DAILY' if feat.startswith('daily_') else 'GEX'
    print(f"  {i+1:2d}. {feat:30s} {imp:.4f}  [{source}]")

# How many from each source in top 15?
top15_gex = sum(1 for f, _ in imp_sorted[:15] if not f.startswith('daily_'))
top15_daily = sum(1 for f, _ in imp_sorted[:15] if f.startswith('daily_'))
print(f"\nTop 15 composition: {top15_gex} GEX features, {top15_daily} daily price features")

# Save model
final_model.save_model('data/ml-combined-model.json')
trees = final_model.get_booster().get_dump(dump_format='json')
parsed_trees = [json.loads(t) for t in trees]
with open('data/ml-combined-trees.json', 'w') as f:
    json.dump({'n_trees': len(parsed_trees), 'base_score': 0.5, 'trees': parsed_trees,
               'features': all_features}, f)
print(f"\nExported {len(parsed_trees)} trees to data/ml-combined-trees.json")

# ---- Compare: GEX-only vs Combined ----
print(f"\n{'='*60}")
print(f"COMPARISON: GEX-only (AUC ~0.74) vs Combined")
print(f"{'='*60}")
print(f"Combined walk-forward AUC: {mean_auc:.3f}")
print(f"The daily price context adds {'signal' if mean_auc > 0.75 else 'marginal value'} to GEX-only predictions")
