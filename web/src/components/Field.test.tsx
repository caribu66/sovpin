import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field';

describe('Field', () => {
  it('labels the control and announces errors', () => {
    render(
      <Field label="Webhook URL" htmlFor="wh-url" error="Must start with http(s)://">
        <input type="text" className="x" />
      </Field>
    );
    const input = screen.getByLabelText('Webhook URL');
    expect(input).toHaveAttribute('id', 'wh-url');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('Must start with http(s)://');
    expect(input).toHaveAttribute('aria-describedby', error.id);
  });

  it('shows hints without errors', () => {
    render(
      <Field label="Events" htmlFor="wh-events" hint="Comma separated">
        <input type="text" className="x" />
      </Field>
    );
    expect(screen.getByText('Comma separated')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
