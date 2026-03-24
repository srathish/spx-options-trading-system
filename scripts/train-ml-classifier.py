"""
LLM Call Classifier — XGBoost

Trains a gradient-boosted classifier to predict when an LLM call
will lead to a profitable trade entry. Outputs:
1. Model evaluation (cross-validated)
2. Feature importances
3. Exported decision rules as JSON for Node.js integration

Usage: python3 scripts/train-ml-classifier.py
"""

import pandas as pd
import numpy as np
from sklearn.model_selection import GroupKFold
from sklearn.metrics import classification_report, roc_auc_score, precision_recall_curve
import xgboost as xgb
import json
import warnings
warnings.filterwarnings('ignore')

# ---- Load data ----
df = pd.read_csv('data/ml-training.csv')
print(f"Loaded {len(df)} samples across {df['date'].nunique()} days")

# ---- Feature selection ----
# Focus on the 8 highest-signal features per analysis, plus a few extras
feature_cols = [
    'best_magnet_dist',          # magnet distance from spot
    'best_magnet_pct_of_total',  # magnet as % of total gamma (relative dominance)
    'regime_negative',           # net GEX regime (0=positive/pinning, 1=negative/amplifying)
    'squeeze_up', 'squeeze_down', # squeeze flags
    'king_stability_pct',        # king node stability over last 20 frames
    'day_move',                  # price move from open at time of call
    'day_range',                 # intraday range at time of call
    'minute_of_day',             # time of day
    'king_dist',                 # king node distance from spot
    'king_abs_value_M',          # king node absolute gamma
    'king_is_negative',          # king node is negative gamma (magnet vs pin)
    'concentration',             # top 3 strikes concentration
    'opening_gamma_M',           # total gamma at open
    'price_trend_10',            # 10-min price momentum
    'price_trend_30',            # 30-min price momentum
    'move_from_hod',             # distance from high of day
    'move_from_lod',             # distance from low of day
    'unique_kings_count',        # choppiness measure
    'net_gex_M',                 # raw net gamma
    'llm_direction',             # LLM's direction call (-1, 0, 1)
    'llm_confidence',            # LLM confidence (0, 1, 2)
    'llm_regime',                # LLM regime call (0=CHOP, 1=PINNED, 2=TREND)
    'llm_action',                # LLM action (0=WAIT/HOLD, 1=ENTER)
    # NEW: Day move context (trade vs day direction)
    'day_move_agrees',           # 1 if day move agrees with trade direction (>10 pts)
    'day_move_magnitude',        # absolute day move size
    'trade_fighting_day',        # 1 if trade opposes day move by >30 pts
    # NEW: SPY/QQQ cross-asset features
    'spy_king_agrees',           # 1 if SPY king direction matches SPXW trade
    'spy_king_is_negative',      # 1 if SPY king is negative gamma (magnet not pin)
    'spy_magnet_dist',           # SPY king distance from SPY spot
    'qqq_king_agrees',           # 1 if QQQ king direction matches SPXW trade
    'qqq_king_is_negative',      # 1 if QQQ king is negative gamma
    'qqq_magnet_dist',           # QQQ king distance from QQQ spot
    'trinity_alignment',         # 0-3 count of aligned tickers
    'trinity_all_agree',         # 1 if all 3 tickers agree on direction
]

# ---- Targets ----
# Primary: dir_correct_30 (was direction correct 30 min later?)
# Secondary: profitable_entry (would entry have gotten +15 pts MFE?)
print(f"\nLabel distribution:")
print(f"  dir_correct_30:  {df['dir_correct_30'].mean():.1%} positive")
print(f"  profitable_entry: {df['profitable_entry'].mean():.1%} positive")

# ---- Prepare features ----
X = df[feature_cols].copy()
# Fill NaN with 0 (missing magnet = no magnet)
X = X.fillna(0)

