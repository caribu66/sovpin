import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export function CopyInline({
  value,
  label,
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setFailed(false);
    const ta = document.createElement('textarea');
    let appended = false;
    try {
      // Try the modern Clipboard API first
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
          return;
        } catch {
          // Fall through to execCommand fallback
        }
      }
      // Fallback: textarea + execCommand
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      appended = true;
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);
      if (!document.execCommand('copy')) throw new Error('execCommand copy failed');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
      setTimeout(() => setFailed(false), 2000);
    } finally {
      if (appended && ta.parentNode) document.body.removeChild(ta);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={failed ? 'Copy failed — select the text manually' : 'Copy to clipboard'}
      aria-label={label ? undefined : failed ? 'Copy failed' : copied ? 'Copied' : 'Copy to clipboard'}
      className={`inline-flex items-center gap-1 transition duration-75 cursor-pointer ${failed ? 'text-red-400' : 'text-[#6B7280] hover:text-[#F3F4F6]'} ${className}`}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-[#10B981]" aria-hidden="true" />
      ) : (
        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
      )}
      {label && (
        <span className={`text-[11px] font-mono ${copied ? 'text-[#10B981]' : ''}`}>
          {failed ? 'Copy failed' : copied ? 'Copied' : label}
        </span>
      )}
      {/* Always-rendered announcement so icon-only copies are perceivable. */}
      <span aria-live="polite" className="sr-only">
        {failed ? 'Copy failed' : copied ? 'Copied to clipboard' : ''}
      </span>
    </button>
  );
}

