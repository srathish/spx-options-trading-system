'use client';

import { useState, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { fetchBacktestPresets, saveBacktestPreset, deleteBacktestPreset } from '../../lib/api';

const PARAM_GROUPS = [
  {
    label: 'Entry Thresholds',
    params: [
      { key: 'gex_only_min_score', label: 'Min GEX Score', min: 0, max: 100, step: 5 },
      { key: 'alignment_min_for_entry', label: 'Min Alignment (of 3)', min: 0, max: 3, step: 1 },
      { key: 'alignment_override_gex_score', label: 'Alignment Override Score', min: 50, max: 100, step: 5 },
      { key: 'gex_strong_score', label: 'Strong GEX Score', min: 50, max: 100, step: 5 },
      { key: 'gex_strong_threshold', label: 'GEX Strong Threshold', min: 50, max: 100, step: 5 },
      { key: 'power_hour_min_gex_score', label: 'Power Hour Min Score', min: 50, max: 100, step: 5 },
      { key: 'structural_min_score', label: 'Structural Min Score', min: 30, max: 80, step: 5 },
      { key: 'min_entry_rr_ratio', label: 'Min Entry R:R Ratio', min: 1.0, max: 3.0, step: 0.1 },
      { key: 'midpoint_danger_zone_pct', label: 'Midpoint Buffer %', min: 0.03, max: 0.20, step: 0.01, format: 'pct' },
    ],
  },
  {
    label: 'Exit Thresholds',
    params: [
      { key: 'profit_target_pct', label: 'Profit Target %', min: 0.05, max: 0.50, step: 0.01, format: 'pct' },
      { key: 'stop_loss_pct', label: 'Stop Loss %', min: 0.05, max: 0.50, step: 0.01, format: 'pct' },
      { key: 'trailing_stop_activate_pts', label: 'Trailing Activate (pts)', min: 2, max: 20, step: 1 },
      { key: 'trailing_stop_distance_pts', label: 'Trailing Distance (pts)', min: 1, max: 15, step: 1 },
      { key: 'gex_exit_threshold', label: 'GEX Exit Threshold', min: 20, max: 80, step: 5 },
      { key: 'opposing_wall_exit_value', label: 'Opposing Wall ($M)', min: 1_000_000, max: 20_000_000, step: 1_000_000, format: 'millions' },
      { key: 'node_break_buffer_pts', label: 'Node Break Buffer (pts)', min: 0, max: 5, step: 0.5 },
    ],
  },
  {
    label: 'Momentum Phases',
    params: [
      { key: 'momentum_phase0_seconds', label: 'Phase 0 Timeout (s)', min: 15, max: 180, step: 15 },
      { key: 'momentum_phase0_min_pts', label: 'Phase 0 Min Points', min: 0, max: 5, step: 0.5 },
      { key: 'momentum_min_hold_minutes', label: 'Min Hold (min)', min: 1, max: 10, step: 1 },
      { key: 'momentum_phase1_minutes', label: 'Phase 1 Timeout (min)', min: 2, max: 15, step: 1 },
      { key: 'momentum_phase1_min_pts', label: 'Phase 1 Min Points', min: 0, max: 10, step: 0.5 },
      { key: 'momentum_phase2_minutes', label: 'Phase 2 Timeout (min)', min: 5, max: 20, step: 1 },
      { key: 'momentum_phase2_target_pct', label: 'Phase 2 Target %', min: 0.1, max: 0.8, step: 0.05, format: 'pct' },
      { key: 'momentum_phase3_minutes', label: 'Phase 3 Timeout (min)', min: 10, max: 30, step: 1 },
      { key: 'momentum_phase1_high_conf_minutes', label: 'Phase 1 High Conf (min)', min: 5, max: 15, step: 1 },
    ],
  },
  {
    label: 'Timing',
    params: [
      { key: 'entry_min_spacing_ms', label: 'Entry Spacing (ms)', min: 10_000, max: 300_000, step: 10_000, format: 'ms' },
      { key: 'consecutive_loss_limit', label: 'Loss Limit Before Cooldown', min: 1, max: 5, step: 1 },
      { key: 'consecutive_loss_cooldown_ms', label: 'Loss Cooldown (ms)', min: 60_000, max: 1_800_000, step: 60_000, format: 'ms' },
      { key: 'max_trades_per_pattern', label: 'Max Trades/Pattern/Day', min: 3, max: 15, step: 1 },
      { key: 'pattern_loss_limit', label: 'Pattern Loss Limit', min: 1, max: 5, step: 1 },
      { key: 'pattern_loss_cooldown_ms', label: 'Pattern Loss Cooldown (ms)', min: 300_000, max: 3_600_000, step: 300_000, format: 'ms' },
    ],
  },
  {
    label: 'Chop Detection',
    params: [
      { key: 'chop_lookback_cycles', label: 'Lookback Cycles', min: 20, max: 120, step: 10 },
      { key: 'chop_flip_threshold', label: 'Flip Threshold', min: 3, max: 12, step: 1 },
      { key: 'chop_stddev_threshold', label: 'StdDev Threshold', min: 10, max: 40, step: 5 },
      { key: 'chop_flip_rate_threshold', label: 'Flip Rate Threshold', min: 0.10, max: 0.60, step: 0.05, format: 'pct' },
      { key: 'chop_entry_spacing_ms', label: 'Chop Entry Spacing (ms)', min: 60_000, max: 300_000, step: 30_000, format: 'ms' },
    ],
  },
  {
    label: 'Trend Day Detection',
    params: [
      { key: 'trend_min_floor_value', label: 'Min Floor Value ($M)', min: 1_000_000, max: 20_000_000, step: 1_000_000, format: 'millions' },
      { key: 'trend_min_lookback_cycles', label: 'Min Lookback Cycles', min: 20, max: 120, step: 10 },
      { key: 'trend_min_floor_rise_pts', label: 'Min Floor Rise (pts)', min: 5, max: 30, step: 1 },
      { key: 'trend_min_directional_bias_pct', label: 'Min Bias %', min: 0.40, max: 0.80, step: 0.05, format: 'pct' },
      { key: 'trend_min_spot_move_pts', label: 'Min Spot Move (pts)', min: 5, max: 25, step: 1 },
      { key: 'trend_deactivate_floor_drop_pts', label: 'Deactivate Floor Drop (pts)', min: 5, max: 20, step: 1 },
      { key: 'trend_deactivate_bias_threshold', label: 'Deactivate Bias Threshold', min: 0.20, max: 0.60, step: 0.05, format: 'pct' },
    ],
  },
  {
    label: 'Trend Day Exits',
    params: [
      { key: 'trend_profit_target_multiplier', label: 'Profit Target Mult', min: 1.0, max: 5.0, step: 0.5 },
      { key: 'trend_stop_loss_multiplier', label: 'Stop Loss Mult', min: 1.0, max: 4.0, step: 0.5 },
      { key: 'trend_stop_multiplier', label: 'Entry Stop Mult', min: 1.0, max: 3.0, step: 0.25 },
      { key: 'trend_trail_activate_pts', label: 'Trend Trail Activate (pts)', min: 2, max: 15, step: 1 },
      { key: 'trend_trail_distance_pts', label: 'Trend Trail Distance (pts)', min: 3, max: 15, step: 1 },
      { key: 'trend_momentum_time_multiplier', label: 'Momentum Time Mult', min: 1.0, max: 3.0, step: 0.25 },
      { key: 'trend_gex_flip_required_cycles', label: 'GEX Flip Required Cycles', min: 1, max: 5, step: 1 },
      { key: 'breakout_score_threshold', label: 'Breakout Score Threshold', min: 80, max: 100, step: 5 },
      { key: 'breakout_stop_multiplier', label: 'Breakout Stop Mult', min: 1.0, max: 2.0, step: 0.1 },
    ],
  },
  {
    label: 'Trend Pullback Entry',
    params: [
      { key: 'trend_pullback_min_score', label: 'Min Score', min: 20, max: 70, step: 5 },
      { key: 'trend_pullback_max_dist_pts', label: 'Max Distance (pts)', min: 3, max: 15, step: 1 },
      { key: 'trend_pullback_stop_buffer_pts', label: 'Stop Buffer (pts)', min: 2, max: 10, step: 1 },
      { key: 'trend_reentry_spacing_ms', label: 'Trend Re-entry Spacing (ms)', min: 10_000, max: 120_000, step: 10_000, format: 'ms' },
    ],
  },
  {
    label: 'TV Signals',
    params: [
      { key: 'tv_against_exit_count', label: 'TV Flip Exit Count', min: 1, max: 3, step: 1 },
      { key: 'tv_counter_flip_min_indicators', label: 'Counter Flip Indicators', min: 1, max: 3, step: 1 },
    ],
  },
];

function formatValue(val, format) {
  if (val == null) return '—';
  if (format === 'pct') return `${val}%`;
  if (format === 'ms') return `${(val / 1000).toFixed(0)}s`;
  if (format === 'millions') return `$${(val / 1_000_000).toFixed(0)}M`;
  return String(val);
}

export function ConfigEditor({ config, defaultConfig, onChange, onRun, isRunning, dates, selectedDate, onDateChange }) {
  const [presets, setPresets] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(
    Object.fromEntries(PARAM_GROUPS.map(g => [g.label, true]))
  );

  useEffect(() => {
    fetchBacktestPresets().then(setPresets).catch(() => {});
  }, []);

  function handleParamChange(key, value) {
    onChange({ ...config, [key]: Number(value) });
  }

  function handleReset(key) {
    if (defaultConfig && defaultConfig[key] !== undefined) {
      onChange({ ...config, [key]: defaultConfig[key] });
    }
  }

  function handleLoadPreset(preset) {
    onChange({ ...defaultConfig, ...preset.config });
  }

  async function handleSavePreset() {
    if (!saveName.trim()) return;
    try {
      await saveBacktestPreset(saveName.trim(), config);
      const updated = await fetchBacktestPresets();
      setPresets(updated);
      setSaveName('');
      setShowSave(false);
    } catch (err) {
      console.error('Save preset failed:', err);
    }
  }

  async function handleDeletePreset(name) {
    try {
      await deleteBacktestPreset(name);
      const updated = await fetchBacktestPresets();
      setPresets(updated);
    } catch (err) {
      console.error('Delete preset failed:', err);
    }
  }

  function handleExportJson() {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `backtest-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function toggleGroup(label) {
    setExpandedGroups(prev => ({ ...prev, [label]: !prev[label] }));
  }

  const changedCount = defaultConfig
    ? Object.keys(config).filter(k => config[k] !== defaultConfig[k]).length
    : 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Date picker + Run */}
      <div className="p-3 border-b border-[var(--border)] space-y-2">
        <label className="text-xs text-[var(--muted)] uppercase tracking-wider">Date</label>
        <select
          value={selectedDate}
          onChange={(e) => onDateChange(e.target.value)}
          className="w-full bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-sm text-[var(--foreground)]"
        >
          <option value="">Select date...</option>
          {dates.map(d => (
            <option key={d.date} value={d.date}>
              {d.date} ({d.snapshots} snapshots)
            </option>
          ))}
        </select>

        <button
          onClick={() => onRun(selectedDate, config)}
          disabled={isRunning || !selectedDate}
          className="w-full py-2 rounded bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {isRunning ? 'Running...' : 'Run Backtest'}
        </button>

        {changedCount > 0 && (
          <p className="text-xs text-yellow-400">{changedCount} param{changedCount !== 1 ? 's' : ''} modified from active</p>
        )}
      </div>

      {/* Presets */}
      <div className="p-3 border-b border-[var(--border)] space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs text-[var(--muted)] uppercase tracking-wider">Presets</label>
          <div className="flex gap-1">
            <button onClick={() => setShowSave(true)} className="text-xs text-blue-400 hover:text-blue-300">Save</button>
            <span className="text-[var(--muted)]">|</span>
            <button onClick={() => onChange({ ...defaultConfig })} className="text-xs text-blue-400 hover:text-blue-300">Reset</button>
            <span className="text-[var(--muted)]">|</span>
            <button onClick={handleExportJson} className="text-xs text-blue-400 hover:text-blue-300">Export</button>
          </div>
        </div>

        {showSave && (
          <div className="flex gap-1">
            <input
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
              placeholder="Preset name..."
              className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs text-[var(--foreground)]"
              onKeyDown={(e) => e.key === 'Enter' && handleSavePreset()}
            />
            <button onClick={handleSavePreset} className="text-xs bg-blue-600 text-white px-2 py-1 rounded">Save</button>
            <button onClick={() => setShowSave(false)} className="text-xs text-[var(--muted)] px-1">X</button>
          </div>
        )}

        {presets.length > 0 && (
          <div className="space-y-1 max-h-24 overflow-y-auto">
            {presets.map(p => (
              <div key={p.name} className="flex items-center justify-between text-xs">
                <button
                  onClick={() => handleLoadPreset(p)}
                  className="text-[var(--foreground)] hover:text-blue-400 truncate"
                  title={p.description || p.name}
                >
                  {p.name}
                </button>
                <button onClick={() => handleDeletePreset(p.name)} className="text-red-400/50 hover:text-red-400 ml-1 shrink-0">x</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Parameter groups */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {PARAM_GROUPS.map(group => (
          <div key={group.label} className="border border-[var(--border)] rounded">
            <button
              onClick={() => toggleGroup(group.label)}
              className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-[var(--foreground)] hover:bg-[var(--surface)]"
            >
              <span>{group.label}</span>
              <span className="text-[var(--muted)]">{expandedGroups[group.label] ? '−' : '+'}</span>
            </button>

            {expandedGroups[group.label] && (
              <div className="px-3 pb-3 space-y-3">
                {group.params.map(param => {
                  const val = config[param.key];
                  const isChanged = defaultConfig && val !== defaultConfig[param.key];
                  return (
                    <div key={param.key} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className={cn('text-xs', isChanged ? 'text-yellow-400' : 'text-[var(--muted)]')}>
                          {param.label}
                        </label>
                        <div className="flex items-center gap-1">
                          <span className={cn('text-xs font-mono', isChanged ? 'text-yellow-400' : 'text-[var(--foreground)]')}>
                            {formatValue(val, param.format)}
                          </span>
                          {isChanged && (
                            <button
                              onClick={() => handleReset(param.key)}
                              className="text-[10px] text-[var(--muted)] hover:text-[var(--foreground)]"
                              title="Reset to active"
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      </div>
                      <input
                        type="range"
                        min={param.min}
                        max={param.max}
                        step={param.step}
                        value={val ?? param.min}
                        onChange={(e) => handleParamChange(param.key, e.target.value)}
                        className="w-full h-1 accent-blue-500"
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