# Train two models: direction accuracy and profitable entry
for target_name in ['dir_correct_30', 'profitable_entry']:
    print(f"\n{'='*60}")
    print(f"MODEL: {target_name}")
    print(f"{'='*60}")

    y = df[target_name].values
    groups = df['date'].values  # group by day for cross-validation

    # Filter rows with valid labels
    valid = ~pd.isna(y) & (y >= 0)
    X_valid = X[valid].values
    y_valid = y[valid].astype(int)
    groups_valid = groups[valid]

    print(f"Valid samples: {len(y_valid)} ({y_valid.mean():.1%} positive)")

    # ---- Cross-validation by day (no data leakage) ----
    # GroupKFold ensures all calls from a day stay together
    gkf = GroupKFold(n_splits=5)

    all_preds = np.zeros(len(y_valid))
    all_true = np.zeros(len(y_valid))
    fold_aucs = []

    for fold, (train_idx, test_idx) in enumerate(gkf.split(X_valid, y_valid, groups_valid)):
        X_train, X_test = X_valid[train_idx], X_valid[test_idx]
        y_train, y_test = y_valid[train_idx], y_valid[test_idx]

        # Conservative hyperparameters to prevent overfitting
        model = xgb.XGBClassifier(
            max_depth=3,
            n_estimators=100,
            learning_rate=0.05,
            min_child_weight=5,
            subsample=0.8,
            colsample_bytree=0.8,
            reg_alpha=1.0,
            reg_lambda=2.0,
            random_state=42,
            eval_metric='logloss',
            verbosity=0,
        )
        model.fit(X_train, y_train)

        preds = model.predict_proba(X_test)[:, 1]
        all_preds[test_idx] = preds
        all_true[test_idx] = y_test

        auc = roc_auc_score(y_test, preds) if len(np.unique(y_test)) > 1 else 0.5
        fold_aucs.append(auc)

        n_train_days = len(np.unique(groups_valid[train_idx]))
        n_test_days = len(np.unique(groups_valid[test_idx]))
        print(f"  Fold {fold+1}: AUC={auc:.3f} | train={n_train_days}d/{len(y_train)} samples | test={n_test_days}d/{len(y_test)} samples")

    mean_auc = np.mean(fold_aucs)
    print(f"\nMean AUC: {mean_auc:.3f} (±{np.std(fold_aucs):.3f})")

    # ---- Threshold analysis ----
    print(f"\nThreshold analysis (what the gate would do):")
    for threshold in [0.3, 0.4, 0.5, 0.6, 0.7]:
        pred_pos = all_preds >= threshold
        if pred_pos.sum() == 0:
            print(f"  threshold={threshold:.1f}: 0 calls pass")
            continue
        tp = (pred_pos & (all_true == 1)).sum()
        fp = (pred_pos & (all_true == 0)).sum()
        fn = (~pred_pos & (all_true == 1)).sum()
        precision = tp / (tp + fp) if (tp + fp) > 0 else 0
        recall = tp / (tp + fn) if (tp + fn) > 0 else 0
        print(f"  threshold={threshold:.1f}: {pred_pos.sum():4d} calls pass | precision={precision:.1%} | recall={recall:.1%} | blocked={len(y_valid)-pred_pos.sum()}")

    # ---- Train final model on all data ----
    final_model = xgb.XGBClassifier(
        max_depth=3,
        n_estimators=100,
        learning_rate=0.05,
        min_child_weight=5,
        subsample=0.8,
        colsample_bytree=0.8,
        reg_alpha=1.0,
        reg_lambda=2.0,
        random_state=42,
        eval_metric='logloss',
        verbosity=0,
    )
    final_model.fit(X_valid, y_valid)

    # ---- Feature importances ----
    importances = final_model.feature_importances_
    feat_imp = sorted(zip(feature_cols, importances), key=lambda x: -x[1])
    print(f"\nTop 10 features:")
    for feat, imp in feat_imp[:10]:
        print(f"  {feat:30s} {imp:.4f}")

    # ---- Export model as JSON for Node.js ----
    # Save the booster as JSON (XGBoost native format)
    model_path = f'data/ml-model-{target_name}.json'
    final_model.save_model(model_path)
    print(f"\nModel saved to {model_path}")

    # Also export a simple threshold-based rule set for quick integration
    # Get leaf predictions for interpretability
    print(f"\n--- Simple rule extraction ---")
    # Find the single best split for quick manual rule
    tree = final_model.get_booster().get_dump(dump_format='json')
    first_tree = json.loads(tree[0])

    def extract_rules(node, depth=0):
        if 'leaf' in node:
            return
        feat_idx = int(node['split'].replace('f', ''))
        feat_name = feature_cols[feat_idx]
        thresh = node['split_condition']
        print(f"  {'  '*depth}if {feat_name} < {thresh:.2f}:")
        if 'children' in node:
            extract_rules(node['children'][0], depth+1)
            print(f"  {'  '*depth}else:")
            extract_rules(node['children'][1], depth+1)

    extract_rules(first_tree)

# ---- Export feature list for Node.js ----
with open('data/ml-features.json', 'w') as f:
    json.dump({
        'features': feature_cols,
        'description': 'Feature names in order, matching XGBoost model input',
    }, f, indent=2)
print(f"\nFeature list saved to data/ml-features.json")
print(f"\nDone! Use the model in Node.js with xgboost-node or implement the top rules manually.")
