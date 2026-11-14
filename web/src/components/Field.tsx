import React from 'react';

/**
 * Labeled form field matching the console ledger style. Labels render
 * screen-reader-only by default (the dense UI shows placeholders); pass
 * `visible` for a persistent caption. Validation errors render inline and
 * are announced via aria-describedby.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  visible = false,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  visible?: boolean;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>;
}) {
  const hintId = hint ? `${htmlFor}-hint` : undefined;
  const errorId = error ? `${htmlFor}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="min-w-0">
      <label
        htmlFor={htmlFor}
        className={
          visible
            ? 'block text-[10px] uppercase text-[#6B7280] mb-1'
            : 'sr-only'
        }
      >
        {label}
      </label>
      {React.cloneElement(children, {
        id: htmlFor,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(error ? { 'aria-invalid': true as const } : {}),
      })}
      {hint && !error && (
        <div id={hintId} className="mt-1 text-[10px] font-mono text-[#6B7280]">
          {hint}
        </div>
      )}
      {error && (
        <div id={errorId} role="alert" className="mt-1 text-[10px] font-mono text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}
