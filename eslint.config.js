// @ts-check
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Flat config, deliberately small.
 *
 * `tsc --noEmit` already runs in CI-equivalent form (`npm run typecheck`) and
 * catches the class of bug that matters most here, so this exists for the rules
 * a type checker cannot express — chiefly `no-explicit-any`, which CloudGov's
 * best-practices appendix says to reject outright, and the React hook
 * dependency rules the pages rely on.
 *
 * Not type-aware linting: it would triple the run time across three packages
 * for rules `tsc` mostly already enforces under `strict` +
 * `noUncheckedIndexedAccess`.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'out/**', '**/*.d.ts'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      // BP-001 / Appendix A: `any` is rejected, not warned about.
      '@typescript-eslint/no-explicit-any': 'error',
      // An unused parameter prefixed with _ is intentional (Fastify handlers).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Empty catch blocks are used on purpose where a parse failure IS the
      // finding; they carry a comment saying so.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    files: ['packages/web/**/*.tsx', 'packages/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Dev scripts are plain Node ESM, run directly with `node` — same shape as
    // the test files below, so the same globals apply.
    //
    // `URL` is here because the parity scripts resolve their fixtures relative
    // to their own module rather than to the working directory: `npm run parity`
    // and a bare `node scripts/...` must find the same file.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Test files are plain Node ESM, run directly with `node`.
    files: ['packages/client/test/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', TextEncoder: 'readonly' },
    },
  },
);
