#!/usr/bin/env python3
"""
ML Entry Filter for GexClaw
Trains a gradient boosting classifier on backtest trades to predict WIN/LOSS.
Uses walk-forward validation to avoid overfitting.

Usage: python3 scripts/train-ml-model.py
"""

import json
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.preprocessing import LabelEncoder
from pathlib import Path
import warnings
warnings.filterwarnings('ignore')

# ---- Load Data ----

data_path = Path('data/ml-training-data.json')
with open(data_path) as f:
    raw = json.load(f)

print(f"Loaded {len(raw)} trades from {data_path}")

# ---- Feature Engineering ----

def flatten_trade(t):
    """Flatten a trade dict into numeric features."""
    feat = {}

    # Time features
    feat['hour'] = t['hour']
    feat['minute'] = t['minute']
    feat['minuteOfDay'] = t['minuteOfDay']
    feat['is_morning'] = 1 if t['hour'] == 9 else 0
    feat['is_first_15min'] = 1 if t['hour'] == 9 and t['minute'] < 48 else 0
    feat['is_power_hour'] = 1 if t['hour'] >= 15 else 0
    feat['is_noon'] = 1 if t['hour'] == 12 or (t['hour'] == 13 and t['minute'] < 15) else 0

    # GEX score features
    feat['score'] = t['score']
    feat['rawScore'] = t['rawScore']
    feat['score_gap'] = t['score'] - t['rawScore']  # EMA smoothing effect
    feat['gexAtSpot'] = t['gexAtSpot']
    feat['smoothedGexAtSpot'] = t['smoothedGexAtSpot']
    feat['gammaRatio'] = t['gammaRatio']
    feat['wallAsymmetry'] = t['wallAsymmetry']
    feat['directionalBalance'] = t['directionalBalance']
    feat['isChop'] = t['isChop']
    feat['inNegGamma'] = t['inNegGamma']

    # Charm pressure (flatten object)
    cp = t.get('charmPressure', {})
    if isinstance(cp, dict):
        feat['charmStrength'] = cp.get('strength', 0) or 0
        feat['charmActive'] = 1 if cp.get('active', False) else 0
    else:
        feat['charmStrength'] = 0
        feat['charmActive'] = 0

    # Pattern (one-hot)
    pattern = t['pattern']
    feat['pat_MAGNET_PULL'] = 1 if pattern == 'MAGNET_PULL' else 0
    feat['pat_RUG_PULL'] = 1 if pattern == 'RUG_PULL' else 0
    feat['pat_REVERSE_RUG'] = 1 if pattern == 'REVERSE_RUG' else 0

    # Direction and confidence
    feat['direction'] = t['direction']
    feat['confidence'] = t['confidence']

    # Wall distances
    feat['targetDist'] = t['targetDist']
    feat['stopDist'] = t['stopDist']
    feat['rr'] = min(t['rr'], 20)  # cap extreme R:R values
    feat['callWallDist'] = min(t['callWallDist'], 100)
    feat['putWallDist'] = min(t['putWallDist'], 100)
    feat['wallDistRatio'] = feat['callWallDist'] / max(feat['putWallDist'], 0.1)

    # Multi-ticker
    feat['alignmentCount'] = t['alignmentCount']
    feat['alignmentMatchesDir'] = t['alignmentMatchesDir']
    feat['multiBonus'] = t['multiBonus']
    feat['multiConfidence'] = t['multiConfidence']

    # HOD/LOD
    feat['distFromHod'] = t['distFromHod']
    feat['distFromLod'] = t['distFromLod']
    feat['rangeUsed'] = t['rangeUsed']

    # Momentum
    feat['momentumPts'] = t['momentumPts']
    feat['momentumStrength'] = t['momentumStrength']
    feat['momentumAligned'] = t['momentumAligned']

    # Session context
    feat['dayPnl'] = t['dayPnl']
    feat['tradesToday'] = t['tradesToday']
    feat['recentLosses'] = t['recentLosses']

    # Interaction features
    feat['score_x_alignment'] = t['score'] * t['alignmentCount']
    feat['score_x_momentum'] = t['score'] * t['momentumAligned']
    feat['morning_high_score'] = feat['is_morning'] * (1 if t['score'] >= 80 else 0)
    feat['rr_x_alignment'] = feat['rr'] * t['alignmentCount']

    return feat

# Build DataFrame
features = [flatten_trade(t) for t in raw]
df = pd.DataFrame(features)
y = np.array([t['isWin'] for t in raw])
spx_changes = np.array([t['spxChange'] for t in raw])
dates = [t['_openedAt'][:10] for t in raw]
df['_date'] = dates

print(f"\nFeature matrix: {df.shape[0]} trades x {df.shape[1] - 1} features")
print(f"Class balance: {y.sum()} wins ({y.mean()*100:.1f}%) / {len(y)-y.sum()} losses ({(1-y.mean())*100:.1f}%)")

# ---- Walk-Forward Validation ----
# Split by date: train on first N days, test on last M days
# This simulates real deployment where we train on past data

unique_dates = sorted(set(dates))
n_dates = len(unique_dates)
print(f"\nDate range: {unique_dates[0]} to {unique_dates[-1]} ({n_dates} days)")

# Walk-forward: train on first 40 days, test on last 20
split_idx = int(n_dates * 0.67)  # ~40 train, ~20 test
train_dates = set(unique_dates[:split_idx])
test_dates = set(unique_dates[split_idx:])

