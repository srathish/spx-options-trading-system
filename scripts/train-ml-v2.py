#!/usr/bin/env python3
"""
ML Entry Filter v2: Simpler model, stop-hit focused, conservative blocking.

Key changes from v1:
- Target: predict STOP_HIT (the main drain -557 pts) vs everything else
- Simpler features: only top predictive features, no interaction terms
- Conservative: only block trades the model is very confident will stop out
- Multiple model types: logistic regression, shallow tree, random forest
"""

import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.metrics import classification_report
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

# ---- Load Data ----

with open('data/ml-training-data.json') as f:
    raw = json.load(f)

print(f"Loaded {len(raw)} trades")

# ---- Simplified Feature Engineering ----

def make_features(t):
    """Minimal feature set — only use features with clear predictive logic."""
    cp = t.get('charmPressure', {})
    charm = cp.get('strength', 0) if isinstance(cp, dict) else 0

    return {
        # Time (most predictive per v1)
        'hour': t['hour'],
        'minute': t['minute'],
        # GEX environment
        'score': t['score'],
        'inNegGamma': t['inNegGamma'],
        'directionalBalance': t['directionalBalance'],
        'gammaRatio': t['gammaRatio'],
        'wallAsymmetry': t['wallAsymmetry'],
        # Trade setup quality
        'targetDist': t['targetDist'],
        'stopDist': t['stopDist'],
        'rr': min(t['rr'], 20),
        'callWallDist': min(t['callWallDist'], 100),
        'putWallDist': min(t['putWallDist'], 100),
        # Direction/pattern
        'direction': t['direction'],
        'confidence': t['confidence'],
        'pat_MP': 1 if t['pattern'] == 'MAGNET_PULL' else 0,
        'pat_RP': 1 if t['pattern'] == 'RUG_PULL' else 0,
        # Multi-ticker
        'alignmentCount': t['alignmentCount'],
        'alignmentMatchesDir': t['alignmentMatchesDir'],
        'multiBonus': t['multiBonus'],
        # Market context
        'momentumPts': t['momentumPts'],
        'momentumAligned': t['momentumAligned'],
        'distFromHod': t['distFromHod'],
        'distFromLod': t['distFromLod'],
        'rangeUsed': t['rangeUsed'],
        # Session state
        'dayPnl': t['dayPnl'],
        'tradesToday': t['tradesToday'],
        'recentLosses': t['recentLosses'],
        'charmStrength': charm or 0,
    }

features = [make_features(t) for t in raw]
df = pd.DataFrame(features)
feature_cols = list(df.columns)

# Multiple target definitions
y_win = np.array([t['isWin'] for t in raw])
y_stop = np.array([1 if t['exitReason'] in ('STOP_HIT', 'TM_STOP_HIT') else 0 for t in raw])
pnl = np.array([t['spxChange'] for t in raw])
dates = [t['_openedAt'][:10] for t in raw]
patterns = [t['pattern'] for t in raw]

print(f"Features: {len(feature_cols)}")
print(f"Stop hits: {y_stop.sum()} ({y_stop.mean()*100:.1f}%)")
print(f"Non-stop exits: {len(y_stop) - y_stop.sum()} ({(1-y_stop.mean())*100:.1f}%)")

# ---- Walk-Forward Split ----

unique_dates = sorted(set(dates))
n = len(unique_dates)
split = int(n * 0.67)
train_dates = set(unique_dates[:split])
test_dates = set(unique_dates[split:])

date_arr = np.array(dates)
train_mask = np.array([d in train_dates for d in dates])
test_mask = ~train_mask

X_train, X_test = df.values[train_mask], df.values[test_mask]
y_train_stop, y_test_stop = y_stop[train_mask], y_stop[test_mask]
y_train_win, y_test_win = y_win[train_mask], y_win[test_mask]
pnl_test = pnl[test_mask]
patterns_test = np.array(patterns)[test_mask]

print(f"\nTrain: {len(X_train)} trades ({len(train_dates)} days)")
print(f"Test:  {len(X_test)} trades ({len(test_dates)} days)")
print(f"Test stops: {y_test_stop.sum()} | Test wins: {y_test_win.sum()}")

# ---- Train Multiple Models ----

models = {
    'LogReg': LogisticRegression(max_iter=1000, C=0.1, random_state=42),
    'Tree_d3': DecisionTreeClassifier(max_depth=3, min_samples_leaf=15, random_state=42),
    'Tree_d4': DecisionTreeClassifier(max_depth=4, min_samples_leaf=10, random_state=42),
    'RF_50': RandomForestClassifier(n_estimators=50, max_depth=4, min_samples_leaf=10, random_state=42),
    'GBM_light': GradientBoostingClassifier(n_estimators=100, max_depth=2, learning_rate=0.05, min_samples_leaf=15, subsample=0.8, random_state=42),
}

