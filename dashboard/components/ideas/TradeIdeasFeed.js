'use client';

import { Badge } from '../ui/Badge';
import { formatCurrency, formatET, cn, pnlColor } from '../../lib/utils';

function IdeaCard({ idea }) {
  const isBullish = idea.direction === 'BULLISH';
  const dotColor = isBullish ? 'bg-green-400' : 'bg-red-400';
  const bgColor = isBullish ? 'bg-green-500/10' : 'bg-red-500/10';
  const borderColor = isBullish ? 'border-green-500/25' : 'border-red-500/25';

  const confidence = idea.score >= 70 ? 'HIGH' : idea.score >= 50 ? 'MEDIUM' : 'LOW';

  return (
    <div className={`rounded-lg border p-3 ${bgColor} ${borderColor}`}>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${dotColor}`} />
          <Badge label={idea.direction} />
          <span className="font-mono text-sm font-bold">{idea.score}</span>
          <span className="text-xs text-[var(--muted)]">{confidence}</span>
        </div>
        <span className="text-xs text-[var(--muted)] font-mono">{formatET(idea.timestamp)}</span>
      </div>

      <div className="grid grid-cols-3 gap-3 text-xs mb-2">
        <div>
          <span className="text-[var(--muted)]">Spot</span>
          <p className="font-mono font-medium">{formatCurrency(idea.spot_price, 0)}</p>
        </div>
        <div>
          <span className="text-[var(--muted)]">Target</span>
          <p className="font-mono font-medium">{formatCurrency(idea.target_strike, 0)}</p>
        </div>
        <div>
          <span className="text-[var(--muted)]">Floor</span>
          <p className="font-mono font-medium">{formatCurrency(idea.floor_strike, 0)}</p>
        </div>
      </div>

      {/* Distance to target */}
      {idea.spot_price && idea.target_strike && (
        <div className="text-xs text-[var(--muted)] mb-1">
          Distance: {Math.abs(((idea.target_strike - idea.spot_price) / idea.spot_price) * 100).toFixed(1)}%
          ({Math.abs(idea.target_strike - idea.spot_price).toFixed(0)} pts)
        </div>
      )}

      {/* Outcome if checked */}
      {idea.checked === 1 && (
        <div className={cn('flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border)]')}>
          <Badge label={idea.result_win ? 'WIN' : 'LOSS'} />
          {idea.result_pct_move != null && (
            <span className={cn('text-xs font-mono font-medium', pnlColor(idea.result_win ? 1 : -1))}>
              {idea.result_pct_move > 0 ? '+' : ''}{idea.result_pct_move.toFixed(1)}%
            </span>
          )}
          {idea.result_price != null && (
            <span className="text-xs text-[var(--muted)]">
              SPX hit {formatCurrency(idea.result_price, 0)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function TradeIdeasFeed({ ideas }) {
  if (!ideas?.length) {
    return (
      <div className="text-center py-8 text-[var(--muted)] text-sm">
        No trade ideas today
      </div>
    );
  }

  // Show newest first
  const sorted = [...ideas].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return (
    <div className="space-y-2 max-h-[700px] overflow-y-auto">
      {sorted.map((idea) => (
        <IdeaCard key={idea.id} idea={idea} />
      ))}
    </div>
  );
}
