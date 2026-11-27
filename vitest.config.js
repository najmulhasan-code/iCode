import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // React files of the chat page are compiled the same way as in its build.
  plugins: [react()],
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/vscode/webview/src/**/*.test.{ts,tsx}'],
  },
});