train_mask = df['_date'].isin(train_dates)
test_mask = df['_date'].isin(test_dates)

feature_cols = [c for c in df.columns if c != '_date']
X_train = df.loc[train_mask, feature_cols].values
X_test = df.loc[test_mask, feature_cols].values
y_train = y[train_mask]
y_test = y[test_mask]
pnl_test = spx_changes[test_mask]

print(f"Train: {len(X_train)} trades ({len(train_dates)} days: {min(train_dates)} to {max(train_dates)})")
print(f"Test:  {len(X_test)} trades ({len(test_dates)} days: {min(test_dates)} to {max(test_dates)})")

# ---- Train Model ----

print("\n=== Training Gradient Boosting Classifier ===")
model = GradientBoostingClassifier(
    n_estimators=200,
    max_depth=3,
    learning_rate=0.05,
    min_samples_leaf=10,  # prevent overfitting on small dataset
    subsample=0.8,
    random_state=42,
)
model.fit(X_train, y_train)

# ---- Evaluate ----

train_acc = model.score(X_train, y_train)
test_acc = model.score(X_test, y_test)
print(f"\nTrain accuracy: {train_acc:.3f}")
print(f"Test accuracy:  {test_acc:.3f}")

y_pred = model.predict(X_test)
y_prob = model.predict_proba(X_test)[:, 1]

print(f"\n{classification_report(y_test, y_pred, target_names=['LOSS', 'WIN'])}")
print(f"Confusion matrix:\n{confusion_matrix(y_test, y_pred)}")

# ---- Simulate Trading with ML Filter ----

print("\n=== Trading Simulation (Test Period) ===")
print(f"Baseline (no filter): {len(X_test)} trades | {y_test.sum()}W/{len(y_test)-y_test.sum()}L | NET: {pnl_test.sum():+.2f} pts")

# Try different probability thresholds
for threshold in [0.40, 0.45, 0.50, 0.55, 0.60]:
    allowed = y_prob >= threshold
    if allowed.sum() == 0:
        print(f"  Threshold {threshold:.2f}: 0 trades (all blocked)")
        continue

    filtered_wins = y_test[allowed].sum()
    filtered_losses = allowed.sum() - filtered_wins
    filtered_pnl = pnl_test[allowed].sum()
    filtered_wr = filtered_wins / allowed.sum() * 100

    blocked_pnl = pnl_test[~allowed].sum()
    print(f"  Threshold {threshold:.2f}: {allowed.sum():3d} trades | {filtered_wins}W/{filtered_losses}L ({filtered_wr:.1f}% WR) | NET: {filtered_pnl:+.2f} pts | Blocked: {(~allowed).sum()} trades ({blocked_pnl:+.2f} pts)")

# ---- Feature Importance ----

print("\n=== Top 15 Feature Importances ===")
importances = model.feature_importances_
feat_imp = sorted(zip(feature_cols, importances), key=lambda x: -x[1])
for name, imp in feat_imp[:15]:
    print(f"  {name:30s} {imp:.4f}")

# ---- Export Model for Live Use ----

# Save model parameters and thresholds for Node.js integration
# We export as a simple decision table rather than requiring sklearn in production

print("\n=== Generating Decision Rules ===")

# Analyze probability distribution
probs_all = model.predict_proba(np.vstack([X_train, X_test]))[:, 1]
for pct in [10, 25, 50, 75, 90]:
    print(f"  P{pct}: {np.percentile(probs_all, pct):.3f}")

# Export the model as joblib for Python, and also export feature columns
import pickle
model_path = Path('data/ml-entry-model.pkl')
with open(model_path, 'wb') as f:
    pickle.dump({
        'model': model,
        'feature_cols': feature_cols,
        'threshold': 0.50,  # default, tune based on results above
        'train_dates': sorted(train_dates),
        'test_dates': sorted(test_dates),
    }, f)
print(f"\nModel saved to {model_path}")

# ---- Per-Pattern Analysis ----

print("\n=== Per-Pattern ML Filter Impact (Test Period) ===")
patterns = ['MAGNET_PULL', 'RUG_PULL', 'REVERSE_RUG']
test_df = df.loc[test_mask].copy()
test_df['y'] = y_test
test_df['pnl'] = pnl_test
test_df['prob'] = y_prob

for pat_col in ['pat_MAGNET_PULL', 'pat_RUG_PULL', 'pat_REVERSE_RUG']:
    pat_name = pat_col.replace('pat_', '')
    pat_mask = test_df[pat_col] == 1
    if pat_mask.sum() == 0:
        continue
    sub = test_df[pat_mask]
    base_pnl = sub['pnl'].sum()
    base_wr = sub['y'].mean() * 100

    # With 0.50 threshold
    allowed = sub['prob'] >= 0.50
    if allowed.sum() > 0:
        filt_pnl = sub.loc[allowed, 'pnl'].sum()
        filt_wr = sub.loc[allowed, 'y'].mean() * 100
        print(f"  {pat_name:20s} Base: {pat_mask.sum()} trades, {base_wr:.0f}% WR, {base_pnl:+.2f} pts → Filter: {allowed.sum()} trades, {filt_wr:.0f}% WR, {filt_pnl:+.2f} pts")
    else:
        print(f"  {pat_name:20s} Base: {pat_mask.sum()} trades, {base_wr:.0f}% WR, {base_pnl:+.2f} pts → All blocked at 0.50 threshold")
