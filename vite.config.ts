/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// `base: './'` keeps every asset path relative, so the same build works on
// GitHub Pages (served from /<repo>/), Netlify and Cloudflare Pages.
export default defineConfig({
  base: './',
  build: {
    target: ['es2022', 'safari15'],
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
