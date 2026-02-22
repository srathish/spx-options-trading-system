'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { ProgressBar } from '../ui/ProgressBar';
import { formatCurrency, formatPct, cn, pnlColor } from '../../lib/utils';

export function TradeCard() {
  const { position, decision, gex } = useTradingContext();
  const posState = position?.state || 'FLAT';
  const pos = position?.details;
  const action = decision?.action || decision?.lastDecision?.action || 'WAIT';

  // FLAT + WAIT
  if (posState === 'FLAT' && !action?.startsWith('ENTER')) {
    return (
      <Card title="Position">
        <div className="flex items-center justify-center py-8">
          <span className="text-[var(--muted)] text-sm">Waiting for setup...</span>
        </div>
      </Card>
    );
  }

  // FLAT + ENTER signal (proposed trade)
  if (posState === 'FLAT' && action?.startsWith('ENTER')) {
    return (
      <Card title="Trade Proposal">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge label={action === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH'} />
            <span className="text-sm">Signal detected</span>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Awaiting Polygon chain data for strike selection...
          </p>
        </div>
      </Card>
    );
  }

  // IN_CALLS or IN_PUTS — active position
  if (pos) {
    const pnlPct = pos.currentPnlPct || 0;
    const spotPrice = gex?.spotPrice || 0;

    // Calculate target progress
    let targetProgress = 0;
    if (pos.entrySpx && pos.targetSpx && spotPrice) {
      const totalMove = Math.abs(pos.targetSpx - pos.entrySpx);
      const currentMove = pos.direction === 'BULLISH'
        ? spotPrice - pos.entrySpx
        : pos.entrySpx - spotPrice;
      targetProgress = totalMove > 0 ? (currentMove / totalMove) * 100 : 0;
    }

    return (
      <Card title="Active Position">
        <div className="space-y-3">
          {/* Contract + state */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm">{pos.contract}</span>
            <Badge label={posState} />
          </div>

          {/* P&L */}
          <div className="flex items-center gap-4">
            <span className={cn('text-2xl font-bold font-mono', pnlColor(pnlPct))}>
              {formatPct(pnlPct)}
            </span>
            {pos.entryPrice && (
              <span className="text-xs text-[var(--muted)]">
                Entry: {formatCurrency(pos.entryPrice)}
              </span>
            )}
          </div>

          {/* SPX levels */}
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div>
              <span className="text-[var(--muted)]">Entry SPX</span>
              <p className="font-mono">{formatCurrency(pos.entrySpx, 0)}</p>
            </div>
            <div>
              <span className="text-[var(--muted)]">Current SPX</span>
              <p className="font-mono">{formatCurrency(spotPrice, 0)}</p>
            </div>
            <div>
              <span className="text-[var(--muted)]">Target SPX</span>
              <p className="font-mono">{formatCurrency(pos.targetSpx, 0)}</p>
            </div>
          </div>

          {/* Target progress */}
          <div>
            <div className="flex justify-between text-xs text-[var(--muted)] mb-1">
              <span>Target progress</span>
              <span>{Math.round(targetProgress)}%</span>
            </div>
            <ProgressBar
              value={Math.max(targetProgress, 0)}
              color={targetProgress >= 0 ? 'bg-green-500' : 'bg-red-500'}
            />
          </div>

          {/* Stop */}
          {pos.stopSpx && (
            <div className="text-xs text-[var(--muted)]">
              Stop: {formatCurrency(pos.stopSpx, 0)} ({Math.abs(spotPrice - pos.stopSpx).toFixed(0)}pt away)
            </div>
          )}
        </div>
      </Card>
    );
  }

  // Fallback
  return (
    <Card title="Position">
      <Badge label={posState} />
    </Card>
  );
}
