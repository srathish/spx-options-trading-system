"""
GEX Intraday Feature Extractor — 7-Day Research System

Extracts rich per-frame features from GEX replay data.
Intentionally comprehensive — we'll prune later.

Output: research/features.parquet (one row per minute per day)
"""

import json
import os
import numpy as np
import pandas as pd
from collections import defaultdict
from pathlib import Path

RESEARCH_DAYS = [
    'data/gex-replay-2026-02-06.json',  # +140 rally
    'data/gex-replay-2026-03-20.json',  # -116 selloff
    'data/gex-replay-2026-02-23.json',  # -73 selloff
    'data/gex-replay-2026-01-14.json',  # -38 moderate
    'data/gex-replay-2026-02-11.json',  # +3 chop
    'data/gex-replay-2026-03-12.json',  # -104 selloff
    'data/gex-replay-2026-02-05.json',  # -86 selloff
]

def parse_frame(frame_data):
    """Extract spot + per-strike gamma from a single frame."""
    spot = frame_data.get('spotPrice', 0)
    strikes = frame_data.get('strikes', [])
    gamma = frame_data.get('gammaValues', {})

    # gammaValues can be:
    # - dict {strike: value}
    # - list of scalars [val, val, ...]
    # - list of lists [[exp1, exp2, ...], ...] (per-strike, per-expiration)
    strike_gamma = {}
    if isinstance(gamma, dict):
        for s, v in gamma.items():
            strike_gamma[float(s)] = float(v) if isinstance(v, (int, float)) else 0
    elif isinstance(gamma, list) and len(gamma) == len(strikes):
        for s, v in zip(strikes, gamma):
            if isinstance(v, list):
                # Sum across expirations, take first (0DTE) or sum all
                strike_gamma[float(s)] = float(v[0]) if v else 0
            elif isinstance(v, (int, float)):
                strike_gamma[float(s)] = float(v)
            else:
                strike_gamma[float(s)] = 0

    return spot, strike_gamma

