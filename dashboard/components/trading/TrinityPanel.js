'use client';

import { useTradingContext } from '../../lib/tradingContext';
import { Card } from '../ui/Card';
import { Badge } from '../ui/Badge';
import { formatCurrency } from '../../lib/utils';

/**
 * Trinity Panel — Enhanced three-column cross-market GEX heatmap.
 * Shows SPXW, SPY, QQQ walls with king node highlights, driver badges,
 * stacked zone bands, and multi-ticker analysis narrative.
 */
export function TrinityPanel() {
  const { trinity } = useTradingContext();

  if (!trinity) {
    return (
      <Card title="Trinity Mode — Cross-Market GEX">
        <p className="text-[var(--muted)] text-sm py-4 text-center">Waiting for Trinity data...</p>
      </Card>
    );
  }

  const { spxw, spy, qqq, analysis } = trinity;

  return (
    <Card title="Trinity Mode — Cross-Market GEX">
      {/* Alignment banner */}
      <AlignmentBanner analysis={analysis} />

      {/* Three columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
        <TickerColumn data={spxw} fallbackTicker="SPXW" analysis={analysis} />
        <TickerColumn data={spy} fallbackTicker="SPY" analysis={analysis} />
        <TickerColumn data={qqq} fallbackTicker="QQQ" analysis={analysis} />
      </div>

      {/* Narrative block */}
      {analysis?.multi_signal && (
        <div className="mt-3 pt-3 border-t border-[var(--border)] text-xs text-[var(--muted)]">
          <span className="uppercase tracking-wider font-medium">Signal: </span>
          <span className="text-[var(--fg)]">{analysis.multi_signal.reason}</span>
        </div>
      )}

      {/* Node slides */}
      {analysis?.node_slides?.length > 0 && (
        <div className="mt-2 text-xs">
          {analysis.node_slides.map((slide, i) => (
            <div key={i} className="flex items-center gap-1 text-amber-400">
              <span>⚡</span>
              <span>{slide.description} → {slide.implication}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AlignmentBanner({ analysis }) {
  if (!analysis?.alignment) return null;

  const { alignment, multi_signal, driver } = analysis;
  const count = alignment.count || 0;
  const direction = alignment.direction || 'MIXED';
  const confidence = multi_signal?.confidence || 'LOW';

  const bgColor = direction === 'BULLISH' ? 'bg-green-500/10 border-green-500/20'
    : direction === 'BEARISH' ? 'bg-red-500/10 border-red-500/20'
    : 'bg-yellow-500/10 border-yellow-500/20';

  return (
    <div className={`rounded-lg border p-2 flex items-center justify-between ${bgColor}`}>
      <div className="flex items-center gap-2">
        <Badge label={direction} />
        <span className="text-sm font-mono">{count}/3 aligned</span>
        {confidence !== 'LOW' && <Badge label={confidence} />}
      </div>
      {driver && (
        <div className="flex items-center gap-1 text-xs">
          <Badge label="DRIVER" />
          <span className="text-[var(--muted)]">{driver.ticker}</span>
        </div>
      )}
    </div>
  );
}

function TickerColumn({ data, fallbackTicker, analysis }) {
  if (!data) {
    return (
      <div className="bg-[var(--bg)] rounded-lg p-3 border border-[var(--border)]">
        <div className="text-center">
          <span className="text-sm font-medium text-[var(--muted)]">{fallbackTicker}</span>
          <p className="text-xs text-[var(--muted)] mt-2">No data</p>
        </div>
      </div>
    );
  }

  const { ticker, spotPrice, scored, strikes, maxAbsGex, largestWall } = data;

  // Determine role badge (DRIVER / CONFIRMING / FOLLOWING)
  const role = getTickerRole(ticker, analysis);

  // Find stacked zones for this ticker
  const stackedZones = (analysis?.stacked_walls || [])
    .filter(sw => sw.ticker === ticker);

  // Find node slides for this ticker
  const slideStrikes = new Set(
    (analysis?.node_slides || [])
      .filter(ns => ns.ticker === ticker)
      .map(ns => ns.strike)
  );

  // King node strike
  const kingStrike = analysis?.king_nodes?.[ticker === 'SPXW' ? 'SPXW' : ticker]?.strike;

  return (
    <div className="bg-[var(--bg)] rounded-lg p-3 border border-[var(--border)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-bold">{ticker}</span>
          {role && <Badge label={role} />}
        </div>
        {scored && <Badge label={scored.direction} />}
      </div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-lg font-mono">{formatCurrency(spotPrice)}</span>
        {scored && <span className="text-xs font-mono text-[var(--muted)]">{scored.score}/100</span>}
      </div>

      {/* Strike list */}
      <div className="space-y-0 max-h-[320px] overflow-y-auto scrollbar-thin">
        {strikes && strikes.map(({ strike, gexValue }) => {
          const isInStacked = stackedZones.some(sz => strike >= sz.startStrike && strike <= sz.endStrike);
          return (
            <StrikeRow
              key={strike}
              strike={strike}
              gexValue={gexValue}
              maxAbsGex={maxAbsGex}
              isSpot={Math.abs(strike - spotPrice) <= getStrikeStep(ticker)}
              isKingNode={strike === kingStrike}
              isNodeSlide={slideStrikes.has(strike)}
              isStacked={isInStacked}
            />
          );
        })}
      </div>
    </div>
  );
}

function StrikeRow({ strike, gexValue, maxAbsGex, isSpot, isKingNode, isNodeSlide, isStacked }) {
  const barWidth = maxAbsGex > 0 ? Math.min(100, Math.abs(gexValue) / maxAbsGex * 100) : 0;
  const isPositive = gexValue >= 0;

  // Enhanced heatmap colors
  const barColor = getHeatmapColor(gexValue, maxAbsGex, isPositive);

  // Row background
  let rowBg = '';
  if (isSpot) rowBg = 'bg-white/10';
  else if (isKingNode) rowBg = 'bg-amber-500/10';
  else if (isStacked) rowBg = isPositive ? 'bg-green-500/5' : 'bg-red-500/5';

  return (
    <div className={`flex items-center gap-1 text-xs font-mono py-0.5 px-1 rounded ${rowBg}`}>
      {/* Spot / king marker */}
      <span className="w-3 shrink-0">
        {isSpot ? <span className="text-yellow-400">▸</span> : isNodeSlide ? <span className="text-amber-400">⚡</span> : ''}
      </span>

      {/* Strike */}
      <span className="w-12 text-right text-[var(--muted)] shrink-0">{strike}</span>

      {/* Bar */}
      <div className="flex-1 h-3 bg-[var(--surface)] rounded-sm overflow-hidden">
        <div
          className={`h-full rounded-sm ${barColor}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>

      {/* Value */}
      <span className={`w-16 text-right shrink-0 ${isPositive ? 'text-green-400' : 'text-red-400'}`}>
        {formatGexValue(gexValue)}
      </span>

      {/* King node marker */}
      <span className="w-3 shrink-0 text-amber-400">{isKingNode ? '♛' : ''}</span>
    </div>
  );
}

/**
 * Get heatmap bar color based on GEX value.
 * Positive: green → teal → bright yellow (for very large)
 * Negative: red → purple/magenta
 */
function getHeatmapColor(gexValue, maxAbsGex, isPositive) {
  if (maxAbsGex === 0) return 'bg-gray-600';
  const intensity = Math.abs(gexValue) / maxAbsGex;

  if (isPositive) {
    if (intensity > 0.75) return 'bg-yellow-400/80';     // Very large positive = bright yellow
    if (intensity > 0.50) return 'bg-teal-400/70';       // Large positive = teal
    if (intensity > 0.25) return 'bg-green-500/60';       // Medium positive = green
    return 'bg-green-600/40';                             // Small positive = dark green
  } else {
    if (intensity > 0.75) return 'bg-fuchsia-500/80';    // Very large negative = magenta
    if (intensity > 0.50) return 'bg-purple-500/70';      // Large negative = purple
    if (intensity > 0.25) return 'bg-red-500/60';         // Medium negative = red
    return 'bg-red-600/40';                               // Small negative = dark red
  }
}

function getTickerRole(ticker, analysis) {
  if (!analysis) return null;

  const driver = analysis.driver;
  if (driver?.ticker === ticker) return 'DRIVER';

  const alignment = analysis.alignment;
  if (!alignment) return null;

  // Check if this ticker's direction matches alignment
  return 'CONFIRMING';
}

function formatGexValue(value) {
  if (value == null) return '—';
  const abs = Math.abs(value);
  const sign = value >= 0 ? '' : '-';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

function getStrikeStep(ticker) {
  if (ticker === 'SPXW' || ticker === 'SPX') return 5;
  return 1;
}
