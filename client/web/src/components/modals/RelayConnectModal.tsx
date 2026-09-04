import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { OctrixCliStatus, RelayConfig, RelayStatus } from '../../types';

interface RelayConnectModalProps {
  onClose: () => void;
}

export function RelayConnectModal({ onClose }: RelayConnectModalProps) {
  const [config, setConfig] = useState<RelayConfig | null>(null);
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cliStatus, setCliStatus] = useState<OctrixCliStatus | null>(null);

  async function load() {
    try {
      const [nextConfig, nextStatus, nextCliStatus] = await Promise.all([
        api.getRelayConfig(),
        api.getRelayStatus(),
        api.getOctrixCliStatus(),
      ]);
      setConfig(nextConfig);
      setStatus(nextStatus);
      setCliStatus(nextCliStatus);
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取 Octrix Cloud 状态失败');
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, []);

  async function login(mode: 'browser' | 'device_code') {
    setBusy(true); setError(null);
    try {
      const pending = await api.startRelayAuthorization(mode);
      setStatus(current => current ? {
        ...current,
        authorizationState: 'pending',
        verificationUri: pending.verificationUri,
        userCode: pending.userCode,
        authorizationExpiresAt: pending.expiresAt,
      } : current);
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法开始授权');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!window.confirm('退出后这台 Mac 会立即从 Octrix Cloud 断开。继续吗？')) return;
    await api.logoutRelay();
    await load();
  }

  async function installCli() {
    try {
      const result = await api.installOctrixCli();
      setCliStatus(result);
    } catch (error) {
      setError(error instanceof Error ? error.message : '终端命令安装失败');
    }
  }

  const pending = status?.authorizationState === 'pending';
  const authorized = status?.authorizationState === 'authorized';
  const cliCurrent = cliStatus?.state === 'current';
  const cliOutdated = cliStatus?.state === 'outdated';
  const cloudUrl = status?.url ?? config?.url;
  const authorizationCenterUrl = cloudUrl ? `${cloudUrl.replace(/\/+$/, '')}/dashboard` : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 cursor-default" aria-label="关闭" onClick={onClose} />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-panel">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div><h2 className="font-display text-lg font-bold text-content">手机连接</h2><p className="mt-1 text-xs text-content-muted">账号与设备授权由 Octrix Cloud 统一管理。</p></div>
          <button type="button" onClick={onClose} className="rounded-xl p-2 text-content-subtle transition hover:bg-surface-hover hover:text-content" aria-label="关闭">
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="space-y-4 px-5 py-5">
          {error && <div className="rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-200">{error}</div>}
          {!status && !error && <div className="rounded-xl border border-border bg-surface-muted px-3 py-3 text-sm text-content-muted">正在读取连接状态…</div>}

          {status && <div className="space-y-3 rounded-xl border border-border bg-surface-muted px-4 py-4">
            <div className="flex items-center justify-between"><span className="text-sm text-content-muted">账号</span><span className="text-sm font-medium text-content">{status.accountLabel || (authorized ? 'Octrix 用户' : '尚未登录')}</span></div>
            <div className="flex items-center justify-between"><span className="text-sm text-content-muted">这台 Mac</span><span className="max-w-[240px] truncate text-sm text-content">{status.deviceName}</span></div>
            <div className="flex items-center justify-between"><span className="text-sm text-content-muted">云端状态</span><span className={status.connected ? 'text-sm text-mint' : 'text-sm text-content-subtle'}>{status.connected ? '在线' : authorized ? '正在连接' : '未连接'}</span></div>
          </div>}

          {pending && <div className="rounded-xl border border-accent/30 bg-accent/10 px-4 py-4 text-sm">
            {status?.userCode ? <><p className="text-content-muted">请访问 <span className="text-content">{status.verificationUri}</span>，输入：</p><p className="mt-3 text-center font-mono text-2xl font-bold tracking-[0.2em] text-content">{status.userCode}</p></> : <div className="flex items-center gap-3 text-content-muted"><span className="h-4 w-4 animate-spin rounded-full border-2 border-content-subtle border-t-accent" />等待你在浏览器确认授权…</div>}
          </div>}

          {!authorized && !pending && <div className="space-y-2">
            <button type="button" disabled={busy} onClick={() => void login('browser')} className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-white transition hover:bg-accent-hover disabled:opacity-50">{busy ? '正在连接…' : '使用浏览器登录'}</button>
            <button type="button" disabled={busy} onClick={() => void login('device_code')} className="w-full rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm font-medium text-content-muted transition hover:text-content disabled:opacity-50">使用 8 位设备码</button>
          </div>}

          <div className="rounded-xl border border-border bg-surface-muted/45 px-4 py-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-content">Octrix 命令行工具</p>
                  {cliStatus && <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${cliCurrent ? 'bg-mint/15 text-mint' : cliOutdated ? 'bg-amber-500/15 text-amber-300' : 'bg-surface-hover text-content-subtle'}`}>
                    {cliCurrent ? '已安装' : cliOutdated ? '需要更新' : '未安装'}
                  </span>}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-content-subtle">在终端检查这台 Mac、登录账号或修复云端连接。</p>
              </div>
              <button type="button" onClick={() => void installCli()} className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-medium text-content-muted hover:text-content">
                {cliCurrent ? '重新安装' : cliOutdated ? '更新' : '安装'}
              </button>
            </div>
            <div className="mt-3 grid gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5 font-mono text-[11px] text-content-muted">
              <div className="flex items-center justify-between gap-3"><code>octrix status</code><span className="font-sans text-content-subtle">检查连接</span></div>
              <div className="flex items-center justify-between gap-3"><code>octrix auth</code><span className="font-sans text-content-subtle">网页登录</span></div>
              <div className="flex items-center justify-between gap-3"><code>octrix auth --device-code</code><span className="font-sans text-content-subtle">设备码登录</span></div>
              <div className="flex items-center justify-between gap-3"><code>octrix logout</code><span className="font-sans text-content-subtle">退出账号</span></div>
            </div>
            {cliStatus && <p className="mt-2 break-all font-mono text-[10px] text-content-subtle">{cliStatus.path}</p>}
          </div>

          <div className="flex justify-end gap-2">
            {authorized && <button type="button" onClick={() => void logout()} className="rounded-xl border border-red-500/25 px-3 py-2 text-sm text-red-300 transition hover:bg-red-500/10">退出登录</button>}
            {authorizationCenterUrl && <a href={authorizationCenterUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-border bg-surface-muted px-3 py-2 text-sm text-content-muted transition hover:text-content">管理授权</a>}
            <button type="button" onClick={onClose} className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white transition hover:bg-accent-hover">完成</button>
          </div>
          {config && <p className="text-center text-[11px] text-content-subtle">设备 ID {config.deviceId.slice(0, 8)} · 凭证保存在系统钥匙串</p>}
        </div>
      </div>
    </div>
  );
}
