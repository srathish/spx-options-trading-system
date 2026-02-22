'use client';

import { cn } from '../../lib/utils';

export function Skeleton({ className }) {
  return (
    <div className={cn('animate-pulse bg-[var(--border)] rounded', className)} />
  );
}
