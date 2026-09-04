import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';

interface DraggableTerminalDialogProps {
  title: string;
  subtitle?: string;
  badge?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number | string;
  height?: number | string;
  maxWidth?: number | string;
  maxHeight?: number | string;
  zIndexClassName?: string;
}

interface Position {
  left: number;
  top: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function DraggableTerminalDialog({
  title,
  subtitle,
  badge,
  onClose,
  children,
  width = 'min(1100px, 88vw)',
  height = 'min(720px, 76vh)',
  maxWidth = '88vw',
  maxHeight = '82vh',
  zIndexClassName = 'z-50',
}: DraggableTerminalDialogProps) {
  const windowRef = useRef<HTMLDivElement>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [position, setPosition] = useState<Position | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const windowStyle = useMemo<CSSProperties>(
    () => ({
      width,
      height,
      maxWidth,
      maxHeight,
      ...(position
        ? { left: position.left, top: position.top }
        : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }),
    }),
    [height, maxHeight, maxWidth, position, width],
  );

  useEffect(() => {
    if (!isDragging) return undefined;

    const handleMouseMove = (event: MouseEvent) => {
      const element = windowRef.current;
      if (!element) return;

      const rect = element.getBoundingClientRect();
      const nextLeft = event.clientX - dragOffsetRef.current.x;
      const nextTop = event.clientY - dragOffsetRef.current.y;
      const maxLeft = Math.max(16, window.innerWidth - rect.width - 16);
      const maxTop = Math.max(16, window.innerHeight - rect.height - 16);

      setPosition({
        left: clamp(nextLeft, 16, maxLeft),
        top: clamp(nextTop, 16, maxTop),
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleDragStart = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) return;
    const element = windowRef.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    dragOffsetRef.current = {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    setPosition({ left: rect.left, top: rect.top });
    setIsDragging(true);
    event.preventDefault();
  };

  const recenterWindow = () => {
    setPosition(null);
  };

  return (
    <div className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/60 backdrop-blur-md`} onClick={onClose}>
      <div
        ref={windowRef}
        className="fixed flex flex-col overflow-hidden rounded-[8px] border border-border-strong bg-[#07090d]/96 shadow-[0_28px_90px_rgba(0,0,0,0.55)] ring-1 ring-white/6"
        style={windowStyle}
        onClick={event => event.stopPropagation()}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(79,209,197,0.12),transparent_38%),linear-gradient(135deg,rgba(255,95,61,0.08),transparent_32%),linear-gradient(180deg,rgba(12,15,21,0.98),rgba(7,9,13,1))]" />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

        <div
          className={`relative flex items-center justify-between border-b border-white/8 px-5 py-4 select-none ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          onMouseDown={handleDragStart}
          onDoubleClick={recenterWindow}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mint opacity-45" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-mint shadow-[0_0_10px_rgba(79,209,197,0.75)]" />
                </span>
                <span className="truncate font-mono text-sm font-semibold tracking-[0.02em] text-content">{title}</span>
              </span>
              {badge && (
                <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-content-subtle">
                  {badge}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="mt-1 truncate text-xs text-content-subtle">{subtitle}</p>
            )}
          </div>

          <div className="ml-4 flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-content-subtle transition hover:border-red-400/35 hover:bg-red-500/10 hover:text-red-200"
              title="关闭终端"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 p-4 pt-3">
          <div className="h-full overflow-hidden rounded-[8px] border border-white/10 bg-[#05070a] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_20px_40px_rgba(0,0,0,0.32)]">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
