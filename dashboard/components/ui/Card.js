'use client';

import { cn } from '../../lib/utils';

export function Card({ children, className, title }) {
  return (
    <div className={cn('bg-[var(--surface)] border border-[var(--border)] rounded-lg p-4', className)}>
      {title && <h3 className="text-sm font-medium text-[var(--muted)] mb-3 uppercase tracking-wider">{title}</h3>}
      {children}
    </div>
  );
}
