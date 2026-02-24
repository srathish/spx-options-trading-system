'use client';

import { useTradingContext } from '../../lib/tradingContext';

function ServiceCard({ name, status, detail }) {
  const color = status === 'OK' ? 'bg-green-500' : status === 'ERROR' ? 'bg-red-500' : 'bg-yellow-500';
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 flex items-center gap-3">
      <div className={`w-3 h-3 rounded-full ${color}`} />
      <div>
        <p className="text-sm font-medium">{name}</p>
        <p className="text-xs text-[var(--muted)]">{detail}</p>
      </div>
    </div>
  );
}

export function ServiceGrid() {
  const { connected, loop, gex, decision } = useTradingContext();

  const services = [
    { name: 'Main Loop', status: loop?.running ? 'OK' : 'ERROR', detail: loop?.running ? `Cycle ${loop.cycleCount}` : 'Stopped' },
    { name: 'Dashboard WS', status: connected ? 'OK' : 'ERROR', detail: connected ? 'Connected' : 'Disconnected' },
    { name: 'GEX Data', status: gex ? 'OK' : 'WARN', detail: gex ? `Score: ${gex.score}` : 'No data' },
    { name: 'AI Agent', status: decision?.lastDecision ? 'OK' : 'WARN', detail: decision?.action || 'Idle' },
    { name: 'TV Webhook', status: 'OK', detail: 'Port 3001' },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {services.map((s) => (
        <ServiceCard key={s.name} {...s} />
      ))}
    </div>
  );
}
