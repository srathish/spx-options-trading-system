'use client';

import { cn } from '../../lib/utils';

const VARIANTS = {
  BULLISH: 'bg-green-500/20 text-green-400 border-green-500/30',
  BEARISH: 'bg-red-500/20 text-red-400 border-red-500/30',
  NEUTRAL: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  CHOP: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  HIGH: 'bg-green-500/20 text-green-400 border-green-500/30',
  MEDIUM: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  LOW: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  OK: 'bg-green-500/20 text-green-400 border-green-500/30',
  ERROR: 'bg-red-500/20 text-red-400 border-red-500/30',
  WARN: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  FLAT: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  IN_CALLS: 'bg-green-500/20 text-green-400 border-green-500/30',
  IN_PUTS: 'bg-red-500/20 text-red-400 border-red-500/30',
  PENDING: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  DRIVER: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  CONFIRMING: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  FOLLOWING: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  VERY_HIGH: 'bg-green-500/20 text-green-400 border-green-500/30',
  MIXED: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  // Phase 5: Strategy version source badges
  INIT: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  NIGHTLY_REVIEW: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  WEEKLY_REVIEW: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  ROLLBACK: 'bg-red-500/20 text-red-400 border-red-500/30',
  MANUAL: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
  ACTIVE: 'bg-green-500/20 text-green-400 border-green-500/30',
  FLOOR: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
};

export function Badge({ label, className }) {
  const variant = VARIANTS[label] || VARIANTS.NEUTRAL;
  return (
    <span className={cn('inline-flex items-center px-2 py-0.5 text-xs font-medium border rounded', variant, className)}>
      {label}
    </span>
  );
}
