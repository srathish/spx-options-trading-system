'use client';

import { useState, useEffect, useRef } from 'react';
import { useTradingContext } from '../../lib/tradingContext';
import { fetchAlerts } from '../../lib/api';
import { Card } from '../ui/Card';

const TYPE_CONFIG = {
  DIRECTION_CHANGE: { label: 'Direction', bg: 'bg-yellow-500/15', border: 'border-yellow-500/30', dot: 'bg-yellow-400' },
  DIRECTION_FLIP: { label: 'Direction', bg: 'bg-yellow-500/15', border: 'border-yellow-500/30', dot: 'bg-yellow-400' },
  FULL_ANALYSIS: { label: 'Analysis', bg: 'bg-blue-500/15', border: 'border-blue-500/30', dot: 'bg-blue-400' },
  SIGNAL: { label: 'Signal', bg: 'bg-purple-500/15', border: 'border-purple-500/30', dot: 'bg-purple-400' },
  ENVIRONMENT_CHANGE: { label: 'Env Change', bg: 'bg-orange-500/15', border: 'border-orange-500/30', dot: 'bg-orange-400' },
  BIG_MOVE: { label: 'Env Change', bg: 'bg-orange-500/15', border: 'border-orange-500/30', dot: 'bg-orange-400' },
  PRICE_NEAR_TARGET: { label: 'Proximity', bg: 'bg-cyan-500/15', border: 'border-cyan-500/30', dot: 'bg-cyan-400' },
  PROXIMITY: { label: 'Proximity', bg: 'bg-cyan-500/15', border: 'border-cyan-500/30', dot: 'bg-cyan-400' },
  NEW_WALL: { label: 'New Wall', bg: 'bg-indigo-500/15', border: 'border-indigo-500/30', dot: 'bg-indigo-400' },
  WALL_GROWTH: { label: 'Wall +', bg: 'bg-green-500/15', border: 'border-green-500/30', dot: 'bg-green-400' },
  WALL_SHRINK: { label: 'Wall -', bg: 'bg-red-500/15', border: 'border-red-500/30', dot: 'bg-red-400' },
  MAP_RESHUFFLE: { label: 'Reshuffle', bg: 'bg-amber-500/15', border: 'border-amber-500/30', dot: 'bg-amber-400' },
  TRADE_OPENED: { label: 'Trade Open', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30', dot: 'bg-emerald-400' },
  TRADE_CLOSED: { label: 'Trade Close', bg: 'bg-rose-500/15', border: 'border-rose-500/30', dot: 'bg-rose-400' },
};

const DEFAULT_CONFIG = { label: 'Alert', bg: 'bg-gray-500/15', border: 'border-gray-500/30', dot: 'bg-gray-400' };

function formatTime(ts) {
  if (!ts) return '';
  try {
    const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
    return d.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  } catch {
    return String(ts).slice(11, 19);
  }
}

function AlertRow({ alert }) {
  const type = alert.type || 'UNKNOWN';
  const cfg = TYPE_CONFIG[type] || DEFAULT_CONFIG;
  const message = alert.message || (typeof alert.content === 'string' ? alert.content : JSON.stringify(alert.content));
  const time = formatTime(alert.ts || alert.timestamp);

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-md border ${cfg.bg} ${cfg.border}`}>
      <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${cfg.dot}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-[var(--foreground)]">{cfg.label}</span>
          <span className="text-xs text-[var(--muted)] font-mono shrink-0">{time}</span>
        </div>
        <p className="text-xs text-[var(--muted)] mt-0.5 break-words">{message}</p>
      </div>
    </div>
  );
}

export function AlertFeed() {
  const { alerts: wsAlerts } = useTradingContext();
  const [historicalAlerts, setHistoricalAlerts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef(null);

  // Load historical alerts on mount
  useEffect(() => {
    fetchAlerts(30)
      .then(data => {
        const mapped = data.map(a => {
          let message;
          if (typeof a.content === 'object' && a.content) {
            message = a.content.message || a.content.type
              || (a.content.strike ? `Strike $${a.content.strike}` : null)
              || (a.content.from && a.content.to ? `${a.content.from} → ${a.content.to}` : null)
              || JSON.stringify(a.content);
          } else {
            message = String(a.content);
          }
          return { type: a.type, message, timestamp: a.timestamp, id: a.id };
        });
        setHistoricalAlerts(mapped);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, []);

  // Merge: WS alerts (newest) + historical (older), dedup by rough timestamp
  const allAlerts = [...wsAlerts];
  if (loaded) {
    for (const h of historicalAlerts) {
      const isDup = allAlerts.some(a => a.type === h.type && Math.abs((a.ts || 0) - new Date(h.timestamp).getTime()) < 5000);
      if (!isDup) allAlerts.push(h);
    }
  }

  // Limit to 30
  const displayAlerts = allAlerts.slice(0, 30);

  if (displayAlerts.length === 0) {
    return (
      <Card title="Alert Feed">
        <p className="text-[var(--muted)] text-sm text-center py-4">No alerts yet</p>
      </Card>
    );
  }

  return (
    <Card title="Alert Feed">
      <div ref={scrollRef} className="space-y-1.5 max-h-[400px] overflow-y-auto">
        {displayAlerts.map((alert, i) => (
          <AlertRow key={alert.id || `ws-${i}`} alert={alert} />
        ))}
      </div>
    </Card>
  );
}
