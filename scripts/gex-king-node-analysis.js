/**
 * GEX King Node Analysis
 * Reads all replay files, computes features at entry time, correlates with outcomes.
 * Outputs CSV for Python analysis.
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';

const files = readdirSync('data').filter(f => f.startsWith('gex-replay-') && f.endsWith('.json')).sort();
console.error(`Found ${files.length} replay files`);

const rows = [];
const header = 'date,spx_open,spx_close,spx_move,abs_move,day_type,range,king_strike,king_value,king_value_M,king_dist,king_abs_dist,king_is_negative,king_pct_of_total,king_above_spot,regime,net_gex_near_M,gex_at_spot,gex_at_spot_M,total_abs_gamma_M,neg_gamma_pct,wall_count_above,wall_count_below,biggest_wall_above,biggest_wall_below,air_pocket_up,air_pocket_down,first30_move,first30_dir_matches_king,entry_dir,entry_spot';

// Multiple stop levels for multi-stop analysis
const stopLevels = [8, 12, 15, 18, 20, 25];

// Add stop-level columns to header
let fullHeader = header;
for (const sl of stopLevels) {
  fullHeader += `,result_s${sl},pnl_s${sl},mfe_s${sl},mae_s${sl}`;
}

rows.push(fullHeader);

for (const file of files) {
  try {
    const data = JSON.parse(readFileSync('data/' + file));
    const { metadata, frames } = data;
    const dateStr = metadata?.date || file.replace('gex-replay-', '').replace('.json', '');
    const isTrinity = metadata?.mode === 'trinity';

    let openPrice = 0, closePrice = 0, hod = -Infinity, lod = Infinity;
    let validFrameCount = 0;

    // Get open/close/range
    for (const frame of frames) {
      const spxw = isTrinity ? frame.tickers?.SPXW : frame;
      const spot = spxw?.spotPrice;
      if (!spot || spot < 100) continue;
      validFrameCount++;
      if (openPrice === 0) openPrice = spot;
      closePrice = spot;
      if (spot > hod) hod = spot;
      if (spot < lod) lod = spot;
    }

    if (openPrice === 0 || validFrameCount < 50) {
      console.error(`Skipping ${dateStr}: insufficient data (${validFrameCount} frames)`);
      continue;
    }

    const spxMove = closePrice - openPrice;
    const absMove = Math.abs(spxMove);
    const range = hod - lod;
    const dayType = absMove >= 50 ? 'BIG_TREND' : absMove >= 30 ? 'MODERATE' : 'CHOP';

    // Get king node at frame 20 (~9:50 ET, first possible entry)
    const entryFrame = frames[20];
    const spxw20 = isTrinity ? entryFrame?.tickers?.SPXW : entryFrame;
    if (!spxw20?.spotPrice || !spxw20?.gammaValues) {
      console.error(`Skipping ${dateStr}: no data at frame 20`);
      continue;
    }

    const spot = spxw20.spotPrice;
    const strikes = spxw20.strikes || [];
    const gammaValues = spxw20.gammaValues || [];

    // Parse gamma values (column 0 = 0DTE)
    const gexMap = new Map();
    for (let row = 0; row < strikes.length; row++) {
      const rowData = gammaValues[row];
      const val = (rowData && rowData[0]) || 0;
      gexMap.set(strikes[row], val);
    }

    // Find king node (largest absolute GEX within 200pts of spot)
    let kingStrike = null, kingValue = 0, kingAbsValue = 0, totalAbsGamma = 0;
    let totalGexNear = 0;
    let negGammaTotal = 0;

    for (const strike of strikes) {
      const gex = gexMap.get(strike) || 0;
      totalAbsGamma += Math.abs(gex);
      if (gex < 0) negGammaTotal += Math.abs(gex);

      if (Math.abs(strike - spot) < 80) {
        totalGexNear += gex;
      }

      if (Math.abs(gex) > kingAbsValue && Math.abs(strike - spot) < 200) {
        kingStrike = strike;
        kingValue = gex;
        kingAbsValue = Math.abs(gex);
      }
    }

    if (!kingStrike) {
      console.error(`Skipping ${dateStr}: no king node found`);
      continue;
    }

    const kingDist = kingStrike - spot;
    const kingAbsDist = Math.abs(kingDist);
    const kingPct = totalAbsGamma > 0 ? kingAbsValue / totalAbsGamma * 100 : 0;
    const negGammaPct = totalAbsGamma > 0 ? negGammaTotal / totalAbsGamma * 100 : 0;
    const regime = totalGexNear >= 0 ? 'POSITIVE' : 'NEGATIVE';

    // GEX at spot (interpolate)
    let gexAtSpot = 0;
    for (let i = 0; i < strikes.length - 1; i++) {
      if (strikes[i] <= spot && strikes[i + 1] >= spot) {
        const lower = gexMap.get(strikes[i]) || 0;
        const upper = gexMap.get(strikes[i + 1]) || 0;
        const weight = (spot - strikes[i]) / (strikes[i + 1] - strikes[i]);
        gexAtSpot = lower + (upper - lower) * weight;
        break;
      }
    }

    // Count walls above and below spot
    let wallCountAbove = 0, wallCountBelow = 0;
    let biggestAbove = 0, biggestBelow = 0;
    for (const strike of strikes) {
      const gex = gexMap.get(strike) || 0;
      const absGex = Math.abs(gex);
      if (absGex < 500000) continue; // min wall threshold
      if (strike > spot) {
        wallCountAbove++;
        if (absGex > biggestAbove) biggestAbove = absGex;
      } else if (strike < spot) {
        wallCountBelow++;
        if (absGex > biggestBelow) biggestBelow = absGex;
      }
    }

    // Air pocket analysis: count consecutive low-gamma strikes above and below spot
    let airPocketUp = 0, airPocketDown = 0;
    const noisePct = kingAbsValue * 0.05;

    // Air pocket above spot
    for (let i = 0; i < strikes.length; i++) {
      if (strikes[i] <= spot) continue;
      const gex = Math.abs(gexMap.get(strikes[i]) || 0);
      if (gex < noisePct) airPocketUp++;
      else break;
    }

    // Air pocket below spot
    for (let i = strikes.length - 1; i >= 0; i--) {
      if (strikes[i] >= spot) continue;
      const gex = Math.abs(gexMap.get(strikes[i]) || 0);
      if (gex < noisePct) airPocketDown++;
      else break;
    }

    // First 30 minutes move (frames 0-20 cover market open to ~9:50)
    // Actually frames go from ~9:30 to ~4:00. Frame 20 ≈ 9:50. Let's check frame 40 ≈ 10:10
    const frame40 = frames[40];
    const spxw40 = isTrinity ? frame40?.tickers?.SPXW : frame40;
    const first30Move = spxw40?.spotPrice ? spxw40.spotPrice - spot : 0;

    // Entry direction: towards the king node
    const entryDir = kingDist > 0 ? 'BULLISH' : 'BEARISH';
    const isBull = entryDir === 'BULLISH';
    const first30DirMatches = (isBull && first30Move > 0) || (!isBull && first30Move < 0) ? 1 : 0;

    // Simulate trades with multiple stop levels
    const tradeResults = {};
    for (const sl of stopLevels) {
      let mfe = 0, mae = 0;
      let result = 'EOD_EXIT', pnl = 0;

      for (let i = 21; i < frames.length; i++) {
        const f = isTrinity ? frames[i]?.tickers?.SPXW : frames[i];
        const s = f?.spotPrice;
        if (!s || s < 100) continue;
        const progress = isBull ? s - spot : spot - s;
        if (progress > mfe) mfe = progress;
        if (progress < mae) mae = progress;

        // Target hit: price reaches king node (within 5 pts)
        if (isBull ? s >= kingStrike - 5 : s <= kingStrike + 5) {
          result = 'TARGET_HIT';
          pnl = Math.round(progress * 100) / 100;
          break;
        }
        // Trailing breakeven: if MFE >= 15 and comes back to entry
        if (mfe >= 15 && progress <= 0) {
          result = 'TRAIL_BE';
          pnl = 0;
          break;
        }
        // Fixed stop
        if (progress <= -sl) {
          result = 'STOP_HIT';
          pnl = -sl;
          break;
        }
      }

      // If EOD exit, compute final P&L
      if (result === 'EOD_EXIT') {
        const lastFrame = frames[frames.length - 1];
        const lastSpxw = isTrinity ? lastFrame?.tickers?.SPXW : lastFrame;
        const lastSpot = lastSpxw?.spotPrice || closePrice;
        pnl = Math.round((isBull ? lastSpot - spot : spot - lastSpot) * 100) / 100;
      }

      tradeResults[sl] = { result, pnl: Math.round(pnl * 100) / 100, mfe: Math.round(mfe * 10) / 10, mae: Math.round(mae * 10) / 10 };
    }

    // Build row
    let row = [
      dateStr,
      openPrice.toFixed(2),
      closePrice.toFixed(2),
      spxMove.toFixed(1),
      absMove.toFixed(1),
      dayType,
      range.toFixed(1),
      kingStrike,
      kingValue.toFixed(0),
      (kingValue / 1e6).toFixed(2),
      kingDist.toFixed(1),
      kingAbsDist.toFixed(1),
      kingValue < 0 ? 1 : 0,
      kingPct.toFixed(1),
      kingDist > 0 ? 1 : 0,
      regime,
      (totalGexNear / 1e6).toFixed(2),
      gexAtSpot.toFixed(0),
      (gexAtSpot / 1e6).toFixed(3),
      (totalAbsGamma / 1e6).toFixed(1),
      negGammaPct.toFixed(1),
      wallCountAbove,
      wallCountBelow,
      (biggestAbove / 1e6).toFixed(2),
      (biggestBelow / 1e6).toFixed(2),
      airPocketUp,
      airPocketDown,
      first30Move.toFixed(1),
      first30DirMatches,
      entryDir,
      spot.toFixed(2)
    ].join(',');

    for (const sl of stopLevels) {
      const t = tradeResults[sl];
      row += `,${t.result},${t.pnl},${t.mfe},${t.mae}`;
    }

    rows.push(row);
    console.error(`${dateStr}: ${dayType} | king=${kingStrike} (${(kingValue/1e6).toFixed(1)}M) dist=${kingDist.toFixed(0)} | ${entryDir} | s12: ${tradeResults[12].result} ${tradeResults[12].pnl}`);

  } catch (err) {
    console.error(`Error processing ${file}: ${err.message}`);
  }
}

const csv = rows.join('\n');
writeFileSync('data/king-node-analysis.csv', csv);
console.error(`\nWrote ${rows.length - 1} rows to data/king-node-analysis.csv`);
