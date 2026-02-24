'use client';

import { formatCurrency, formatPct, formatET, formatContract, pnlColor, cn } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

export function TradeLog({ trades }) {
  if (!trades?.length) {
    return (
      <Card title="Trade Log">
        <p className="text-[var(--muted)] text-sm py-4 text-center">No trades today</p>
      </Card>
    );
  }

  // Only show closed trades + current open (skip duplicates from state transitions)
  const shown = trades.filter(t => t.exit_reason || t.state === 'IN_CALLS' || t.state === 'IN_PUTS' || t.state === 'PENDING');
  // Dedupe by id (keep first occurrence)
  const unique = [];
  const seen = new Set();
  for (const t of shown) {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      unique.push(t);
    }
  }

  return (
    <Card title="Trade Log">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Trade</th>
              <th className="text-right py-2 pr-3">Entry SPX</th>
              <th className="text-right py-2 pr-3">Exit SPX</th>
              <th className="text-right py-2 pr-3">P&L</th>
              <th className="text-left py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {unique.map((t) => {
              const spxChange = t.exit_spx && t.entry_spx
                ? (t.direction === 'BULLISH' ? t.exit_spx - t.entry_spx : t.entry_spx - t.exit_spx)
                : null;

              return (
                <tr key={t.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/20">
                  <td className="py-2 pr-3 font-mono text-xs">{formatET(t.opened_at)}</td>
                  <td className="py-2 pr-3 text-xs">
                    <span className="font-medium">{formatContract(t.contract)}</span>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono">{formatCurrency(t.entry_spx, 0)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{t.exit_spx ? formatCurrency(t.exit_spx, 0) : '—'}</td>
                  <td className={cn('py-2 pr-3 text-right font-mono font-medium', pnlColor(spxChange))}>
                    {spxChange != null ? `${spxChange > 0 ? '+' : ''}${spxChange.toFixed(1)} pts` : '—'}
                  </td>
                  <td className="py-2 text-xs text-[var(--muted)]">{t.exit_reason || t.state}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
