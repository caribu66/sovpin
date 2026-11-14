import { Monitor, Moon, Stars, Sun, type LucideIcon } from 'lucide-react';

export type Theme = 'dark' | 'light' | 'midnight' | 'system';
export type VrealMode = 'social' | 'theatre';

export interface ThemeDefinition {
  id: Theme;
  label: string;
  icon: LucideIcon;
}

export const THEME_CONFIG: Record<Theme, ThemeDefinition> = {
  dark: {
    id: 'dark',
    label: 'Dark',
    icon: Moon,
  },
  light: {
    id: 'light',
    label: 'Light',
    icon: Sun,
  },
  midnight: {
    id: 'midnight',
    label: 'Midnight',
    icon: Stars,
  },
  system: {
    id: 'system',
    label: 'System',
    icon: Monitor,
  },
};

export const AVAILABLE_THEMES = Object.values(THEME_CONFIG);

/**
 * Themes with fully implemented CSS variable blocks in index.css.
 * If a configured theme is selected without a CSS block, we map DOM rendering
 * to DEFAULT_THEME while preserving the user's selected theme in state.
 */
export const CSS_THEMES: ReadonlySet<Theme> = new Set(['dark', 'light', 'midnight']);

export function resolveDomTheme(theme: Theme): Theme {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return DEFAULT_THEME;
  }
  return CSS_THEMES.has(theme) ? theme : DEFAULT_THEME;
}

export function resolveVrealMode(theme: Theme): VrealMode | undefined {
  const domTheme = resolveDomTheme(theme);
  if (domTheme === 'light') return 'social';
  if (domTheme === 'dark' || domTheme === 'midnight') return 'theatre';
  return undefined;
}

export const DEFAULT_THEME: Theme = 'light';
export const STORAGE_KEY = 'app-theme';
