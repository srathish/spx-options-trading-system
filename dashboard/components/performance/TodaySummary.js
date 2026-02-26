'use client';

import { formatCurrency, pnlColor } from '../../lib/utils';

function StatCard({ label, value, className }) {
  return (
    <div className="bg-[var(--background)] rounded-lg p-3 border border-[var(--border)]">
      <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
      <p className={`text-lg font-bold font-mono ${className || ''}`}>{value}</p>
    </div>
  );
}

export function TodaySummary({ trades }) {
  if (!trades?.length) return null;

  const closedTrades = trades.filter(t => t.exit_reason);
  const wins = closedTrades.filter(t => {
    const spxChange = t.exit_spx && t.entry_spx
      ? (t.direction === 'BULLISH' ? t.exit_spx - t.entry_spx : t.entry_spx - t.exit_spx)
      : 0;
    return spxChange > 0;
  });
  const losses = closedTrades.length - wins.length;
  const totalPnl = closedTrades.reduce((s, t) => s + (t.pnl_dollars || 0), 0);
  const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length * 100).toFixed(1) : 0;
  const openCount = trades.length - closedTrades.length;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <StatCard label="Trades" value={`${closedTrades.length}${openCount > 0 ? ` (+${openCount} open)` : ''}`} />
      <StatCard label="W / L" value={`${wins.length} / ${losses}`} />
      <StatCard
        label="Win Rate"
        value={closedTrades.length > 0 ? `${winRate}%` : '—'}
        className={Number(winRate) >= 50 ? 'text-green-400' : 'text-red-400'}
      />
      <StatCard
        label="P&L"
        value={formatCurrency(totalPnl)}
        className={pnlColor(totalPnl)}
      />
      <StatCard
        label="Avg P&L"
        value={closedTrades.length > 0 ? formatCurrency(totalPnl / closedTrades.length) : '—'}
        className={pnlColor(totalPnl)}
      />
    </div>
  );
}
