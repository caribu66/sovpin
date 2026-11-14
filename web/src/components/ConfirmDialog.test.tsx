import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

const pending = {
  title: 'Unpin "a.json"?',
  body: 'The object is removed from your tenant ledger.',
  confirmLabel: 'Unpin object',
  onConfirm: vi.fn(),
};

describe('ConfirmDialog', () => {
  it('renders nothing without a pending action', () => {
    const { container } = render(<ConfirmDialog pending={null} onCancel={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms the destructive action', async () => {
    const onConfirm = vi.fn(async () => {});
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        pending={{ ...pending, onConfirm }}
        onCancel={onCancel}
      />
    );
    expect(screen.getByRole('alertdialog', { name: 'Unpin "a.json"?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin object' }));
    await vi.waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancels without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<ConfirmDialog pending={{ ...pending, onConfirm }} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
