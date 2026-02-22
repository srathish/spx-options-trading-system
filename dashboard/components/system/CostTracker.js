'use client';

import { Card } from '../ui/Card';

export function CostTracker({ costs }) {
  if (!costs) return null;

  return (
    <Card title="API Costs Today">
      <div className="grid grid-cols-2 gap-4 text-sm">
        <div>
          <p className="text-[var(--muted)] text-xs">Agent Calls</p>
          <p className="font-mono font-medium">{costs.agentCalls || 0}</p>
        </div>
        <div>
          <p className="text-[var(--muted)] text-xs">Est. Cost</p>
          <p className="font-mono font-medium">${costs.estimatedCost || '0.0000'}</p>
        </div>
        <div>
          <p className="text-[var(--muted)] text-xs">Input Tokens</p>
          <p className="font-mono">{(costs.totalInputTokens || 0).toLocaleString()}</p>
        </div>
        <div>
          <p className="text-[var(--muted)] text-xs">Output Tokens</p>
          <p className="font-mono">{(costs.totalOutputTokens || 0).toLocaleString()}</p>
        </div>
      </div>
    </Card>
  );
}
