import { defineConfig } from 'vite';

export default defineConfig({
  root: 'public',              // tell Vite to use ./public as the root
  build: {
    outDir: '../dist',         // output outside of /public
    emptyOutDir: true,
  },
});
