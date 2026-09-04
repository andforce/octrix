import { useState } from 'react';
import { api } from '../../lib/api';
import { AVAILABLE_COLORS, COLOR_MAP } from '../../types';
import { ENABLED_AGENTS, type AgentPlatform } from '../../agent-platforms';

interface Props {
  onClose: () => void;
}

export function AddAgentModal({ onClose }: Props) {
  const [selectedPlatform, setSelectedPlatform] = useState<AgentPlatform | null>(null);
  const [selectedColor, setSelectedColor] = useState('blue');

  const handleAdd = async () => {
    if (!selectedPlatform) return;
    await api.addAgent(selectedPlatform, selectedColor);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 backdrop-blur-md" onClick={onClose}>
      <div className="w-[380px] overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-panel" onClick={e => e.stopPropagation()}>
        <div className="border-b border-border px-5 py-4">
          <p className="font-display text-[11px] font-bold uppercase tracking-[0.2em] text-content-subtle">Install</p>
          <h3 className="font-display text-lg font-bold text-content">添加 AI Agent</h3>
        </div>

        <div className="space-y-4 p-5">
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-content-muted">选择平台</div>
            <div className="grid grid-cols-2 gap-2">
              {ENABLED_AGENTS.map(agent => {
                const selected = selectedPlatform === agent.platform;
                return (
                  <button
                    key={agent.platform}
                    type="button"
                    onClick={() => setSelectedPlatform(agent.platform)}
                    className={`rounded-xl border px-3 py-2 text-left transition ${
                      selected
                        ? 'border-accent bg-accent-muted shadow-[0_0_0_1px_rgba(255,95,61,0.35)]'
                        : 'border-border bg-surface-muted/80 hover:border-border-strong hover:bg-surface-hover'
                    }`}
                  >
                    <div className="text-sm font-semibold text-content">{agent.name}</div>
                    <div className="font-mono text-xs text-content-muted">{agent.cliLabel}</div>
                    <div className="mt-1 text-xs text-content-subtle">{agent.description}</div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-content-muted">颜色</span>
            {AVAILABLE_COLORS.map(c => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                onClick={() => setSelectedColor(c)}
                className={`h-6 w-6 rounded-full transition-transform ${
                  selectedColor === c
                    ? 'scale-110 ring-2 ring-white ring-offset-2 ring-offset-surface-elevated'
                    : 'hover:scale-105'
                }`}
                style={{ backgroundColor: COLOR_MAP[c] }}
              />
            ))}
          </div>
        </div>

        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl py-2.5 text-sm font-medium text-content-muted transition hover:bg-surface-hover hover:text-content"
          >
            取消
          </button>
          <button
            onClick={handleAdd}
            disabled={!selectedPlatform}
            className="flex-1 rounded-xl bg-accent py-2.5 text-sm font-semibold text-white shadow-glow transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
