'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '../../lib/utils';
import {
  BoltIcon,
  ChartBarIcon,
  AdjustmentsHorizontalIcon,
  CpuChipIcon,
  LightBulbIcon,
} from '@heroicons/react/24/outline';

const NAV = [
  { href: '/', label: 'Trading', icon: BoltIcon },
  { href: '/ideas', label: 'Phantoms', icon: LightBulbIcon },
  { href: '/performance', label: 'Performance', icon: ChartBarIcon },
  { href: '/strategy', label: 'Strategy', icon: AdjustmentsHorizontalIcon },
  { href: '/system', label: 'System', icon: CpuChipIcon },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav className="w-16 bg-[var(--surface)] border-r border-[var(--border)] flex flex-col items-center py-4 gap-2 shrink-0">
      <div className="text-lg font-bold text-green-400 mb-4">GC</div>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            title={label}
            className={cn(
              'w-10 h-10 flex items-center justify-center rounded-lg transition-colors',
              active ? 'bg-[var(--border)] text-white' : 'text-[var(--muted)] hover:text-white hover:bg-[var(--border)]/50'
            )}
          >
            <Icon className="w-5 h-5" />
          </Link>
        );
      })}
    </nav>
  );
}
