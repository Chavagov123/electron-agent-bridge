// @ts-check
import js from '@eslint/js';
import importX from 'eslint-plugin-import-x';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.tsbuild/**',
      '**/coverage/**',
      'spikes/**',
      '**/src/generated/**',
      // Generated or third-party trees: API docs, older runtimes (compat), extra Electrons, OSS apps.
      'docs/api/**',
      '.compat/**',
      '.electron/**',
      '.oss/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['*.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { 'import-x': importX },
    rules: {
      // Coding guidelines (docs/coding-guidelines.md).
      'max-lines': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      'max-params': ['error', 4],
      'max-depth': ['error', 4],
      complexity: ['error', 15],
      'no-console': 'error',
      'import-x/no-default-export': 'error',
      'import-x/no-cycle': 'error',
      'import-x/no-self-import': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // The engine runs in Electron's main process: no DOM at runtime. DOM types exist in its tsconfig
    // only for tests that simulate pages, so DOM globals are banned in its source.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['**/*.test.ts', 'packages/engine/src/testing/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator', 'Element', 'HTMLElement', 'Node', 'MutationObserver'].map(
          (name) => ({
            name,
            message: 'The engine runs outside the page; reach the DOM through the page agent.',
          }),
        ),
      ],
    },
  },
  {
    // Test files: allow longer files and looser assertions on unknown shapes.
    files: ['**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      'max-lines': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // Plain JS tooling and fixture apps run as-is under Node/Electron.
    files: ['**/*.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      'import-x/no-default-export': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // Config files must default-export.
    files: ['*.config.ts', '*.config.js', 'eslint.config.js'],
    rules: { 'import-x/no-default-export': 'off' },
  },
);
