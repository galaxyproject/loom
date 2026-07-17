// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Deployed to GitHub Pages under the loom repo: https://galaxyproject.github.io/loom/
export default defineConfig({
  site: 'https://galaxyproject.github.io',
  base: '/loom',
  vite: {
    plugins: [tailwindcss()],
  },
});
