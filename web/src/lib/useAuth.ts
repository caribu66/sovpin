import { useContext } from 'react';
import { Ctx } from './auth-state';
import type { AuthCtx } from './auth-context';

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c as AuthCtx;
}
