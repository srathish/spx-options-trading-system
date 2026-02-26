'use client';

import { formatCurrency, formatET, formatContract, pnlColor, cn } from '../../lib/utils';

export function PhantomAlertsTable({ phantoms }) {
  if (!phantoms?.length) {
    return (
      <p className="text-[var(--muted)] text-sm py-8 text-center">No phantom trades today</p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
            <th className="text-left py-2 pr-3">Time</th>
            <th className="text-left py-2 pr-3">Lane</th>
            <th className="text-left py-2 pr-3">Trigger</th>
            <th className="text-left py-2 pr-3">Direction</th>
            <th className="text-right py-2 pr-3">Entry SPX</th>
            <th className="text-right py-2 pr-3">Exit SPX</th>
            <th className="text-right py-2 pr-3">P&L</th>
            <th className="text-left py-2 pr-3">Exit Reason</th>
            <th className="text-left py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {phantoms.map((p) => {
            const spxChange = p.exit_spx && p.entry_spx
              ? (p.direction === 'BULLISH' ? p.exit_spx - p.entry_spx : p.entry_spx - p.exit_spx)
              : null;
            const isOpen = !p.exit_reason;
            const laneColor = p.strategy_lane === 'A' ? 'text-blue-400' : p.strategy_lane === 'B' ? 'text-purple-400' : 'text-[var(--muted)]';
            const triggerLabel = p.entry_trigger ? p.entry_trigger.replace(/_/g, ' ') : '—';

            return (
              <tr key={p.id} className={cn(
                'border-b border-[var(--border)]/50',
                isOpen ? 'bg-yellow-500/5' : 'hover:bg-[var(--border)]/20'
              )}>
                <td className="py-2 pr-3 font-mono text-xs">{formatET(p.opened_at)}</td>
                <td className={cn('py-2 pr-3 text-xs font-medium', laneColor)}>
                  {p.strategy_lane || '—'}
                </td>
                <td className="py-2 pr-3 text-xs text-[var(--muted)]">{triggerLabel}</td>
                <td className="py-2 pr-3 text-xs">
                  <span className={p.direction === 'BULLISH' ? 'text-green-400' : 'text-red-400'}>
                    {p.direction || '—'}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right font-mono">{formatCurrency(p.entry_spx, 0)}</td>
                <td className="py-2 pr-3 text-right font-mono">{p.exit_spx ? formatCurrency(p.exit_spx, 0) : '—'}</td>
                <td className={cn('py-2 pr-3 text-right font-mono font-medium', pnlColor(spxChange))}>
                  {spxChange != null ? `${spxChange > 0 ? '+' : ''}${spxChange.toFixed(1)} pts` : '—'}
                </td>
                <td className="py-2 pr-3 text-xs text-[var(--muted)]">{p.exit_reason || '—'}</td>
                <td className="py-2 text-xs">
                  {isOpen ? (
                    <span className="inline-flex items-center gap-1 text-yellow-400">
                      <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                      Open
                    </span>
                  ) : (
                    <span className={spxChange > 0 ? 'text-green-400' : 'text-red-400'}>
                      {spxChange > 0 ? 'WIN' : 'LOSS'}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
