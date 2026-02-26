'use client';

import { useState, useEffect } from 'react';
import { fetchAllPhantoms } from '../../lib/api';
import { PhantomAlertsFeed } from '../../components/ideas/PhantomAlertsFeed';
import { PhantomAlertsTable } from '../../components/ideas/PhantomAlertsTable';
import { Card } from '../../components/ui/Card';
import { cn } from '../../lib/utils';

function todayET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function formatDateLabel(dateStr) {
  if (dateStr === todayET()) return 'Today';
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
}

export default function IdeasPage() {
  const [phantoms, setPhantoms] = useState([]);
  const [view, setView] = useState('feed');
  const [date, setDate] = useState(todayET());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    function load() {
      const dateParam = date === todayET() ? undefined : date;
      fetchAllPhantoms(dateParam)
        .then(data => { if (active) { setPhantoms(data); setLoading(false); } })
        .catch(() => { if (active) setLoading(false); });
    }

    load();
    // Only auto-refresh if viewing today
    const interval = date === todayET() ? setInterval(load, 30_000) : null;
    return () => { active = false; if (interval) clearInterval(interval); };
  }, [date]);

  return (
    <div className="space-y-4">
      <Card title="Phantom Alerts">
        {/* Controls: view toggle + date picker */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView('feed')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                view === 'feed'
                  ? 'bg-[var(--border)] text-white'
                  : 'text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50'
              )}
            >
              Feed
            </button>
            <button
              onClick={() => setView('table')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                view === 'table'
                  ? 'bg-[var(--border)] text-white'
                  : 'text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50'
              )}
            >
              Table
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const d = new Date(date + 'T12:00:00');
                d.setDate(d.getDate() - 1);
                setDate(d.toISOString().slice(0, 10));
              }}
              className="px-2 py-1 text-xs text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50 rounded"
            >
              &larr;
            </button>
            <span className="text-xs font-medium min-w-[100px] text-center">
              {formatDateLabel(date)}
            </span>
            <button
              onClick={() => {
                const today = todayET();
                if (date < today) {
                  const d = new Date(date + 'T12:00:00');
                  d.setDate(d.getDate() + 1);
                  setDate(d.toISOString().slice(0, 10));
                }
              }}
              disabled={date >= todayET()}
              className={cn(
                'px-2 py-1 text-xs rounded',
                date >= todayET()
                  ? 'text-[var(--border)] cursor-not-allowed'
                  : 'text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50'
              )}
            >
              &rarr;
            </button>
          </div>
        </div>

        {loading ? (
          <div className="text-center py-8 text-[var(--muted)] text-sm">Loading...</div>
        ) : view === 'feed' ? (
          <PhantomAlertsFeed phantoms={phantoms} />
        ) : (
          <PhantomAlertsTable phantoms={phantoms} />
        )}
      </Card>
    </div>
  );
}
