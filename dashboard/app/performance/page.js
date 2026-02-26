'use client';

import { useEffect, useState } from 'react';
import { fetchTodaysTrades, fetchAllPhantoms } from '../../lib/api';
import { TodaySummary } from '../../components/performance/TodaySummary';
import { TradeLog } from '../../components/performance/TradeLog';
import { EquityCurve } from '../../components/performance/EquityCurve';
import { PhantomTrades } from '../../components/performance/PhantomTrades';
import { cn } from '../../lib/utils';

const LANE_OPTIONS = [
  { value: 'ALL', label: 'Both' },
  { value: 'A', label: 'Lane A' },
  { value: 'B', label: 'Lane B' },
];

export default function PerformancePage() {
  const [trades, setTrades] = useState([]);
  const [phantoms, setPhantoms] = useState([]);
  const [laneFilter, setLaneFilter] = useState('ALL');

  useEffect(() => {
    function load() {
      fetchTodaysTrades().then(setTrades).catch(() => {});
      fetchAllPhantoms().then(setPhantoms).catch(() => {});
    }
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, []);

  // Filter by lane
  const filteredTrades = laneFilter === 'ALL'
    ? trades
    : trades.filter(t => t.strategy_lane === laneFilter);
  const filteredPhantoms = laneFilter === 'ALL'
    ? phantoms
    : phantoms.filter(p => p.strategy_lane === laneFilter);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-medium">Performance</h1>
        <div className="flex items-center gap-1 bg-[var(--surface)] rounded-lg p-1 border border-[var(--border)]">
          {LANE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setLaneFilter(opt.value)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                laneFilter === opt.value
                  ? 'bg-[var(--border)] text-white'
                  : 'text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50'
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <TodaySummary trades={filteredTrades} />
      <EquityCurve trades={filteredTrades} />
      <TradeLog trades={filteredTrades} />
      <PhantomTrades phantoms={filteredPhantoms} />
    </div>
  );
}
