'use client';

import { createContext, useContext, useReducer, useCallback } from 'react';
import { useWebSocket } from './useWebSocket';

const TradingContext = createContext(null);

const initialState = {
  connected: false,
  loop: null,
  phase: null,
  gex: null,
  decision: null,
  position: null,
  lastTrade: null,
  tv: null,
  trinity: null,
  alerts: [],
  serverTime: null,
  lastEvent: null,
};

function reducer(state, action) {
  switch (action.type) {
    case 'FULL_STATE':
      return {
        ...state,
        loop: action.data.loop,
        phase: action.data.phase,
        gex: action.data.gex,
        decision: action.data.decision,
        position: action.data.position,
        tv: action.data.tv,
        trinity: action.data.trinity,
        serverTime: action.data.serverTime,
        lastEvent: 'FULL_STATE',
      };

    case 'gex_update':
      return { ...state, gex: { ...state.gex, ...action.data }, lastEvent: 'gex_update' };

    case 'tv_update':
      return { ...state, tv: action.data, lastEvent: 'tv_update' };

    case 'decision_update':
      return { ...state, decision: { ...state.decision, ...action.data, entryBlocked: null }, lastEvent: 'decision_update' };

    case 'entry_blocked':
      return { ...state, decision: { ...state.decision, entryBlocked: action.data }, lastEvent: 'entry_blocked' };

    case 'position_update':
      return {
        ...state,
        position: { ...state.position, details: { ...state.position?.details, ...action.data } },
        lastEvent: 'position_update',
      };

    case 'trade_opened':
      return {
        ...state,
        position: { state: 'PENDING', details: action.data },
        lastTrade: null,
        lastEvent: 'trade_opened',
      };

    case 'trade_closed':
      return {
        ...state,
        position: { state: 'FLAT', details: null },
        lastTrade: { ...action.data, closedAt: Date.now() },
        lastEvent: 'trade_closed',
      };

    case 'trinity_update':
      return { ...state, trinity: action.data, lastEvent: 'trinity_update' };

    case 'health_update':
      return { ...state, loop: action.data.loop, serverTime: action.data.time, lastEvent: 'health_update' };

    case 'alert':
      return {
        ...state,
        alerts: [{ ...action.data, ts: Date.now() }, ...state.alerts].slice(0, 50),
        lastEvent: 'alert',
      };

    case 'SET_CONNECTED':
      return { ...state, connected: action.connected };

    default:
      return state;
  }
}

export function TradingProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const onMessage = useCallback((event, data) => {
    dispatch({ type: event, data });
  }, []);

  const { connected } = useWebSocket(onMessage);

  // Sync connected state
  if (state.connected !== connected) {
    dispatch({ type: 'SET_CONNECTED', connected });
  }

  return (
    <TradingContext.Provider value={state}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext() {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error('useTradingContext must be inside TradingProvider');
  return ctx;
}
