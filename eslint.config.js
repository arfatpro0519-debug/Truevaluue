import js from '@eslint/js';
import globals from 'globals';

// Configuration plate (flat config) : ESLint en dépendance de DEV uniquement.
export default [
  { ignores: ['node_modules/**', 'data/**', '.cache/**', '.config/**', '.local/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        Telegram: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-console': 'off',
      // Règle stylistique ajoutée dans ESLint 10 : le code historique initialise
      // volontairement certaines variables avant les branches qui les écrasent.
      'no-useless-assignment': 'off',
    },
  },
];
