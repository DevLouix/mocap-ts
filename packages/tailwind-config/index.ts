import type { Config } from 'tailwindcss';

/**
 * Notion-inspired design tokens, shared across all mocap-ts apps.
 *
 * Visual language (matching Notion):
 *   - Warm neutral grayscale (paper backgrounds, ink text)
 *   - A single restrained accent (Notion-ish blue) used sparingly
 *   - Generous whitespace, thin 1px borders, subtle shadows
 *   - 4px base radius scale; buttons/inputs at 4-6px (Notion is squared)
 *   - Inter / system font stack with feature settings for tabular numbers
 *
 * Apps extend this base and may override the `accent` family to re-skin
 * without touching component code.
 */
export const notionBaseConfig: Config = {
  darkMode: ['class'],
  theme: {
    extend: {
      colors: {
        // Neutral grayscale — warm, paper-like (Notion's signature palette).
        surface: {
          DEFAULT: '#ffffff',
          subtle: '#fbfbfa',
          muted: '#f7f6f3',
          hover: '#f1f0ec',
          active: '#e9e8e3',
          overlay: 'rgba(55, 53, 47, 0.08)',
        },
        ink: {
          DEFAULT: '#37352f',
          muted: '#6b6a64',
          subtle: '#9b9a93',
          onAccent: '#ffffff',
        },
        border: {
          DEFAULT: '#ebebea',
          strong: '#e0e0de',
        },
        // The one accent — a restrained Notion-blue. Used for primary actions,
        // links, and progress. Never as a background fill for large areas.
        accent: {
          DEFAULT: '#2383e2',
          hover: '#0b6bcb',
          subtle: '#e8f1fb',
          foreground: '#ffffff',
        },
        // Semantic states — kept dim so they don't fight the accent.
        success: '#0f7b3b',
        warning: '#c8821b',
        danger: '#e03e3e',
      },
      fontFamily: {
        sans: [
          'var(--font-sans)',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica',
          'Arial',
          'sans-serif',
        ],
        mono: [
          'var(--font-mono)',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      fontSize: {
        // Notion's type scale is compact and information-dense.
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      borderRadius: {
        // Notion favors squared corners — keep radii small.
        DEFAULT: '4px',
        sm: '3px',
        md: '5px',
        lg: '8px',
        xl: '12px',
      },
      boxShadow: {
        // Subtle, low-spread shadows. Notion avoids heavy drop shadows.
        card: '0 1px 2px rgba(15, 15, 15, 0.04), 0 1px 1px rgba(15, 15, 15, 0.03)',
        popover: '0 4px 14px rgba(15, 15, 15, 0.08), 0 0 0 1px rgba(15, 15, 15, 0.04)',
        dialog: '0 12px 32px rgba(15, 15, 15, 0.12), 0 0 0 1px rgba(15, 15, 15, 0.06)',
      },
      spacing: {
        // 4px base grid, extended for the larger app-shell gutters.
        18: '4.5rem',
        22: '5.5rem',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
        shimmer: 'shimmer 1.5s infinite',
      },
    },
  },
  plugins: [],
};

export default notionBaseConfig;
