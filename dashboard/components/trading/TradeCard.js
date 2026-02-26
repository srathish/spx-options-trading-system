'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { ProgressBar } from '../ui/ProgressBar';
import { formatCurrency, formatPct, formatContract, cn, pnlColor } from '../../lib/utils';

function timeAgo(timestamp) {
  if (!timestamp) return '';
  const ms = Date.now() - timestamp;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m ago`;
}

export function TradeCard() {
  const { position, decision, gex, lastTrade } = useTradingContext();
  const posState = position?.state || 'FLAT';
  const pos = position?.details;
  const action = decision?.action || decision?.lastDecision?.action || 'WAIT';

  // FLAT + WAIT — show last trade if available
  if (posState === 'FLAT' && !action?.startsWith('ENTER')) {
    if (lastTrade) {
      return (
        <Card title="Last Trade">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium text-sm">{formatContract(lastTrade.contract)}</span>
                <Badge label={lastTrade.direction} />
              </div>
              <div className="flex items-center gap-2">
                <Badge label={lastTrade.exitReason || lastTrade.exit_reason} />
                <span className="text-xs text-[var(--muted)]">{timeAgo(lastTrade.closedAt)}</span>
              </div>
            </div>

            <div className="flex items-center gap-4">
              <span className={cn('text-2xl font-bold font-mono', pnlColor(lastTrade.spxChange))}>
                {lastTrade.spxChange > 0 ? '+' : ''}{Number(lastTrade.spxChange).toFixed(1)} pts
              </span>
              <Badge label={lastTrade.isWin ? 'WIN' : 'LOSS'} />
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <span className="text-[var(--muted)]">Entry SPX</span>
                <p className="font-mono">{formatCurrency(lastTrade.entrySpx, 0)}</p>
              </div>
              <div>
                <span className="text-[var(--muted)]">Exit SPX</span>
                <p className="font-mono">{formatCurrency(lastTrade.exitSpx, 0)}</p>
              </div>
            </div>
          </div>
        </Card>
      );
    }

    return (
      <Card title="Position">
        <div className="flex items-center justify-center py-8">
          <span className="text-[var(--muted)] text-sm">Waiting for setup...</span>
        </div>
      </Card>
    );
  }

  // FLAT + ENTER signal (proposed trade — may be blocked by guardrails)
  if (posState === 'FLAT' && action?.startsWith('ENTER')) {
    const blocked = decision?.entryBlocked;
    return (
      <Card title={blocked ? 'Entry Blocked' : 'Trade Proposal'}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Badge label={action === 'ENTER_CALLS' ? 'BULLISH' : 'BEARISH'} />
            <span className="text-sm">{blocked ? 'Signal blocked by guardrails' : 'Signal detected'}</span>
          </div>
          <p className="text-xs text-[var(--muted)]">
            {blocked ? blocked.reason : 'Evaluating entry...'}
          </p>
        </div>
      </Card>
    );
  }

  // IN_CALLS or IN_PUTS — active position
  if (pos) {
    const pnlPct = pos.currentPnlPct || 0;
    const spotPrice = gex?.spotPrice || 0;

    // Calculate target progress — guard against entry ≈ target (< 2pts apart)
    let targetProgress = 0;
    if (pos.entrySpx && pos.targetSpx && spotPrice) {
      const totalMove = Math.abs(pos.targetSpx - pos.entrySpx);
      if (totalMove >= 2) {
        const currentMove = pos.direction === 'BULLISH'
          ? spotPrice - pos.entrySpx
          : pos.entrySpx - spotPrice;
        targetProgress = Math.max(-100, Math.min(200, (currentMove / totalMove) * 100));
      }
    }

    return (
      <Card title="Active Position">
        <div className="space-y-3">
          {/* Contract + state + lane/trigger */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{formatContract(pos.contract)}</span>
              {pos.strategyLane && (
                <span className={cn('text-xs font-medium px-1.5 py-0.5 rounded',
                  pos.strategyLane === 'A' ? 'bg-blue-500/20 text-blue-400' : 'bg-purple-500/20 text-purple-400'
                )}>Lane {pos.strategyLane}</span>
              )}
            </div>
            <Badge label={posState} />
          </div>
          {pos.entryTrigger && (
            <div className="text-xs text-[var(--muted)]">
              Trigger: {pos.entryTrigger.replace(/_/g, ' ')}
            </div>
          )}

          {/* P&L in SPX points */}
          <div className="flex items-center gap-4">
            {pos.entrySpx && spotPrice ? (() => {
              const spxPts = pos.direction === 'BULLISH'
                ? spotPrice - pos.entrySpx
                : pos.entrySpx - spotPrice;
              return (
                <span className={cn('text-2xl font-bold font-mono', pnlColor(spxPts))}>
                  {spxPts > 0 ? '+' : ''}{spxPts.toFixed(1)} pts
                </span>
              );
            })() : (
              <span className="text-2xl font-bold font-mono text-gray-400">—</span>
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
