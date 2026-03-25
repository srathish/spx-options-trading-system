# GEX Intraday Research System

Intentionally overfit on 7 days to learn which features matter.

## 7 Research Days
1. Feb 6 (+140) — massive rally, positive nodes building higher all day
2. Mar 20 (-116) — massive selloff, negative magnet pulling down
3. Feb 23 (-73) — morning selloff, afternoon bounce
4. Jan 14 (-38) — moderate selloff with whipsaws
5. Feb 11 (+3) — chop day, no clear direction
6. Mar 12 (-104) — violent selloff
7. Feb 5 (-86) — DeepSeek shock selloff

## Workflow
1. `python research/extract_features.py` — build feature dataset
2. `python research/label_trades.py` — label optimal trades
3. `python research/overfit_rules.py` — find rules that explain all 7 days
4. Manual inspection of each day's GEX chart
5. Pattern validation on additional days