print("\n" + "="*80)
print("TARGET: STOP_HIT prediction (block trades likely to stop out)")
print("="*80)

best_model = None
best_pnl_gain = -999

for name, model in models.items():
    model.fit(X_train, y_train_stop)
    train_acc = model.score(X_train, y_train_stop)
    test_acc = model.score(X_test, y_test_stop)

    y_prob_stop = model.predict_proba(X_test)[:, 1]

    print(f"\n--- {name} (Train: {train_acc:.3f} | Test: {test_acc:.3f}) ---")

    # Conservative filter: only block trades where model is >X% confident it will stop
    for block_threshold in [0.50, 0.55, 0.60, 0.65, 0.70]:
        block_mask = y_prob_stop >= block_threshold  # model thinks these will stop
        allow_mask = ~block_mask

        if allow_mask.sum() == 0:
            continue

        allowed_pnl = pnl_test[allow_mask].sum()
        blocked_pnl = pnl_test[block_mask].sum()
        allowed_wins = y_test_win[allow_mask].sum()
        allowed_losses = allow_mask.sum() - allowed_wins
        blocked_stops = y_test_stop[block_mask].sum()
        blocked_nonstops = block_mask.sum() - blocked_stops

        # Key metric: how much PnL does blocking save vs lose?
        pnl_gain = -blocked_pnl  # positive if blocking removes net-negative trades
        marker = " ***" if pnl_gain > 0 else ""

        print(f"  Block>{block_threshold:.2f}: Allow {allow_mask.sum()} trades ({allowed_pnl:+.2f} pts, {allowed_wins}W/{allowed_losses}L) | "
              f"Block {block_mask.sum()} ({blocked_stops} actual stops, {blocked_nonstops} false blocks) | "
              f"PnL saved: {pnl_gain:+.2f}{marker}")

        if pnl_gain > best_pnl_gain:
            best_pnl_gain = pnl_gain
            best_model = (name, model, block_threshold)

# ---- Also try WIN prediction ----

print("\n" + "="*80)
print("TARGET: WIN prediction (allow trades likely to win)")
print("="*80)

for name, model_cls in [
    ('LogReg_win', LogisticRegression(max_iter=1000, C=0.1, random_state=42)),
    ('RF_win', RandomForestClassifier(n_estimators=50, max_depth=4, min_samples_leaf=10, random_state=42)),
    ('GBM_win', GradientBoostingClassifier(n_estimators=100, max_depth=2, learning_rate=0.05, min_samples_leaf=15, subsample=0.8, random_state=42)),
]:
    model_cls.fit(X_train, y_train_win)
    train_acc = model_cls.score(X_train, y_train_win)
    test_acc = model_cls.score(X_test, y_test_win)

    y_prob_win = model_cls.predict_proba(X_test)[:, 1]

    print(f"\n--- {name} (Train: {train_acc:.3f} | Test: {test_acc:.3f}) ---")

    for allow_threshold in [0.35, 0.40, 0.45, 0.50, 0.55]:
        allow_mask = y_prob_win >= allow_threshold
        if allow_mask.sum() == 0:
            continue

        allowed_pnl = pnl_test[allow_mask].sum()
        blocked_pnl = pnl_test[~allow_mask].sum()
        allowed_wins = y_test_win[allow_mask].sum()
        allowed_losses = allow_mask.sum() - allowed_wins

        pnl_gain = -blocked_pnl
        marker = " ***" if pnl_gain > 0 else ""

        print(f"  Allow>{allow_threshold:.2f}: {allow_mask.sum()} trades ({allowed_pnl:+.2f} pts, {allowed_wins}W/{allowed_losses}L) | "
              f"Blocked: {(~allow_mask).sum()} ({blocked_pnl:+.2f} pts) | PnL saved: {pnl_gain:+.2f}{marker}")

# ---- Best result ----

print(f"\n{'='*80}")
print(f"BASELINE: {len(X_test)} trades | {y_test_win.sum()}W/{len(X_test)-y_test_win.sum()}L | NET: {pnl_test.sum():+.2f} pts")
if best_model:
    bname, bmod, bthresh = best_model
    print(f"BEST STOP FILTER: {bname} at threshold {bthresh:.2f} → saves {best_pnl_gain:+.2f} pts")

# ---- Feature Importance for best model ----

if best_model:
    bname, bmod, _ = best_model
    if hasattr(bmod, 'feature_importances_'):
        print(f"\n=== {bname} Feature Importances ===")
        imp = sorted(zip(feature_cols, bmod.feature_importances_), key=lambda x: -x[1])
        for name, val in imp[:10]:
            print(f"  {name:25s} {val:.4f}")

# ---- Decision Tree Visualization ----

print("\n=== Decision Tree Rules (depth 3) ===")
tree_model = models['Tree_d3']
from sklearn.tree import export_text
rules = export_text(tree_model, feature_names=feature_cols, max_depth=3)
print(rules)
