'use client';

import { useEffect, useState } from 'react';
import { fetchDecisions } from '../../lib/api';
import { RollbackBanner } from '../../components/strategy/RollbackBanner';
import { MorningBriefing } from '../../components/strategy/MorningBriefing';
import { VersionTimeline } from '../../components/strategy/VersionTimeline';
import { DecisionLog } from '../../components/strategy/DecisionLog';
import { WallMap } from '../../components/strategy/WallMap';

export default function StrategyPage() {
  const [decisions, setDecisions] = useState([]);

  useEffect(() => {
    fetchDecisions().then(setDecisions).catch(() => {});
    const id = setInterval(() => {
      fetchDecisions().then(setDecisions).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">Strategy</h1>
      <RollbackBanner />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <MorningBriefing />
        <VersionTimeline />
      </div>
      <WallMap />
      <DecisionLog decisions={decisions} />
    </div>
  );
}
