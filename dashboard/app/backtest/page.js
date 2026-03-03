'use client';

import { useState, useEffect } from 'react';
import { ChatBubbleLeftRightIcon, ArrowsRightLeftIcon } from '@heroicons/react/24/outline';
import { ConfigEditor } from '../../components/backtest/ConfigEditor';
import { RunResultsPanel } from '../../components/backtest/RunResultsPanel';
import { RunDiffView } from '../../components/backtest/RunDiffView';
import { BacktestChatPanel } from '../../components/backtest/BacktestChatPanel';
import { fetchBacktestDates, fetchActiveStrategy, runBacktest } from '../../lib/api';

export default function BacktestPage() {
  const [dates, setDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [defaultConfig, setDefaultConfig] = useState(null);
  const [config, setConfig] = useState(null);
  const [runA, setRunA] = useState(null);
  const [runB, setRunB] = useState(null);
  const [configA, setConfigA] = useState(null);
  const [configB, setConfigB] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [error, setError] = useState(null);

  // Load available dates and active strategy on mount
  useEffect(() => {
    fetchBacktestDates()
      .then(d => {
        setDates(d);
        if (d.length > 0) setSelectedDate(d[0].date);
      })
      .catch(() => {});

    fetchActiveStrategy()
      .then(s => {
        if (s?.config) {
          setDefaultConfig(s.config);
          setConfig({ ...s.config });
        }
      })
      .catch(() => {});
  }, []);

  async function handleRun(date, cfg) {
    if (!date) return;
    setIsRunning(true);
    setError(null);

    try {
      // Always send full config — backend merges onto active config
      const result = await runBacktest(date, cfg);

      if (!result) {
        setError('No data found for this date');
        return;
      }

      // Shift runs: B becomes the old A, new result becomes the latest
      if (runA) {
        setRunB(runA);
        setConfigB(configA);
      }
      setRunA(result);
      setConfigA({ ...cfg });
    } catch (err) {
      setError(err.message || 'Backtest failed');
    } finally {
      setIsRunning(false);
    }
  }

  function handleApplyConfig(suggestedConfig) {
    if (suggestedConfig && config) {
      setConfig({ ...config, ...suggestedConfig });
    }
  }

  if (!config) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--muted)] text-sm">
        Loading strategy config...
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: Config Editor */}
      <div className="w-72 shrink-0 border-r border-[var(--border)] bg-[var(--background)] flex flex-col">
        <div className="h-12 shrink-0 flex items-center px-4 border-b border-[var(--border)] bg-[var(--surface)]">
          <span className="text-sm font-medium text-[var(--foreground)]">Config</span>
        </div>
        <ConfigEditor
          config={config}
          defaultConfig={defaultConfig}
          onChange={setConfig}
          onRun={handleRun}
          isRunning={isRunning}
          dates={dates}
          selectedDate={selectedDate}
          onDateChange={setSelectedDate}
        />
      </div>

      {/* Center: Results */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Toolbar */}
        <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--surface)]">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-[var(--foreground)]">
              {showDiff ? 'Comparison' : 'Results'}
            </span>
            {runA && runB && (
              <button
                onClick={() => setShowDiff(!showDiff)}
                className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
                  showDiff
                    ? 'bg-purple-500/20 border-purple-500/30 text-purple-400'
                    : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
                }`}
              >
                <ArrowsRightLeftIcon className="w-3.5 h-3.5" />
                Compare
              </button>
            )}
          </div>
          <button
            onClick={() => setShowChat(!showChat)}
            className={`flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
              showChat
                ? 'bg-blue-500/20 border-blue-500/30 text-blue-400'
                : 'border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            <ChatBubbleLeftRightIcon className="w-3.5 h-3.5" />
            Advisor
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-hidden">
          {showDiff && runA && runB ? (
            <RunDiffView runA={runB} runB={runA} configA={configB} configB={configA} />
          ) : (
            <RunResultsPanel result={runA} isRunning={isRunning} />
          )}
        </div>
      </div>

      {/* Right: Chat panel (toggleable) */}
      {showChat && (
        <div className="w-[350px] shrink-0">
          <BacktestChatPanel
            onClose={() => setShowChat(false)}
            onApplyConfig={handleApplyConfig}
            currentConfig={config}
            lastRunResults={runA}
          />
        </div>
      )}
    </div>
  );
}
