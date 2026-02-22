'use client';

import { useEffect, useState } from 'react';
import { fetchStrategyRollbacks } from '../../lib/api';

export function RollbackBanner() {
  const [rollback, setRollback] = useState(null);

  useEffect(() => {
    fetchStrategyRollbacks()
      .then(rollbacks => {
        if (!rollbacks || rollbacks.length === 0) return;

        // Show only if the most recent rollback happened in the last 24 hours
        const latest = rollbacks[0];
        const ts = new Date(latest.timestamp).getTime();
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
        if (ts > oneDayAgo) {
          setRollback(latest);
        }
      })
      .catch(() => {});
  }, []);

  if (!rollback) return null;

  const triggerLabel = rollback.trigger_type?.replace(/_/g, ' ') || 'Unknown';
  const reason = rollback.trigger_details?.reason || '';

  return (
    <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-red-400 font-medium text-sm">
          Strategy Rollback: v{rollback.from_version} → v{rollback.to_version}
        </span>
        <span className="text-xs px-2 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">
          {triggerLabel}
        </span>
      </div>
      {reason && (
        <p className="text-xs text-red-300/80 mt-1">{reason}</p>
      )}
    </div>
  );
}
