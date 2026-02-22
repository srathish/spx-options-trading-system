'use client';

import { formatCurrency, formatPct, pnlColor } from '../../lib/utils';
import { Card } from '../ui/Card';

function StatCard({ label, value, className }) {
  return (
    <div className="bg-[var(--background)] rounded-lg p-3 border border-[var(--border)]">
      <p className="text-xs text-[var(--muted)] mb-1">{label}</p>
      <p className={`text-lg font-bold font-mono ${className || ''}`}>{value}</p>
    </div>
  );
}

export function TodaySummary({ performance }) {
  if (!performance) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <StatCard label="Trades" value={performance.trades || 0} />
      <StatCard label="W / L" value={`${performance.wins || 0} / ${performance.losses || 0}`} />
      <StatCard
        label="Win Rate"
        value={performance.trades > 0 ? `${performance.winRate}%` : '—'}
        className={Number(performance.winRate) >= 50 ? 'text-green-400' : 'text-red-400'}
      />
      <StatCard
        label="P&L"
        value={formatCurrency(performance.totalPnl)}
        className={pnlColor(performance.totalPnl)}
      />
      <StatCard
        label="Predictions"
        value={`${performance.predictions?.correct || 0}/${performance.predictions?.total || 0}`}
      />
    </div>
  );
}
