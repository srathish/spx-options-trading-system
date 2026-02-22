/**
 * Formatting utilities for the dashboard.
 */

export function formatCurrency(value, decimals = 2) {
  if (value == null) return '—';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

export function formatPct(value, decimals = 1) {
  if (value == null) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(decimals)}%`;
}

export function formatET(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
  } catch {
    return isoString;
  }
}

export function formatETDate(isoString) {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    return d.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return isoString;
  }
}

export function cn(...classes) {
  return classes.filter(Boolean).join(' ');
}

export function pnlColor(value) {
  if (value == null || value === 0) return 'text-gray-400';
  return value > 0 ? 'text-green-400' : 'text-red-400';
}

export function directionColor(direction) {
  if (direction === 'BULLISH') return 'text-green-400';
  if (direction === 'BEARISH') return 'text-red-400';
  return 'text-yellow-400';
}
