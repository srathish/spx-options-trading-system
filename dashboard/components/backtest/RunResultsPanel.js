'use client';

import { useState, useEffect, useRef } from 'react';
import { cn, pnlColor } from '../../lib/utils';

function RunningOverlay() {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-[var(--background)]/80 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-4">
        {/* Spinner */}
        <div className="w-10 h-10 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />

        <div className="text-center space-y-1">
          <p className="text-sm font-medium text-[var(--foreground)]">Running backtest...</p>
          <p className="text-xs text-[var(--muted)]">
            Replaying ~3,660 GEX cycles
          </p>
        </div>

        {/* Progress bar (indeterminate) */}
        <div className="w-48 h-1 bg-[var(--border)] rounded-full overflow-hidden">
          <div className="h-full w-1/3 bg-blue-500 rounded-full animate-[shimmer_1.5s_ease-in-out_infinite]"
            style={{
              animation: 'shimmer 1.5s ease-in-out infinite',
            }}
          />
        </div>

        <p className="text-xs text-[var(--muted)] font-mono">{elapsed}s elapsed</p>
      </div>
    </div>
  );
}

export function RunResultsPanel({ result, label, color, isRunning }) {
  if (!result && !isRunning) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--muted)] text-sm">
        Run a backtest to see results
      </div>
    );
  }

  if (!result && isRunning) {
    return (
      <div className="relative h-full">
        <RunningOverlay />
      </div>
    );
  }

  const borderColor = color === 'purple' ? 'border-purple-500/30' : 'border-blue-500/30';

  return (
    <div className="relative flex flex-col h-full overflow-hidden">
      {isRunning && <RunningOverlay />}
      {/* Summary bar */}
      <div className={cn('p-3 border-b border-[var(--border)] bg-[var(--surface)]', label && borderColor, label && 'border-l-2')}>
        {label && <p className="text-xs text-[var(--muted)] mb-1">{label}</p>}
        <div className="grid grid-cols-5 gap-3 text-center">
          <div>
            <p className="text-lg font-bold text-[var(--foreground)]">{result.totalTrades}</p>
            <p className="text-[10px] text-[var(--muted)]">Trades</p>
          </div>
          <div>
            <p className="text-lg font-bold text-green-400">{result.wins}</p>
            <p className="text-[10px] text-[var(--muted)]">Wins</p>
          </div>
          <div>
            <p className="text-lg font-bold text-red-400">{result.losses}</p>
            <p className="text-[10px] text-[var(--muted)]">Losses</p>
          </div>
          <div>
            <p className="text-lg font-bold text-[var(--foreground)]">{result.winRate}%</p>
            <p className="text-[10px] text-[var(--muted)]">Win Rate</p>
          </div>
          <div>
            <p className={cn('text-lg font-bold', pnlColor(result.totalPnlPts))}>
              {result.totalPnlPts > 0 ? '+' : ''}{result.totalPnlPts}
            </p>
            <p className="text-[10px] text-[var(--muted)]">P&L (pts)</p>
          </div>
        </div>
        <div className="flex justify-between mt-2 text-xs text-[var(--muted)]">
          <span>Avg Win: +{result.avgWinPts} pts</span>
          <span>Avg Loss: {result.avgLossPts} pts</span>
          {result.avgWinPts > 0 && result.avgLossPts < 0 && (
            <span>R:R {Math.abs(result.avgWinPts / result.avgLossPts).toFixed(2)}</span>
          )}
        </div>
      </div>

      {/* Tabs: Trade log | Exit Reasons | Patterns | Blocked */}
      <div className="flex-1 overflow-y-auto">
        {/* Exit Reason Breakdown */}
        {result.exitReasons && Object.keys(result.exitReasons).length > 0 && (
          <div className="p-3 border-b border-[var(--border)]">
            <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Exit Reasons</h3>
            <div className="space-y-1">
              {Object.entries(result.exitReasons)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, count]) => {
                  const pct = ((count / result.totalTrades) * 100).toFixed(0);
                  return (
                    <div key={reason} className="flex items-center gap-2">
                      <div className="flex-1">
                        <div className="flex justify-between text-xs mb-0.5">
                          <span className="text-[var(--foreground)]">{reason}</span>
                          <span className="text-[var(--muted)]">{count} ({pct}%)</span>
                        </div>
                        <div className="h-1 bg-[var(--border)] rounded">
                          <div
                            className="h-1 bg-blue-500/60 rounded"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Pattern Performance */}
        {result.patternPerformance && Object.keys(result.patternPerformance).length > 0 && (
          <div className="p-3 border-b border-[var(--border)]">
            <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Pattern Performance</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[var(--muted)]">
                  <th className="text-left py-1">Pattern</th>
                  <th className="text-right">W/L</th>
                  <th className="text-right">Win%</th>
                  <th className="text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(result.patternPerformance).map(([pattern, perf]) => {
                  const total = perf.wins + perf.losses;
                  const wr = total > 0 ? ((perf.wins / total) * 100).toFixed(0) : '—';
                  return (
                    <tr key={pattern} className="border-t border-[var(--border)]/30">
                      <td className="py-1 text-[var(--foreground)]">{pattern}</td>
                      <td className="text-right text-[var(--muted)]">{perf.wins}/{perf.losses}</td>
                      <td className="text-right">{wr}%</td>
                      <td className={cn('text-right', pnlColor(perf.totalPnl))}>
                        {perf.totalPnl > 0 ? '+' : ''}{perf.totalPnl.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Blocked Entries */}
        {result.blockedEntries > 0 && (
          <div className="p-3 border-b border-[var(--border)]">
            <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">
              Blocked Entries ({result.blockedEntries})
            </h3>
            <div className="space-y-1">
              {Object.entries(result.blockReasons || {})
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([reason, count]) => (
                  <div key={reason} className="flex justify-between text-xs">
                    <span className="text-[var(--foreground)] truncate mr-2">{reason}</span>
                    <span className="text-[var(--muted)] shrink-0">{count}</span>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Trade Log */}
        {result.trades && result.trades.length > 0 && (
          <div className="p-3">
            <h3 className="text-xs text-[var(--muted)] uppercase tracking-wider mb-2">Trade Log</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[var(--muted)]">
                    <th className="text-left py-1">Time</th>
                    <th className="text-left">Dir</th>
                    <th className="text-left">Pattern</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">Exit</th>
                    <th className="text-right">P&L</th>
                    <th className="text-left">Exit Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.map((t, i) => (
                    <tr key={i} className={cn('border-t border-[var(--border)]/20', t.isWin ? 'bg-green-500/5' : 'bg-red-500/5')}>
                      <td className="py-1 text-[var(--muted)]">{t.openedAt?.slice(11, 16)}</td>
                      <td className={t.direction === 'BULLISH' ? 'text-green-400' : 'text-red-400'}>
                        {t.direction === 'BULLISH' ? 'CALL' : 'PUT'}
                      </td>
                      <td className="text-[var(--foreground)]">{t.pattern}</td>
                      <td className="text-right text-[var(--muted)]">${t.entrySpx?.toFixed(0)}</td>
                      <td className="text-right text-[var(--muted)]">${t.exitSpx?.toFixed(0)}</td>
                      <td className={cn('text-right font-mono', pnlColor(t.spxChange))}>
                        {t.spxChange > 0 ? '+' : ''}{t.spxChange}
                      </td>
                      <td className="text-[var(--muted)]">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
