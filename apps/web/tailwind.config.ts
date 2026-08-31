import type { Config } from 'tailwindcss';
import notionBase from '@mocap-ts/tailwind-config';

/**
 * App-specific Tailwind config. Extends the shared Notion token base and
 * registers only the content paths local to this app, so Tailwind can purge
 * accurately.
 */
const config: Config = {
  ...notionBase,
  content: [
    './src/**/*.{ts,tsx}',
    './src/**/*.{js,jsx}',
  ],
};

export default config;
