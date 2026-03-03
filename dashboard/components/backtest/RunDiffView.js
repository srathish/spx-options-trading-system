'use client';

import { cn, pnlColor } from '../../lib/utils';

function DiffStat({ label, valA, valB, format }) {
  let a = valA, b = valB, delta;
  if (format === 'pct') {
    a = `${valA}%`;
    b = `${valB}%`;
    delta = (Number(valB) - Number(valA)).toFixed(1);
  } else {
    a = typeof valA === 'number' ? valA.toFixed(2) : valA;
    b = typeof valB === 'number' ? valB.toFixed(2) : valB;
    delta = (Number(valB) - Number(valA)).toFixed(2);
  }

  const deltaNum = Number(delta);
  const deltaColor = deltaNum > 0 ? 'text-green-400' : deltaNum < 0 ? 'text-red-400' : 'text-[var(--muted)]';

  return (
    <div className="text-center">
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
      <div className="flex items-center justify-center gap-2 text-sm">
        <span className="text-blue-400">{a}</span>
        <span className={cn('text-xs', deltaColor)}>
          {deltaNum > 0 ? '+' : ''}{delta}
        </span>
        <span className="text-purple-400">{b}</span>
      </div>
    </div>
  );
}

export function RunDiffView({ runA, runB, configA, configB }) {
  if (!runA || !runB) return null;

  // Find changed config params
  const changedParams = [];
  const allKeys = new Set([...Object.keys(configA || {}), ...Object.keys(configB || {})]);
  for (const key of allKeys) {
    if ((configA || {})[key] !== (configB || {})[key]) {
      changedParams.push({ key, old: (configA || {})[key], new: (configB || {})[key] });
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="p-3 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-3 mb-3">
          <span className="px-2 py-0.5 bg-blue-500/20 border border-blue-500/30 rounded text-xs text-blue-400">Run A</span>
          <span className="text-[var(--muted)] text-xs">vs</span>
          <span className="px-2 py-0.5 bg-purple-500/20 border border-purple-500/30 rounded text-xs text-purple-400">Run B</span>
        </div>

        {/* Summary comparison */}
        <div className="grid grid-cols-5 gap-2">
          <DiffStat label="Trades" valA={runA.totalTrades} valB={runB.totalTrades} />
          <DiffStat label="Wins" valA={runA.wins} valB={runB.wins} />
          <DiffStat label="Losses" valA={runA.losses} valB={runB.losses} />
          <DiffStat label="Win Rate" valA={runA.winRate} valB={runB.winRate} format="pct" />
          <DiffStat label="P&L (pts)" valA={runA.totalPnlPts} valB={runB.totalPnlPts} />
        </div>
      </div>

      {/* Config diff */}
      {changedParams.length > 0 && (
        <div className="p-3 border-b border-[var(--border)]">
          <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">
            Config Changes ({changedParams.length})
          </h3>
          <div className="space-y-1">
            {changedParams.map(({ key, old: oldVal, new: newVal }) => (
              <div key={key} className="flex items-center justify-between text-xs">
                <span className="text-[var(--foreground)]">{key}</span>
                <div className="flex items-center gap-1">
                  <span className="text-blue-400 font-mono">{oldVal ?? '—'}</span>
                  <span className="text-[var(--muted)]">→</span>
                  <span className="text-purple-400 font-mono">{newVal ?? '—'}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Exit reason comparison */}
      <div className="p-3 border-b border-[var(--border)]">
        <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Exit Reasons</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--muted)]">
              <th className="text-left py-1">Reason</th>
              <th className="text-right text-blue-400">A</th>
              <th className="text-right text-purple-400">B</th>
              <th className="text-right">Delta</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const allReasons = new Set([
                ...Object.keys(runA.exitReasons || {}),
                ...Object.keys(runB.exitReasons || {}),
              ]);
              return [...allReasons].sort().map(reason => {
                const a = (runA.exitReasons || {})[reason] || 0;
                const b = (runB.exitReasons || {})[reason] || 0;
                const d = b - a;
                return (
                  <tr key={reason} className="border-t border-[var(--border)]/20">
                    <td className="py-1 text-[var(--foreground)]">{reason}</td>
                    <td className="text-right text-blue-400">{a}</td>
                    <td className="text-right text-purple-400">{b}</td>
                    <td className={cn('text-right', d > 0 ? 'text-green-400' : d < 0 ? 'text-red-400' : 'text-[var(--muted)]')}>
                      {d > 0 ? '+' : ''}{d}
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      </div>

      {/* Pattern performance comparison */}
      <div className="p-3">
        <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Pattern Performance</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--muted)]">
              <th className="text-left py-1">Pattern</th>
              <th className="text-right text-blue-400">A P&L</th>
              <th className="text-right text-purple-400">B P&L</th>
              <th className="text-right">Delta</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const allPatterns = new Set([
                ...Object.keys(runA.patternPerformance || {}),
                ...Object.keys(runB.patternPerformance || {}),
              ]);
              return [...allPatterns].sort().map(pattern => {
                const a = (runA.patternPerformance || {})[pattern]?.totalPnl || 0;
                const b = (runB.patternPerformance || {})[pattern]?.totalPnl || 0;
                const d = b - a;
                return (
                  <tr key={pattern} className="border-t border-[var(--border)]/20">
                    <td className="py-1 text-[var(--foreground)]">{pattern}</td>
                    <td className={cn('text-right', pnlColor(a))}>{a > 0 ? '+' : ''}{a.toFixed(2)}</td>
                    <td className={cn('text-right', pnlColor(b))}>{b > 0 ? '+' : ''}{b.toFixed(2)}</td>
                    <td className={cn('text-right', d > 0 ? 'text-green-400' : d < 0 ? 'text-red-400' : 'text-[var(--muted)]')}>
                      {d > 0 ? '+' : ''}{d.toFixed(2)}
                    </td>
                  </tr>
                );
              });
            })()}
          </tbody>
        </table>
      </div>
    </div>
  );
}
