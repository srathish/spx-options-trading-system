'use client';

import { useState } from 'react';
import { TradingProvider } from '../../lib/tradingContext';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { ChatPanel } from '../shared/ChatPanel';

export function AppShell({ children }) {
  const [chatOpen, setChatOpen] = useState(false);

  return (
    <TradingProvider>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex flex-col flex-1 overflow-hidden">
          <Header chatOpen={chatOpen} onChatToggle={() => setChatOpen(!chatOpen)} />
          <div className="flex flex-1 overflow-hidden">
            <main className={`flex-1 overflow-y-auto p-4 transition-all duration-200 ${chatOpen ? 'mr-[350px]' : ''}`}>
              {children}
            </main>
            {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
          </div>
        </div>
      </div>
    </TradingProvider>
  );
}
