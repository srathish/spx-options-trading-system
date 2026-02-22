'use client';

import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { fetchStrategyBriefing, fetchActiveStrategy } from '../../lib/api';

export function MorningBriefing() {
  const [briefing, setBriefing] = useState(null);
  const [strategy, setStrategy] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchStrategyBriefing().catch(() => null),
      fetchActiveStrategy().catch(() => null),
    ]).then(([b, s]) => {
      setBriefing(b);
      setStrategy(s);
      setLoading(false);
    });
  }, []);

  if (loading) {
    return (
      <Card title="Morning Briefing">
        <div className="py-4 text-center text-sm text-[var(--muted)]">Loading...</div>
      </Card>
    );
  }

  // No briefing yet — show active strategy info
  if (!briefing) {
    return (
      <Card title="Morning Briefing">
        <div className="py-4 space-y-2">
          <div className="flex items-center gap-2">
            <Badge label={strategy?.label || 'v1'} />
            <span className="text-sm text-[var(--muted)]">Active strategy</span>
          </div>
          <p className="text-xs text-[var(--muted)]">No briefing generated yet. The nightly review runs at 2:00 AM ET.</p>
        </div>
      </Card>
    );
  }

  const perf = briefing.performance_summary || {};
  const changes = briefing.changes || [];

  return (
    <Card title="Morning Briefing">
      <div className="space-y-3">
        {/* Version + date header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge label={`v${briefing.version}`} />
            <span className="text-sm text-[var(--muted)]">{briefing.date}</span>
          </div>
        </div>

        {/* Yesterday's performance */}
        {perf.trades > 0 && (
          <div className="grid grid-cols-4 gap-2 text-center">
            <div>
              <div className="text-lg font-semibold">{perf.trades}</div>
              <div className="text-xs text-[var(--muted)]">Trades</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-green-400">{perf.wins}</div>
              <div className="text-xs text-[var(--muted)]">Wins</div>
            </div>
            <div>
              <div className="text-lg font-semibold text-red-400">{perf.losses}</div>
              <div className="text-xs text-[var(--muted)]">Losses</div>
            </div>
            <div>
              <div className={`text-lg font-semibold ${perf.totalPnlDollars >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                ${perf.totalPnlDollars?.toFixed(0) || '0'}
              </div>
              <div className="text-xs text-[var(--muted)]">P&L</div>
            </div>
          </div>
        )}

        {/* Overnight changes */}
        {changes.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-[var(--muted)]">Overnight Changes</div>
            {changes.map((c, i) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-purple-400">{c.param}</span>
                <span className="text-[var(--muted)]">{String(c.old)} → {String(c.new)}</span>
              </div>
            ))}
          </div>
        )}

        {/* Briefing text */}
        <p className="text-xs text-[var(--muted)] leading-relaxed">{briefing.briefing}</p>
      </div>
    </Card>
  );
}
