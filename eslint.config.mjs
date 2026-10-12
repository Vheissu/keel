import parser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';

export default [
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'output/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser },
    plugins: { '@stylistic': stylistic },
    rules: {
      curly: ['error', 'all'],
      'no-nested-ternary': 'error',
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: '*', next: 'method' },
            { blankLine: 'always', prev: 'method', next: '*' },
          ],
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: ['import', 'export', 'type', 'interface'], next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        { blankLine: 'always', prev: ['const', 'let'], next: '*' },
        { blankLine: 'any', prev: ['const', 'let'], next: ['const', 'let'] },
        { blankLine: 'always', prev: '*', next: ['block-like', 'return'] },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: ['multiline-expression', 'multiline-const'] },
        { blankLine: 'always', prev: ['multiline-expression', 'multiline-const'], next: '*' },
      ],
    },
  },
];
