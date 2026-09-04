import { useState } from 'react';
import { createPortal } from 'react-dom';

interface DeleteConfirmDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  loadingLabel?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function DeleteConfirmDialog({
  title,
  description,
  confirmLabel,
  loadingLabel,
  onConfirm,
  onCancel,
}: DeleteConfirmDialogProps) {
  const [isConfirming, setIsConfirming] = useState(false);

  const handleConfirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    try {
      await onConfirm();
    } finally {
      setIsConfirming(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={() => {
        if (!isConfirming) {
          onCancel();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-md" />
      <div
        className="relative flex w-80 flex-col gap-4 rounded-2xl border border-border-strong bg-surface-elevated p-6 shadow-panel"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-red-500/15 ring-1 ring-red-500/25">
            <svg className="h-5 w-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-display text-sm font-semibold text-content">{title}</p>
            <p className="mt-1 text-sm text-content-muted">{description}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isConfirming}
            className="rounded-xl px-4 py-2 text-sm font-medium text-content-muted transition-colors hover:bg-surface-hover hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={isConfirming}
            className="inline-flex min-w-[88px] items-center justify-center gap-2 rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white shadow-insetHighlight transition hover:bg-red-400 disabled:cursor-wait disabled:bg-red-400/80"
          >
            {isConfirming && (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-30" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-100" d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            {isConfirming ? (loadingLabel ?? `${confirmLabel}中...`) : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
