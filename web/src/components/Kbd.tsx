import type React from 'react';

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center px-1.5 py-0.5 text-[10px] font-mono leading-none text-[#9CA3AF] bg-[#090A0C] border border-[#22262E] rounded-sm">
      {children}
    </kbd>
  );
}
