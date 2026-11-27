// Builds the chat panel's page: React, Streamdown and the styles, into local
// files under dist/webview. The page loads nothing from the network; lazy
// parts, such as the grammars of programming languages, are local chunks.
import { URL, fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: here('./webview'),
  base: './',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: here('./dist/webview'),
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: false,
    rolldownOptions: {
      input: here('./webview/src/main.tsx'),
      output: {
        entryFileNames: 'main.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
