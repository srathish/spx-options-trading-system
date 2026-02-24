'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { formatCurrency, formatPct, cn } from '../../lib/utils';

const BANNER_STYLES = {
  ENTER_CALLS: 'bg-green-600/20 border-green-500/40 text-green-300',
  ENTER_PUTS: 'bg-red-600/20 border-red-500/40 text-red-300',
  IN_CALLS: 'bg-green-900/30 border-green-700/40 text-green-400',
  IN_PUTS: 'bg-red-900/30 border-red-700/40 text-red-400',
  EXIT: 'bg-yellow-600/20 border-yellow-500/40 text-yellow-300',
  EXIT_CALLS: 'bg-yellow-600/20 border-yellow-500/40 text-yellow-300',
  EXIT_PUTS: 'bg-yellow-600/20 border-yellow-500/40 text-yellow-300',
  WAIT: 'bg-[var(--surface)] border-[var(--border)] text-[var(--muted)]',
};

function getActionLabel(action, posState) {
  if (posState === 'IN_CALLS') return action?.startsWith('EXIT') ? 'EXIT CALLS' : 'STAY IN CALLS';
  if (posState === 'IN_PUTS') return action?.startsWith('EXIT') ? 'EXIT PUTS' : 'STAY IN PUTS';
  if (action === 'ENTER_CALLS') return 'BUY CALLS';
  if (action === 'ENTER_PUTS') return 'BUY PUTS';
  return 'WAIT';
}

function getBannerKey(action, posState) {
  if (posState === 'IN_CALLS' && !action?.startsWith('EXIT')) return 'IN_CALLS';
  if (posState === 'IN_PUTS' && !action?.startsWith('EXIT')) return 'IN_PUTS';
  return action || 'WAIT';
}

export function SignalBanner() {
  const { decision, position, gex } = useTradingContext();
  const action = decision?.action || decision?.lastDecision?.action || 'WAIT';
  const posState = position?.state || 'FLAT';
  const pos = position?.details;

  const bannerKey = getBannerKey(action, posState);
  const style = BANNER_STYLES[bannerKey] || BANNER_STYLES.WAIT;
  const label = getActionLabel(action, posState);

  return (
    <div className={cn('rounded-lg border px-4 py-3 flex items-center justify-between', style)}>
      <div className="flex items-center gap-4">
        <span className="text-lg font-bold tracking-wide">{label}</span>
        {pos?.contract && (
          <span className="font-mono text-sm opacity-80">{pos.contract}</span>
        )}
        {decision?.confidence && (
          <span className="text-xs opacity-60">Confidence: {decision.confidence}</span>
        )}
        {decision?.marketMode?.isChop && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 font-medium">CHOP</span>
        )}
      </div>

      <div className="flex items-center gap-4 text-sm">
        {pos?.currentPnlPct != null && posState !== 'FLAT' && (
          <span className={cn('font-mono font-medium', pos.currentPnlPct >= 0 ? 'text-green-400' : 'text-red-400')}>
            {formatPct(pos.currentPnlPct)}
          </span>
        )}
        {gex && (
          <span className="opacity-60">
            GEX {gex.score}/100 {gex.direction}
          </span>
        )}
      </div>
    </div>
  );
}
