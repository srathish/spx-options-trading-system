'use client';

import { Card } from '../ui/Card';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';

export function EquityCurve({ trades }) {
  if (!trades?.length) return null;

  // Build cumulative P&L data
  const closedTrades = trades.filter(t => t.pnl_dollars != null).reverse();
  let cumPnl = 0;
  const data = closedTrades.map((t, i) => {
    cumPnl += t.pnl_dollars;
    return {
      trade: i + 1,
      pnl: Math.round(cumPnl * 100) / 100,
      label: t.contract?.slice(-12) || `#${i + 1}`,
    };
  });

  if (data.length < 2) return null;

  return (
    <Card title="Equity Curve">
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data}>
            <XAxis dataKey="trade" tick={{ fontSize: 10, fill: '#6b7280' }} />
            <YAxis tick={{ fontSize: 10, fill: '#6b7280' }} tickFormatter={v => `$${v}`} />
            <Tooltip
              contentStyle={{ background: '#141420', border: '1px solid #2a2a3a', borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: '#6b7280' }}
              formatter={(v) => [`$${v}`, 'P&L']}
            />
            <ReferenceLine y={0} stroke="#2a2a3a" />
            <Line type="monotone" dataKey="pnl" stroke="#22c55e" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
