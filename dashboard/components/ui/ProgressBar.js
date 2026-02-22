'use client';

import { cn } from '../../lib/utils';

export function ProgressBar({ value, max = 100, color = 'bg-blue-500', className }) {
  const pct = Math.min(Math.max((value / max) * 100, 0), 100);
  return (
    <div className={cn('h-2 bg-[var(--border)] rounded-full overflow-hidden', className)}>
      <div className={cn('h-full rounded-full transition-all duration-500', color)} style={{ width: `${pct}%` }} />
    </div>
  );
}
