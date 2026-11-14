import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Dialog } from './Dialog';

describe('Dialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(
      <Dialog open={false} onClose={() => {}} label="Test">
        body
      </Dialog>
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('announces with dialog semantics and focuses dismiss', () => {
    render(
      <Dialog open onClose={() => {}} label="Success" tone="success">
        done
      </Dialog>
    );
    const dialog = screen.getByRole('dialog', { name: 'Success' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'Dismiss dialog' })).toHaveFocus();
  });

  it('uses alertdialog semantics for errors', () => {
    render(
      <Dialog open onClose={() => {}} label="Failure" tone="error">
        broken
      </Dialog>
    );
    expect(screen.getByRole('alertdialog', { name: 'Failure' })).toBeInTheDocument();
  });

  it('closes on Escape and overlay click, not on panel click', () => {
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} label="Test">
        body
      </Dialog>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('body').closest('div[class*="fixed"]')!);
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('dialog', { name: 'Test' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('traps Tab inside the dialog', () => {
    render(
      <Dialog open onClose={() => {}} label="Test">
        <button type="button">action</button>
      </Dialog>
    );
    const dismiss = screen.getByRole('button', { name: 'Dismiss dialog' });
    const action = screen.getByRole('button', { name: 'action' });
    expect(dismiss).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    // Focus was on the last element (dismiss), so Tab wraps to the first.
    expect(action).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(dismiss).toHaveFocus();
  });

  it('restores focus to the invoking control on close', () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open it
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} label="Test">
            body
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open it' });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('button', { name: 'Dismiss dialog' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

  it('locks background scroll while open', () => {
    const { unmount } = render(
      <Dialog open onClose={() => {}} label="Test">
        body
      </Dialog>
    );
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
