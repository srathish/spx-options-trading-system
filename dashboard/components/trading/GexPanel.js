'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { ProgressBar } from '../ui/ProgressBar';
import { formatCurrency, directionColor } from '../../lib/utils';

function WallRow({ wall, spotPrice }) {
  if (!wall) return null;
  const dist = Math.abs(spotPrice - wall.strike);
  return (
    <div className="flex items-center justify-between text-sm py-1">
      <span className="font-mono">{wall.strike}</span>
      <span className="text-xs text-[var(--muted)]">{formatCurrency(wall.gexValue || wall.value, 0)}</span>
      <span className="text-xs text-[var(--muted)]">{dist.toFixed(0)}pt</span>
    </div>
  );
}

export function GexPanel() {
  const { gex } = useTradingContext();
  if (!gex) {
    return (
      <Card title="GEX Score">
        <p className="text-[var(--muted)] text-sm">Waiting for data...</p>
      </Card>
    );
  }

  const scoreColor = gex.score >= 60 ? 'bg-green-500' : gex.score >= 40 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <Card title="GEX Score">
      <div className="space-y-4">
        {/* Score gauge */}
        <div className="flex items-center gap-3">
          <span className="text-3xl font-bold font-mono">{gex.score}</span>
          <div className="flex-1">
            <ProgressBar value={gex.score} color={scoreColor} />
          </div>
        </div>

        {/* Direction + badges */}
        <div className="flex items-center gap-2">
          <span className={`font-medium ${directionColor(gex.direction)}`}>{gex.direction}</span>
          <Badge label={gex.confidence} />
          {gex.environment && <Badge label={gex.environment.replace('_', ' ')} />}
        </div>

        {/* Walls above */}
        {gex.wallsAbove?.length > 0 && (
          <div>
            <p className="text-xs text-[var(--muted)] mb-1 uppercase">Walls Above</p>
            {gex.wallsAbove.slice(0, 3).map((w, i) => (
              <WallRow key={i} wall={w} spotPrice={gex.spotPrice} />
            ))}
          </div>
        )}

        {/* Walls below */}
        {gex.wallsBelow?.length > 0 && (
          <div>
            <p className="text-xs text-[var(--muted)] mb-1 uppercase">Walls Below</p>
            {gex.wallsBelow.slice(0, 3).map((w, i) => (
              <WallRow key={i} wall={w} spotPrice={gex.spotPrice} />
            ))}
          </div>
        )}

        {/* Trade Idea / Levels */}
        {(gex.targetWall || gex.floorWall) && (
          <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--surface)]">
            <p className="text-xs text-[var(--muted)] mb-2 uppercase">Trade Idea</p>
            {gex.recommendation && (
              <p className="text-sm font-medium mb-2">{gex.recommendation}</p>
            )}
            <div className="grid grid-cols-2 gap-2 text-xs">
              {gex.targetWall && (
                <div>
                  <span className="text-[var(--muted)]">Target</span>
                  <p className="font-mono font-medium">{gex.targetWall.strike}</p>
                  <p className="text-[var(--muted)]">{formatCurrency(gex.targetWall.gexValue, 0)}</p>
                </div>
              )}
              {gex.floorWall && (
                <div>
                  <span className="text-[var(--muted)]">{gex.direction === 'BEARISH' ? 'Ceiling' : 'Floor'}</span>
                  <p className="font-mono font-medium">{gex.floorWall.strike}</p>
                  <p className="text-[var(--muted)]">{formatCurrency(gex.floorWall.gexValue, 0)}</p>
                </div>
              )}
            </div>
            {gex.distanceToTarget != null && (
              <p className="text-xs text-[var(--muted)] mt-1">
                Distance: {gex.distanceToTarget}%
              </p>
            )}
            {gex.envDetail && (
              <p className="text-[10px] text-[var(--muted)] mt-1">{gex.envDetail}</p>
            )}
          </div>
        )}

        {/* Breakdown */}
        {gex.breakdown?.length > 0 && (
          <div>
            <p className="text-xs text-[var(--muted)] mb-1 uppercase">Score Breakdown</p>
            {gex.breakdown.map((item, i) => (
              <div key={i} className="flex justify-between text-xs py-0.5">
                <span className="text-[var(--muted)]">{item.factor || item.name}</span>
                <span className="font-mono">{item.points != null ? `+${item.points}` : item.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
