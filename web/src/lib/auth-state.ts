import { createContext } from 'react';
import type { AuthCtx } from './auth-context';

export const Ctx = createContext<AuthCtx | null>(null);
