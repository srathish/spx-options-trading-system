'use client';

import { formatET } from '../../lib/utils';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

export function DecisionLog({ decisions }) {
  if (!decisions?.length) {
    return (
      <Card title="Recent Decisions">
        <p className="text-[var(--muted)] text-sm py-4 text-center">No decisions yet today</p>
      </Card>
    );
  }

  return (
    <Card title="Recent Decisions">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-[var(--muted)] border-b border-[var(--border)]">
              <th className="text-left py-2 pr-3">Time</th>
              <th className="text-left py-2 pr-3">Action</th>
              <th className="text-left py-2 pr-3">Confidence</th>
              <th className="text-left py-2 pr-3">Reason</th>
              <th className="text-right py-2 pr-3">Tokens</th>
              <th className="text-right py-2">Ms</th>
            </tr>
          </thead>
          <tbody>
            {decisions.slice(0, 20).map((d) => (
              <tr key={d.id} className="border-b border-[var(--border)]/30 hover:bg-[var(--border)]/20">
                <td className="py-2 pr-3 font-mono text-xs">{formatET(d.timestamp)}</td>
                <td className="py-2 pr-3">
                  <Badge label={d.agent_action || 'WAIT'} />
                </td>
                <td className="py-2 pr-3">
                  <Badge label={d.agent_confidence || 'LOW'} />
                </td>
                <td className="py-2 pr-3 text-xs text-[var(--muted)] max-w-xs truncate">
                  {d.agent_reason || (d.skipped ? 'Skipped' : '—')}
                </td>
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {(d.input_tokens || 0) + (d.output_tokens || 0) || '—'}
                </td>
                <td className="py-2 text-right font-mono text-xs">{d.response_time_ms || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
