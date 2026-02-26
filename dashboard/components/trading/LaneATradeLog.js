'use client';

import { formatCurrency, formatET, formatContract, pnlColor, cn } from '../../lib/utils';
import { Card } from '../ui/Card';

export function LaneATradeLog({ trades }) {
  const laneA = (trades || []).filter(t => t.strategy_lane === 'A');

  if (!laneA.length) {
    return (
      <Card title="Lane A Trades">
        <p className="text-[var(--muted)] text-sm py-4 text-center">No Lane A trades today</p>
      </Card>
    );
  }

  return (
    <Card title={`Lane A Trades (${laneA.length})`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Contract</th>
              <th className="text-left py-2 pr-3">Trigger</th>
              <th className="text-right py-2 pr-3">Entry SPX</th>
              <th className="text-right py-2 pr-3">Exit SPX</th>
              <th className="text-right py-2 pr-3">P&L</th>
              <th className="text-left py-2">Exit Reason</th>
            </tr>
          </thead>
          <tbody>
            {laneA.map((t) => {
              const spxChange = t.exit_spx && t.entry_spx
                ? (t.direction === 'BULLISH' ? t.exit_spx - t.entry_spx : t.entry_spx - t.exit_spx)
                : null;
              const isOpen = !t.exit_reason;
              const triggerLabel = t.entry_trigger ? t.entry_trigger.replace(/_/g, ' ') : '—';

              return (
                <tr key={t.id} className={cn(
                  'border-b border-[var(--border)]/50',
                  isOpen ? 'bg-green-500/5' : 'hover:bg-[var(--border)]/20'
                )}>
                  <td className="py-2 pr-3 font-mono text-xs">{formatET(t.opened_at)}</td>
                  <td className="py-2 pr-3 text-xs font-medium">{formatContract(t.contract)}</td>
                  <td className="py-2 pr-3 text-xs text-[var(--muted)]">{triggerLabel}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatCurrency(t.entry_spx, 0)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.exit_spx ? formatCurrency(t.exit_spx, 0) : '—'}</td>
                  <td className={cn('py-2 pr-3 text-right font-mono font-medium', pnlColor(spxChange))}>
                    {spxChange != null ? `${spxChange > 0 ? '+' : ''}${spxChange.toFixed(1)} pts` : isOpen ? (
                      <span className="text-yellow-400">OPEN</span>
                    ) : '—'}
                  </td>
                  <td className="py-2 text-xs text-[var(--muted)]">{t.exit_reason || (
                    <span className="inline-flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                      Active
                    </span>
                  )}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
