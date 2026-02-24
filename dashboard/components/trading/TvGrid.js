'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';

const INDICATOR_LABELS = { echo: 'Echo', bravo: 'Bravo', tango: 'Tango' };
const INDICATOR_ORDER = ['echo', 'bravo', 'tango'];
const TICKER_ORDER = ['spx', 'spy', 'qqq'];
const TF_ORDER = ['1', '3'];

function classColor(classification) {
  if (classification === 'BULLISH') return 'text-green-400';
  if (classification === 'BEARISH') return 'text-red-400';
  return 'text-gray-500';
}

function stateShort(state) {
  if (!state || state === 'NONE') return '—';
  return state;
}

function TickerSection({ ticker, signals }) {
  if (!signals || signals.length === 0) return null;

  // Group by indicator then timeframe
  const byInd = {};
  for (const sig of signals) {
    const ind = sig.indicatorName || sig.key?.split('_')[1] || 'unknown';
    if (!byInd[ind]) byInd[ind] = {};
    const tf = sig.timeframe || '3';
    byInd[ind][tf] = sig;
  }

  // Weighted scores
  let bullW = 0, bearW = 0;
  for (const sig of signals) {
    if (sig.classification === 'BULLISH') bullW += sig.weight || 0;
    if (sig.classification === 'BEARISH') bearW += sig.weight || 0;
  }
  const summaryColor = bullW > bearW ? 'text-green-400' : bearW > bullW ? 'text-red-400' : 'text-gray-500';

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-[var(--foreground)] uppercase tracking-wide">{ticker.toUpperCase()}</span>
        <span className={`text-xs font-mono ${summaryColor}`}>
          {bullW > 0 && `${bullW.toFixed(1)} BULL`}{bullW > 0 && bearW > 0 && ' / '}{bearW > 0 && `${bearW.toFixed(1)} BEAR`}
          {bullW === 0 && bearW === 0 && '—'}
        </span>
      </div>

      {/* Header row */}
      <div className="flex items-center text-[10px] text-[var(--muted)] mb-0.5">
        <span className="w-14" />
        <span className="w-16 text-center">1m</span>
        <span className="w-16 text-center">3m</span>
      </div>

      {INDICATOR_ORDER.map(ind => {
        if (!byInd[ind]) return null;
        return (
          <div key={ind} className="flex items-center py-0.5">
            <span className="text-[var(--muted)] w-14 text-xs">{INDICATOR_LABELS[ind]}</span>
            {TF_ORDER.map(tf => {
              const sig = byInd[ind]?.[tf];
              if (!sig) return <span key={tf} className="w-16 text-center text-xs text-gray-600">—</span>;
              return (
                <span key={tf} className={`w-16 text-center text-xs font-mono ${classColor(sig.classification)}`}>
                  {stateShort(sig.state)}
                  {sig.isStale && <span className="text-yellow-500 text-[9px] ml-0.5">S</span>}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function ConfidenceBadge({ confidence }) {
  if (!confidence || confidence === 'NONE') return null;
  const colors = {
    MASTER: 'bg-green-500/20 text-green-400 border-green-500/30',
    INTERMEDIATE: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    BEGINNER: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  };
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${colors[confidence] || ''}`}>
      {confidence}
    </span>
  );
}

function CrossMarketBar({ snapshot }) {
  const cross = snapshot?.cross_market;
  if (!cross) return null;

  const { bullish_tickers, bearish_tickers, total } = cross;
  const allBull = bullish_tickers === total;
  const allBear = bearish_tickers === total;

  return (
    <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
      <span className="text-xs text-[var(--muted)]">Cross-Market</span>
      <div className="flex gap-2 text-xs font-medium">
        <span className="text-green-400">{bullish_tickers}/{total} BULL</span>
        <span className="text-[var(--muted)]">|</span>
        <span className="text-red-400">{bearish_tickers}/{total} BEAR</span>
        {allBull && <span className="text-green-300 ml-1">ALIGNED</span>}
        {allBear && <span className="text-red-300 ml-1">ALIGNED</span>}
      </div>
    </div>
  );
}

export function TvGrid() {
  const { tv } = useTradingContext();
  const snapshot = tv?.snapshot;
  const detailed = tv?.detailed;

  if (!snapshot) {
    return (
      <Card title="TV Confirmation">
        <p className="text-[var(--muted)] text-sm">Waiting for TV signals...</p>
      </Card>
    );
  }

  // Group detailed signals by ticker
  const byTicker = {};
  if (detailed) {
    for (const sig of detailed) {
      const tkr = sig.ticker || 'spx';
      if (!byTicker[tkr]) byTicker[tkr] = [];
      byTicker[tkr].push(sig);
    }
  }

  return (
    <Card title="TV Confirmation">
      <div className="space-y-3">
        {/* Confidence + alignment header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ConfidenceBadge confidence={snapshot.confidence} />
            {snapshot.alignment?.direction && (
              <span className="text-xs text-[var(--muted)]">
                {snapshot.alignment.count}/{snapshot.alignment.total} 3m {snapshot.alignment.direction}
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--muted)]">
            {snapshot.stale_count > 0 && <span className="text-yellow-500">{snapshot.stale_count} stale</span>}
          </div>
        </div>

        {/* Per-ticker signal grids */}
        {TICKER_ORDER.map(tkr => (
          <TickerSection key={tkr} ticker={tkr} signals={byTicker[tkr]} />
        ))}

        {/* Cross-market summary */}
        <CrossMarketBar snapshot={snapshot} />
      </div>
    </Card>
  );
}
