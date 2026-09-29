import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Lint baseline: every rule is a warning so the existing code base passes while
// new hazards (floating promises, hook misuse, swallowed errors) stay visible.
const rules = {
  '@typescript-eslint/no-floating-promises': 'warn',
  '@typescript-eslint/no-misused-promises': 'warn',
  'no-empty': ['warn', { allowEmptyCatch: false }]
}

const tsFiles = (patterns) => patterns.map((pattern) => `${pattern}/**/*.{ts,tsx}`)

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      '.mousse-dev/**',
      'dist/**',
      'docs/**',
      'resources/**',
      'macros/**'
    ]
  },
  {
    files: tsFiles([
      'src/main',
      'src/mms',
      'src/preload',
      'src/shared',
      'src/cli',
      'src/browser-worker'
    ]),
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.node.json'], tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules
  },
  {
    files: tsFiles(['src/renderer']),
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.web.json'], tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      ...rules,
      'react-hooks/rules-of-hooks': 'warn',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
)
