'use client';

import { Card } from '../ui/Card';
import { formatET } from '../../lib/utils';

export function ErrorLog({ health }) {
  // Health is the latest health row from DB
  if (!health) {
    return (
      <Card title="Recent Health">
        <p className="text-[var(--muted)] text-sm py-4 text-center">No health data</p>
      </Card>
    );
  }

  return (
    <Card title="Recent Health">
      <div className="text-sm space-y-2">
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Service</span>
          <span className="font-mono">{health.service}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Status</span>
          <span className={health.status === 'OK' ? 'text-green-400' : 'text-red-400'}>{health.status}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Details</span>
          <span className="text-xs font-mono">{health.details || '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-[var(--muted)]">Time</span>
          <span className="text-xs font-mono">{formatET(health.timestamp)}</span>
        </div>
      </div>
    </Card>
  );
}
