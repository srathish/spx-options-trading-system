'use client';

import { useEffect, useState } from 'react';
import { useTradingContext } from '../../lib/tradingContext';
import { formatCurrency } from '../../lib/utils';

export function Header() {
  const { connected, gex, phase } = useTradingContext();
  const [clock, setClock] = useState('');

  useEffect(() => {
    function tick() {
      setClock(
        new Date().toLocaleString('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
        })
      );
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-12 bg-[var(--surface)] border-b border-[var(--border)] flex items-center px-4 gap-6 shrink-0">
      <span className="text-sm font-medium text-[var(--foreground)]">OpenClaw</span>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">SPX</span>
        <span className="font-mono font-medium">
          {gex?.spotPrice ? formatCurrency(gex.spotPrice, 2) : '—'}
        </span>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">Phase</span>
        <span className="font-mono text-xs">{phase?.phase || '—'}</span>
      </div>

      <div className="ml-auto flex items-center gap-4">
        <span className="font-mono text-sm text-[var(--muted)]">{clock} ET</span>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'} ${connected ? 'animate-pulse' : ''}`} />
          <span className="text-xs text-[var(--muted)]">{connected ? 'Live' : 'Offline'}</span>
        </div>
      </div>
    </header>
  );
}
