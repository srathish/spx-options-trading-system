'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';

export function AgentReasoning() {
  const { decision } = useTradingContext();
  const d = decision?.lastDecision;

  if (!d) {
    return (
      <Card title="Agent Reasoning">
        <p className="text-[var(--muted)] text-sm">No agent decision yet...</p>
      </Card>
    );
  }

  return (
    <Card title="Agent Reasoning">
      <div className="space-y-3">
        {/* Action + confidence */}
        <div className="flex items-center gap-2">
          <Badge label={d.action || 'WAIT'} />
          <Badge label={d.confidence || 'LOW'} />
          {d.skipped && <span className="text-xs text-[var(--muted)]">(skipped)</span>}
        </div>

        {/* Reasoning text */}
        {d.reason && (
          <p className="text-sm text-[var(--foreground)] leading-relaxed">{d.reason}</p>
        )}

        {/* Key risk */}
        {d.key_risk && (
          <div className="text-xs">
            <span className="text-yellow-500 font-medium">Risk: </span>
            <span className="text-[var(--muted)]">{d.key_risk}</span>
          </div>
        )}

        {/* Meta */}
        <div className="flex gap-4 text-xs text-[var(--muted)] pt-2 border-t border-[var(--border)]">
          {d.responseTimeMs && <span>{d.responseTimeMs}ms</span>}
          {d.inputTokens && <span>{d.inputTokens + (d.outputTokens || 0)} tokens</span>}
          {d.gexScore != null && <span>GEX: {d.gexScore}</span>}
        </div>
      </div>
    </Card>
  );
}
