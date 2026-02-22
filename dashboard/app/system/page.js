'use client';

import { useEffect, useState } from 'react';
import { fetchSystemHealth, fetchCosts } from '../../lib/api';
import { ServiceGrid } from '../../components/system/ServiceGrid';
import { CostTracker } from '../../components/system/CostTracker';
import { LoopStatus } from '../../components/system/LoopStatus';
import { ErrorLog } from '../../components/system/ErrorLog';

export default function SystemPage() {
  const [health, setHealth] = useState(null);
  const [costs, setCosts] = useState(null);

  useEffect(() => {
    fetchSystemHealth().then(setHealth).catch(() => {});
    fetchCosts().then(setCosts).catch(() => {});

    const id = setInterval(() => {
      fetchSystemHealth().then(setHealth).catch(() => {});
      fetchCosts().then(setCosts).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">System</h1>
      <ServiceGrid />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <LoopStatus />
        <CostTracker costs={costs} />
      </div>
      <ErrorLog health={health?.health} />
    </div>
  );
}
