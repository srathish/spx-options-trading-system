'use client';

import { formatCurrency, formatPct, formatET, pnlColor, cn } from '../../lib/utils';
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

  return (
    <Card title="Trade Log">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Contract</th>
              <th className="text-left py-2 pr-3">Direction</th>
              <th className="text-right py-2 pr-3">Entry</th>
              <th className="text-right py-2 pr-3">Exit</th>
              <th className="text-right py-2 pr-3">P&L</th>
              <th className="text-left py-2">Reason</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/20">
                <td className="py-2 pr-3 font-mono text-xs">{formatET(t.opened_at)}</td>
                <td className="py-2 pr-3 font-mono text-xs">{t.contract}</td>
                <td className="py-2 pr-3">
                  <Badge label={t.direction} />
                </td>
                <td className="py-2 pr-3 text-right font-mono">{formatCurrency(t.entry_price)}</td>
                <td className="py-2 pr-3 text-right font-mono">{t.exit_price ? formatCurrency(t.exit_price) : '—'}</td>
                <td className={cn('py-2 pr-3 text-right font-mono font-medium', pnlColor(t.pnl_dollars))}>
                  {t.pnl_pct != null ? formatPct(t.pnl_pct) : '—'}
                </td>
                <td className="py-2 text-xs text-[var(--muted)]">{t.exit_reason || t.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
