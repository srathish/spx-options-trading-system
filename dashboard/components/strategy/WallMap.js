'use client';

import { Card } from '../ui/Card';
import { useTradingContext } from '../../lib/tradingContext';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

export function WallMap() {
  const { gex } = useTradingContext();

  if (!gex?.wallsAbove && !gex?.wallsBelow) {
    return (
      <Card title="GEX Wall Map">
        <p className="text-[var(--muted)] text-sm py-4 text-center">No wall data available</p>
      </Card>
    );
  }

  // Combine walls into chart data
  const allWalls = [
    ...(gex.wallsBelow || []).map(w => ({ strike: w.strike, value: -(Math.abs(w.gexValue || w.value || 0)) })),
    ...(gex.wallsAbove || []).map(w => ({ strike: w.strike, value: Math.abs(w.gexValue || w.value || 0) })),
  ].sort((a, b) => a.strike - b.strike);

  if (allWalls.length === 0) return null;

  return (
    <Card title="GEX Wall Map">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={allWalls}>
            <XAxis dataKey="strike" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `${(v / 1e6).toFixed(1)}M`} />
            <Tooltip
              contentStyle={{ background: '#141420', border: '1px solid #2a2a3a', borderRadius: 8, fontSize: 12 }}
              formatter={(v) => [`$${Math.abs(v).toLocaleString()}`, 'GEX']}
            />
            {gex.spotPrice && <ReferenceLine x={Math.round(gex.spotPrice / 5) * 5} stroke="#eab308" strokeDasharray="3 3" label={{ value: 'SPOT', fontSize: 10, fill: '#eab308' }} />}
            <Bar dataKey="value" fill={(entry) => entry.value >= 0 ? '#22c55e' : '#ef4444'}>
              {allWalls.map((entry, i) => (
                <rect key={i} fill={entry.value >= 0 ? '#22c55e' : '#ef4444'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
