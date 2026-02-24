'use client';

import { SignalBanner } from '../components/trading/SignalBanner';
import { TradeCard } from '../components/trading/TradeCard';
import { GexPanel } from '../components/trading/GexPanel';
import { TvGrid } from '../components/trading/TvGrid';
import { AgentReasoning } from '../components/trading/AgentReasoning';
import { TrinityPanel } from '../components/trading/TrinityPanel';
import { AlertFeed } from '../components/trading/AlertFeed';

export default function TradingPage() {
  return (
    <div className="space-y-4">
      {/* Full-width signal banner */}
      <SignalBanner />

      {/* Full-width Trinity Panel */}
      <TrinityPanel />

      {/* Two-column: Trade Card + GEX Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TradeCard />
        <GexPanel />
      </div>

      {/* Two-column: TV Grid + Agent Reasoning */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TvGrid />
        <AgentReasoning />
      </div>

      {/* Full-width Alert Feed */}
      <AlertFeed />
    </div>
  );
}
