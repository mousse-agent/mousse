import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// The code base is clean of these, so they fail lint. Mark a deliberately
// unawaited promise with `void`; explain a deliberately empty block in a comment.
const rules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  'no-empty': ['error', { allowEmptyCatch: false }]
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
      'resources/**'
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
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  }
)
