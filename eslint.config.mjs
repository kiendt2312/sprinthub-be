import tseslint from 'typescript-eslint';

export default [
  { ignores: ['dist/**', 'coverage/**', 'spikes/**'] },
  ...tseslint.configs.recommended,
];
