import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['**/dist/', '**/node_modules/', '**/.vscode-test/']),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // Scripts that run inside a webview, where these names are provided by the page.
    files: ['packages/vscode/media/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: {
        acquireVsCodeApi: 'readonly',
        document: 'readonly',
        window: 'readonly',
      },
    },
  },
);
