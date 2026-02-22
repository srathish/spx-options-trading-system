'use client';

import { useEffect, useState } from 'react';
import { fetchPerformance, fetchTodaysTrades, fetchPhantoms } from '../../lib/api';
import { TodaySummary } from '../../components/performance/TodaySummary';
import { TradeLog } from '../../components/performance/TradeLog';
import { EquityCurve } from '../../components/performance/EquityCurve';
import { PhantomTrades } from '../../components/performance/PhantomTrades';

export default function PerformancePage() {
  const [performance, setPerformance] = useState(null);
  const [trades, setTrades] = useState([]);
  const [phantoms, setPhantoms] = useState([]);

  useEffect(() => {
    fetchPerformance().then(setPerformance).catch(() => {});
    fetchTodaysTrades().then(setTrades).catch(() => {});
    fetchPhantoms().then(setPhantoms).catch(() => {});

    const id = setInterval(() => {
      fetchPerformance().then(setPerformance).catch(() => {});
      fetchTodaysTrades().then(setTrades).catch(() => {});
    }, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-medium">Performance</h1>
      <TodaySummary performance={performance} />
      <EquityCurve trades={trades} />
      <TradeLog trades={trades} />
      <PhantomTrades phantoms={phantoms} />
    </div>
  );
}
