'use client';

import { formatCurrency, formatET, formatContract, pnlColor, cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';

export function PhantomAlertsFeed({ phantoms }) {
  if (!phantoms?.length) {
    return (
      <p className="text-[var(--muted)] text-sm py-8 text-center">No phantom trades today</p>
    );
  }

  return (
    <div className="space-y-3">
      {phantoms.map((p) => {
        const isOpen = !p.exit_reason;
        const spxChange = p.exit_spx && p.entry_spx
          ? (p.direction === 'BULLISH' ? p.exit_spx - p.entry_spx : p.entry_spx - p.exit_spx)
          : null;
        const laneLabel = p.strategy_lane === 'A' ? 'GEX-ONLY' : p.strategy_lane === 'B' ? 'GEX+TV' : 'Unknown';
        const laneColor = p.strategy_lane === 'A' ? 'bg-blue-500/20 text-blue-300' : 'bg-purple-500/20 text-purple-300';
        const triggerLabel = p.entry_trigger ? p.entry_trigger.replace(/_/g, ' ') : null;

        return (
          <div key={p.id} className={cn(
            'rounded-lg border p-3 space-y-2',
            isOpen
              ? 'border-yellow-500/30 bg-yellow-500/5'
              : spxChange > 0
                ? 'border-green-500/20 bg-[var(--surface)]'
                : 'border-red-500/20 bg-[var(--surface)]'
          )}>
            {/* Header: direction + lane + trigger */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Badge label={p.direction || 'NEUTRAL'} />
                <span className={cn('text-xs px-1.5 py-0.5 rounded font-medium', laneColor)}>
                  {laneLabel}
                </span>
                {triggerLabel && (
                  <span className="text-xs text-[var(--muted)]">{triggerLabel}</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {isOpen && (
                  <span className="inline-flex items-center gap-1 text-xs text-yellow-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                    Open
                  </span>
                )}
                <span className="text-xs text-[var(--muted)]">{formatET(p.opened_at)}</span>
              </div>
            </div>

            {/* Contract + SPX levels */}
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm">{formatContract(p.contract)}</span>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-[var(--muted)]">
                  Entry <span className="font-mono text-white">{formatCurrency(p.entry_spx, 0)}</span>
                </span>
                {p.exit_spx && (
                  <span className="text-[var(--muted)]">
                    Exit <span className="font-mono text-white">{formatCurrency(p.exit_spx, 0)}</span>
                  </span>
                )}
              </div>
            </div>

            {/* Result row */}
            {(spxChange != null || p.exit_reason) && (
              <div className="flex items-center justify-between pt-1 border-t border-[var(--border)]/50">
                {spxChange != null && (
                  <span className={cn('font-mono font-medium text-sm', pnlColor(spxChange))}>
                    {spxChange > 0 ? '+' : ''}{spxChange.toFixed(1)} pts
                  </span>
                )}
                {p.exit_reason && (
                  <span className="text-xs text-[var(--muted)]">{p.exit_reason}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
