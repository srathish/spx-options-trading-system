'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { cn } from '../../lib/utils';

const INDICATOR_NAMES = {
  echo: 'Echo',
  bravo: 'Bravo',
  tango: 'Tango',
  helix: 'Helix',
  mountain: 'Mountain',
  arch: 'Arch',
  lattice: 'Lattice',
};

function classColor(classification) {
  if (classification === 'BULLISH') return 'text-green-400';
  if (classification === 'BEARISH') return 'text-red-400';
  return 'text-gray-500';
}

export function TvGrid() {
  const { tv } = useTradingContext();
  const snapshot = tv?.snapshot;
  const detailed = tv?.detailed;

  if (!snapshot) {
    return (
      <Card title="TV Confirmation">
        <p className="text-[var(--muted)] text-sm">Waiting for TV signals...</p>
      </Card>
    );
  }

  return (
    <Card title="TV Confirmation">
      <div className="space-y-3">
        {/* Indicator grid */}
        <div className="space-y-1">
          {detailed?.map((ind) => (
            <div key={ind.indicator} className="flex items-center justify-between text-sm py-1 border-b border-[var(--border)]/50 last:border-0">
              <span className="text-[var(--muted)] w-20">{INDICATOR_NAMES[ind.indicator] || ind.indicator}</span>
              <span className="font-mono text-xs flex-1 text-center">{ind.state}</span>
              <Badge label={ind.classification} />
              {ind.isStale && <span className="text-yellow-500 text-xs ml-1">STALE</span>}
            </div>
          ))}
        </div>

        {/* Confirmation bar */}
        <div className="flex items-center gap-3 pt-2 border-t border-[var(--border)]">
          <div className="flex gap-2 text-sm">
            <span className="text-green-400 font-medium">{snapshot.confirmations?.bullish || 0} BULL</span>
            <span className="text-[var(--muted)]">/</span>
            <span className="text-red-400 font-medium">{snapshot.confirmations?.bearish || 0} BEAR</span>
          </div>
          <Badge label={snapshot.confirmation_mode || 'BEGINNER'} />
        </div>

        {/* S/R levels */}
        {(snapshot.support || snapshot.resistance) && (
          <div className="flex gap-4 text-xs pt-2 border-t border-[var(--border)]">
            {snapshot.support && (
              <span className="text-green-400">S: ${snapshot.support.level}</span>
            )}
            {snapshot.resistance && (
              <span className="text-red-400">R: ${snapshot.resistance.level}</span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}
