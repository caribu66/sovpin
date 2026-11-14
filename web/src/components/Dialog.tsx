import React, { useEffect, useId, useRef } from 'react';

export type DialogTone = 'success' | 'error' | 'plain';

const toneStyles: Record<DialogTone, string> = {
  success: 'bg-[#111317] border-[#10B981] text-[#10B981]',
  error: 'bg-[#181B20] border-red-800 text-red-400',
  plain: 'bg-[#111317] border-[#22262E] text-[#F3F4F6]',
};

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Shared accessible modal. Traps Tab focus while open, restores focus to the
 * invoking control on close, closes on Escape and overlay click, and locks
 * background scroll. Visual style matches the console ledger
 * (mono, hairline borders).
 */
export function Dialog({
  open,
  onClose,
  tone = 'plain',
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  tone?: DialogTone;
  label: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  // Parent re-renders (progress ticks, refetch timers) must not reset focus,
  // so the effect below depends on `open` only and reads the handler by ref.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => !el.hasAttribute('disabled'));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [open ]);

  if (!open) return null;

  const describedBy = tone === 'error' ? messageId : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={() => onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role={tone === 'error' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-label={label}
        aria-describedby={describedBy}
        className={`max-w-md w-full border text-sm font-mono p-5 shadow-2xl ${toneStyles[tone]}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1" id={tone === 'error' ? messageId : undefined}>
            {children}
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Dismiss dialog"
            onClick={() => onCloseRef.current()}
            className="text-[#6B7280] hover:text-[#F3F4F6] shrink-0 text-lg leading-none cursor-pointer"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
