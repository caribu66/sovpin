import React from 'react';
import { Dialog } from './Dialog';

/**
 * Explicit confirmation for destructive actions (unpin, takedown, revoke).
 * `onConfirm` may be async; the confirm button shows a busy state until it
 * settles. Render one per page, driven by a pending-action state.
 */
export function ConfirmDialog({
  pending,
  onCancel,
}: {
  pending: {
    title: string;
    body: string;
    confirmLabel: string;
    busyLabel?: string;
    onConfirm: () => void | Promise<void>;
  } | null;
  onCancel: () => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [seen, setSeen] = React.useState(pending);
  // Reset the confirm button when a new pending action arrives. Render-time
  // guard with a stored previous value — no subscription effect needed.
  if (pending !== seen) {
    setSeen(pending);
    setBusy(false);
  }

  return (
    <Dialog
      open={pending !== null}
      tone="error"
      label={pending?.title ?? 'Confirm'}
      onClose={() => {
        if (!busy) onCancel();
      }}
    >
      {pending && (
        <div className="space-y-3">
          <div className="text-sm font-bold text-[#F3F4F6]">{pending.title}</div>
          <p className="text-xs leading-relaxed text-[#9CA3AF]">{pending.body}</p>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await pending.onConfirm();
                } finally {
                  setBusy(false);
                }
              }}
              className="flex-1 px-4 py-2 bg-red-700 hover:bg-red-600 disabled:opacity-50 text-white font-bold text-xs cursor-pointer"
            >
              {busy ? pending.busyLabel || 'Working…' : pending.confirmLabel}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onCancel}
              className="flex-1 px-4 py-2 bg-[#090A0C] border border-[#22262E] hover:border-[#F3F4F6] text-[#F3F4F6] font-bold text-xs cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Pending-action state shape for ConfirmDialog. */
export type PendingConfirm = {
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel?: string;
  onConfirm: () => void | Promise<void>;
} | null;
