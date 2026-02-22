'use client';

import { useEffect, useState } from 'react';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { fetchStrategyVersions } from '../../lib/api';

export function VersionTimeline() {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStrategyVersions()
      .then(v => { setVersions(v); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <Card title="Version History">
        <div className="py-4 text-center text-sm text-[var(--muted)]">Loading...</div>
      </Card>
    );
  }

  if (versions.length === 0) {
    return (
      <Card title="Version History">
        <div className="py-4 text-center text-sm text-[var(--muted)]">No versions found</div>
      </Card>
    );
  }

  return (
    <Card title="Version History">
      <div className="space-y-2 max-h-80 overflow-y-auto">
        {versions.map(v => (
          <div key={v.version} className="flex items-center justify-between py-1.5 px-2 rounded bg-[var(--card-bg)] border border-[var(--border)]">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm font-semibold">v{v.version}</span>
              <Badge label={v.source} />
              {v.is_active ? <Badge label="ACTIVE" /> : null}
              {v.is_v1_floor ? <Badge label="FLOOR" /> : null}
            </div>
            <div className="flex items-center gap-3 text-xs text-[var(--muted)]">
              {v.change_summary?.length > 0 && (
                <span>{v.change_summary.length} change{v.change_summary.length === 1 ? '' : 's'}</span>
              )}
              <span>{formatDate(v.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return dateStr;
  }
}
