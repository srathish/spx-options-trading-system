'use client';

import { formatCurrency, formatPct, formatET, pnlColor } from '../../lib/utils';
import { Card } from '../ui/Card';

export function PhantomTrades({ phantoms }) {
  if (!phantoms?.length) return null;

  return (
    <Card title="Phantom Trades" className="opacity-70">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Contract</th>
              <th className="text-right py-2 pr-3">Entry</th>
              <th className="text-right py-2 pr-3">P&L</th>
              <th className="text-left py-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {phantoms.map((p) => (
              <tr key={p.id} className="border-b border-[var(--border)]/30">
                <td className="py-2 pr-3 font-mono text-xs">{formatET(p.opened_at)}</td>
                <td className="py-2 pr-3 font-mono text-xs">{p.contract}</td>
                <td className="py-2 pr-3 text-right font-mono">{formatCurrency(p.entry_price)}</td>
                <td className={`py-2 pr-3 text-right font-mono ${pnlColor(p.current_pnl_pct)}`}>
                  {p.current_pnl_pct != null ? formatPct(p.current_pnl_pct) : '—'}
                </td>
                <td className="py-2 text-xs text-[var(--muted)]">{p.state}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
