'use client';

import { useState, useEffect, useRef } from 'react';
import { XMarkIcon, PaperAirplaneIcon } from '@heroicons/react/24/outline';
import { sendBacktestChat } from '../../lib/api';

const SUGGESTION_CHIPS = [
  'How can I reduce losses?',
  'What params should I tune first?',
  'Analyze my exit reasons',
  'Reduce MOMENTUM_TIMEOUT exits',
];

export function BacktestChatPanel({ onClose, onApplyConfig, currentConfig, lastRunResults }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(text) {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    setInput('');
    setError(null);
    setMessages((prev) => [...prev, { sender: 'user', text: msg, timestamp: Date.now() }]);
    setLoading(true);

    try {
      const data = await sendBacktestChat(msg, currentConfig, lastRunResults, messages);
      setMessages((prev) => [
        ...prev,
        {
          sender: 'agent',
          text: data.reply,
          suggestedConfig: data.suggestedConfig,
          timestamp: Date.now(),
        },
      ]);
    } catch (err) {
      setError(err.message || 'Failed to send message');
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full bg-[var(--background)] border-l border-[var(--border)]">
      {/* Header */}
      <div className="h-12 shrink-0 flex items-center justify-between px-4 border-b border-[var(--border)] bg-[var(--surface)]">
        <span className="text-sm font-medium text-[var(--foreground)]">Strategy Advisor</span>
        <button
          onClick={onClose}
          className="text-[var(--muted)] hover:text-[var(--foreground)] transition-colors"
        >
          <XMarkIcon className="w-5 h-5" />
        </button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !loading && (
          <div className="space-y-3">
            <p className="text-[var(--muted)] text-sm text-center mt-4">
              Ask me about optimizing your strategy parameters.
            </p>
            <div className="flex flex-wrap gap-1 justify-center">
              {SUGGESTION_CHIPS.map((chip) => (
                <button
                  key={chip}
                  onClick={() => handleSend(chip)}
                  className="text-xs px-2 py-1 rounded-full border border-[var(--border)] text-[var(--muted)] hover:text-blue-400 hover:border-blue-500/30 transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.sender === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[90%] space-y-1">
              <div
                className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
                  msg.sender === 'user'
                    ? 'bg-blue-600/20 border border-blue-500/30 text-[var(--foreground)]'
                    : 'bg-[var(--surface)] border border-[var(--border)] text-[var(--foreground)]'
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{msg.text}</p>
              </div>

              {msg.suggestedConfig && onApplyConfig && (
                <button
                  onClick={() => onApplyConfig(msg.suggestedConfig)}
                  className="text-xs bg-green-600/20 border border-green-500/30 text-green-400 px-3 py-1.5 rounded-lg hover:bg-green-600/30 transition-colors"
                >
                  Apply to Editor ({Object.keys(msg.suggestedConfig).length} params)
                </button>
              )}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2">
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 bg-[var(--muted)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-[var(--border)] p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about strategy tuning..."
            disabled={loading}
            className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm text-[var(--foreground)] placeholder:text-[var(--muted)] focus:outline-none focus:border-blue-500/50 disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim()}
            className="p-2 rounded-lg bg-blue-600/20 border border-blue-500/30 text-blue-400 hover:bg-blue-600/30 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <PaperAirplaneIcon className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
