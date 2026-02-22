'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';

export function LoopStatus() {
  const { loop, phase } = useTradingContext();

  return (
    <Card title="Loop Status">
      <div className="space-y-3 text-sm">
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Phase</span>
          <Badge label={phase?.phase || 'UNKNOWN'} />
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Description</span>
          <span className="font-mono text-xs">{phase?.description || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Cycle Count</span>
          <span className="font-mono">{loop?.cycleCount || 0}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Poll Interval</span>
          <span className="font-mono">{phase?.pollIntervalMs ? `${phase.pollIntervalMs / 1000}s` : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Running</span>
          <span className={loop?.running ? 'text-green-400' : 'text-red-400'}>{loop?.running ? 'Yes' : 'No'}</span>
        </div>
        {loop?.startedAt && (
          <div className="flex justify-between">
            <span className="text-[var(--muted)]">Uptime</span>
            <span className="font-mono text-xs">
              {Math.round((Date.now() - loop.startedAt) / 60000)} min
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}