def compute_features(date_str, frames, is_trinity):
    """Process all frames for one day, return list of feature dicts."""

    # Full-day strike memory: strike → list of (frame_idx, value)
    strike_memory = defaultdict(list)

    rows = []
    open_price = None
    hod, lod = -1e9, 1e9
    prices = []  # all spot prices for technicals

    for i, frame in enumerate(frames):
        spxw = frame.get('tickers', {}).get('SPXW', frame) if is_trinity else frame
        spot, strike_gamma = parse_frame(spxw)
        if not spot or spot <= 0:
            continue

        if open_price is None:
            open_price = spot
        if spot > hod: hod = spot
        if spot < lod: lod = spot
        prices.append(spot)

        minute_of_day = 570 + i  # 9:30 + frame index

        # ---- Update strike memory ----
        for strike, gex in strike_gamma.items():
            if abs(strike - spot) <= 150:
                strike_memory[strike].append((i, abs(gex)))

        # ---- Find key nodes ----
        # Nearest significant node ABOVE spot
        # Nearest significant node BELOW spot
        # King node (biggest absolute)
        nodes_above = []
        nodes_below = []
        king = None
        king_abs = 0
        total_pos_above = 0
        total_pos_below = 0
        total_neg_above = 0
        total_neg_below = 0
        total_abs = 0

        for strike, gex in strike_gamma.items():
            abs_gex = abs(gex)
            total_abs += abs_gex
            dist = strike - spot

            if abs(dist) > 100:
                continue

            if abs_gex > king_abs:
                king = {'strike': strike, 'value': gex, 'abs': abs_gex, 'dist': dist}
                king_abs = abs_gex

            if abs_gex >= 3_000_000:  # significant node
                node = {'strike': strike, 'value': gex, 'abs': abs_gex, 'dist': dist, 'is_pos': gex > 0}
                if dist > 5:
                    nodes_above.append(node)
                elif dist < -5:
                    nodes_below.append(node)

            if gex > 0:
                if strike > spot: total_pos_above += gex
                else: total_pos_below += gex
            else:
                if strike > spot: total_neg_above += abs(gex)
                else: total_neg_below += abs(gex)

        nodes_above.sort(key=lambda n: n['abs'], reverse=True)
        nodes_below.sort(key=lambda n: n['abs'], reverse=True)

        nearest_above = nodes_above[0] if nodes_above else None
        nearest_below = nodes_below[0] if nodes_below else None

        # ---- Node growth rates (5m, 15m, 30m, 60m) ----
        def node_growth(strike, lookback_frames):
            hist = strike_memory.get(strike, [])
            if len(hist) < lookback_frames + 1:
                return 0, 0, 0  # growth_abs, growth_pct, current_val
            current = hist[-1][1]
            past = hist[-(lookback_frames + 1)][1]
            growth = current - past
            pct = growth / past if past > 0 else 0
            return growth, pct, current

        above_growth_5, above_pct_5, _ = node_growth(nearest_above['strike'], 5) if nearest_above else (0, 0, 0)
        above_growth_15, above_pct_15, _ = node_growth(nearest_above['strike'], 15) if nearest_above else (0, 0, 0)
        above_growth_30, above_pct_30, _ = node_growth(nearest_above['strike'], 30) if nearest_above else (0, 0, 0)
        above_growth_60, above_pct_60, _ = node_growth(nearest_above['strike'], 60) if nearest_above else (0, 0, 0)

        below_growth_5, below_pct_5, _ = node_growth(nearest_below['strike'], 5) if nearest_below else (0, 0, 0)
        below_growth_15, below_pct_15, _ = node_growth(nearest_below['strike'], 15) if nearest_below else (0, 0, 0)
        below_growth_30, below_pct_30, _ = node_growth(nearest_below['strike'], 30) if nearest_below else (0, 0, 0)
        below_growth_60, below_pct_60, _ = node_growth(nearest_below['strike'], 60) if nearest_below else (0, 0, 0)

        king_growth_5, king_pct_5, _ = node_growth(king['strike'], 5) if king else (0, 0, 0)
        king_growth_15, king_pct_15, _ = node_growth(king['strike'], 15) if king else (0, 0, 0)
        king_growth_30, king_pct_30, _ = node_growth(king['strike'], 30) if king else (0, 0, 0)

        # ---- New node detection ----
        # A node is "new" if it wasn't significant (>5M) 30 frames ago
        new_nodes_above = 0
        new_nodes_below = 0
        for node in (nodes_above[:5] + nodes_below[:5]):
            hist = strike_memory.get(node['strike'], [])
            if len(hist) >= 30:
                val_30_ago = hist[-30][1]
                if val_30_ago < 5_000_000 and node['abs'] >= 5_000_000:
                    if node['dist'] > 0: new_nodes_above += 1
                    else: new_nodes_below += 1

        # ---- Flow into nearby strikes ----
        # Sum of gamma growth in strikes within 20pts of spot (last 10 frames)
        nearby_flow = 0
        nearby_flow_up = 0  # flow into strikes above spot
        nearby_flow_down = 0  # flow into strikes below spot
        for strike, gex in strike_gamma.items():
            if abs(strike - spot) > 20:
                continue
            hist = strike_memory.get(strike, [])
            if len(hist) >= 10:
                growth = hist[-1][1] - hist[-10][1]
                nearby_flow += growth
                if strike > spot: nearby_flow_up += growth
                else: nearby_flow_down += growth

        # ---- Technicals from price ----
        day_move = spot - open_price
        day_range = hod - lod

        # VWAP approximation (time-weighted avg)
        vwap = np.mean(prices) if prices else spot
        price_vs_vwap = spot - vwap

        # Opening range (first 20 frames)
        or_high = max(prices[:20]) if len(prices) >= 20 else hod
        or_low = min(prices[:20]) if len(prices) >= 20 else lod
        above_or = 1 if spot > or_high else 0
        below_or = 1 if spot < or_low else 0

        # RSI(14)
        rsi = 50
        if len(prices) >= 15:
            gains, losses = 0, 0
            for k in range(max(1, len(prices)-14), len(prices)):
                ch = prices[k] - prices[k-1]
                if ch > 0: gains += ch
                else: losses -= ch
            rsi = 100 - (100 / (1 + (gains/14) / (losses/14 + 1e-9)))

        # Realized volatility (std of last 30 returns)
        realized_vol = 0
        if len(prices) >= 31:
            returns = [prices[k] - prices[k-1] for k in range(max(1, len(prices)-30), len(prices))]
            realized_vol = np.std(returns) if returns else 0

        # Price momentum
        mom_5 = prices[-1] - prices[-5] if len(prices) >= 5 else 0
        mom_15 = prices[-1] - prices[-15] if len(prices) >= 15 else 0
        mom_30 = prices[-1] - prices[-30] if len(prices) >= 30 else 0

        # ---- Gamma regime ----
        net_gex = total_pos_above + total_pos_below - total_neg_above - total_neg_below
        regime = 'POSITIVE' if net_gex >= 0 else 'NEGATIVE'
        squeeze_up = total_pos_above > total_neg_below * 2 and total_pos_above >= 20_000_000
        squeeze_down = total_pos_below > total_neg_above * 2 and total_pos_below >= 20_000_000

        # ---- Concentration ----
        sorted_nodes = sorted(strike_gamma.items(), key=lambda x: abs(x[1]), reverse=True)
        top3_abs = sum(abs(v) for _, v in sorted_nodes[:3])
        concentration = top3_abs / total_abs if total_abs > 0 else 0

        # ---- Build row ----
        row = {
            'date': date_str,
            'frame': i,
            'minute_of_day': minute_of_day,
            'spot': spot,
            'open_price': open_price,
            'day_move': day_move,
            'day_range': day_range,
            'hod': hod,
            'lod': lod,
            'dist_from_hod': spot - hod,
            'dist_from_lod': spot - lod,

            # King node
            'king_strike': king['strike'] if king else 0,
            'king_value': king['value'] if king else 0,
            'king_abs': king['abs'] if king else 0,
            'king_dist': king['dist'] if king else 0,
            'king_is_positive': 1 if king and king['value'] > 0 else 0,
            'king_growth_5m': king_growth_5,
            'king_growth_15m': king_growth_15,
            'king_growth_30m': king_growth_30,
            'king_pct_5m': king_pct_5,
            'king_pct_15m': king_pct_15,
            'king_pct_30m': king_pct_30,

            # Nearest node above
            'above_strike': nearest_above['strike'] if nearest_above else 0,
            'above_value': nearest_above['value'] if nearest_above else 0,
            'above_abs': nearest_above['abs'] if nearest_above else 0,
            'above_dist': nearest_above['dist'] if nearest_above else 0,
            'above_is_positive': 1 if nearest_above and nearest_above['is_pos'] else 0,
            'above_growth_5m': above_growth_5,
            'above_growth_15m': above_growth_15,
            'above_growth_30m': above_growth_30,
            'above_growth_60m': above_growth_60,
            'above_pct_5m': above_pct_5,
            'above_pct_15m': above_pct_15,
            'above_pct_30m': above_pct_30,

            # Nearest node below
            'below_strike': nearest_below['strike'] if nearest_below else 0,
            'below_value': nearest_below['value'] if nearest_below else 0,
            'below_abs': nearest_below['abs'] if nearest_below else 0,
            'below_dist': nearest_below['dist'] if nearest_below else 0,
            'below_is_positive': 1 if nearest_below and nearest_below['is_pos'] else 0,
            'below_growth_5m': below_growth_5,
            'below_growth_15m': below_growth_15,
            'below_growth_30m': below_growth_30,
            'below_growth_60m': below_growth_60,
            'below_pct_5m': below_pct_5,
            'below_pct_15m': below_pct_15,
            'below_pct_30m': below_pct_30,

            # Node structure
            'new_nodes_above': new_nodes_above,
            'new_nodes_below': new_nodes_below,
            'n_significant_above': len(nodes_above),
            'n_significant_below': len(nodes_below),
            'nearby_flow': nearby_flow,
            'nearby_flow_up': nearby_flow_up,
            'nearby_flow_down': nearby_flow_down,

            # Gamma regime
            'net_gex': net_gex,
            'pos_above': total_pos_above,
            'pos_below': total_pos_below,
            'neg_above': total_neg_above,
            'neg_below': total_neg_below,
            'regime_positive': 1 if net_gex >= 0 else 0,
            'squeeze_up': 1 if squeeze_up else 0,
            'squeeze_down': 1 if squeeze_down else 0,
            'concentration': concentration,

            # Technicals
            'price_vs_vwap': price_vs_vwap,
            'above_opening_range': above_or,
            'below_opening_range': below_or,
            'rsi_14': rsi,
            'realized_vol': realized_vol,
            'mom_5m': mom_5,
            'mom_15m': mom_15,
            'mom_30m': mom_30,
        }

        rows.append(row)

    return rows

def main():
    all_rows = []

    for filepath in RESEARCH_DAYS:
        if not os.path.exists(filepath):
            print(f'SKIP: {filepath} not found')
            continue

        print(f'Processing {filepath}...')
        data = json.load(open(filepath))
        date_str = data.get('metadata', {}).get('date', filepath.split('/')[-1].replace('gex-replay-', '').replace('.json', ''))
        is_trinity = data.get('metadata', {}).get('mode') == 'trinity'

        rows = compute_features(date_str, data['frames'], is_trinity)
        all_rows.extend(rows)
        print(f'  {len(rows)} frames')

    df = pd.DataFrame(all_rows)

    # Save
    os.makedirs('research', exist_ok=True)
    df.to_csv('research/features.csv', index=False)
    print(f'\nSaved {len(df)} rows to research/features.csv')
    print(f'Columns: {len(df.columns)}')
    print(f'Days: {df["date"].nunique()}')
    print(f'\nFeature columns:')
    for col in df.columns:
        print(f'  {col}')

if __name__ == '__main__':
    main()
