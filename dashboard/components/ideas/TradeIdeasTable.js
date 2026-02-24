'use client';

import { Badge } from '../ui/Badge';
import { formatCurrency, formatET, cn, pnlColor } from '../../lib/utils';

export function TradeIdeasTable({ ideas }) {
  if (!ideas?.length) {
    return (
      <div className="text-center py-8 text-[var(--muted)] text-sm">
        No trade ideas today
      </div>
    );
  }

  // Show newest first
  const sorted = [...ideas].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Stats summary
  const checked = sorted.filter(i => i.checked === 1);
  const wins = checked.filter(i => i.result_win);
  const winRate = checked.length > 0 ? ((wins.length / checked.length) * 100).toFixed(0) : '—';

  return (
    <div>
      {/* Summary bar */}
      <div className="flex items-center gap-4 mb-3 text-xs text-[var(--muted)]">
        <span>{sorted.length} ideas today</span>
        {checked.length > 0 && (
          <>
            <span>Checked: {checked.length}</span>
            <span className={cn('font-medium', pnlColor(wins.length > checked.length / 2 ? 1 : -1))}>
              Win rate: {winRate}%
            </span>
          </>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Dir</th>
              <th className="text-right py-2 pr-3">Score</th>
              <th className="text-right py-2 pr-3">Spot</th>
              <th className="text-right py-2 pr-3">Target</th>
              <th className="text-right py-2 pr-3">Floor</th>
              <th className="text-right py-2 pr-3">Dist</th>
              <th className="text-left py-2">Result</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((idea) => {
              const dist = idea.spot_price && idea.target_strike
                ? Math.abs(idea.target_strike - idea.spot_price).toFixed(0)
                : '—';

              return (
                <tr key={idea.id} className="border-b border-[var(--border)]/50 hover:bg-[var(--border)]/20">
                  <td className="py-2 pr-3 font-mono text-xs">{formatET(idea.timestamp)}</td>
                  <td className="py-2 pr-3">
                    <Badge label={idea.direction} />
                  </td>
                  <td className="py-2 pr-3 text-right font-mono font-medium">{idea.score}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatCurrency(idea.spot_price, 0)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatCurrency(idea.target_strike, 0)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{formatCurrency(idea.floor_strike, 0)}</td>
                  <td className="py-2 pr-3 text-right font-mono text-xs">{dist}pt</td>
                  <td className="py-2 text-xs">
                    {idea.checked === 1 ? (
                      <div className="flex items-center gap-1">
                        <Badge label={idea.result_win ? 'WIN' : 'LOSS'} />
                        {idea.result_pct_move != null && (
                          <span className={cn('font-mono', pnlColor(idea.result_win ? 1 : -1))}>
                            {idea.result_pct_move > 0 ? '+' : ''}{idea.result_pct_move.toFixed(1)}%
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[var(--muted)]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
