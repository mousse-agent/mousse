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

/** A rule that reports every node matching one of `selectors` (selector -> message). */
const selectorRule = (selectors) => ({
  meta: { type: 'problem', schema: [] },
  create: (context) => Object.fromEntries(Object.entries(selectors).map(([selector, message]) =>
    [selector, (node) => context.report({ node, message })]))
})

// No process Mousse starts may open a console window on Windows. Electron already starts plain spawns of its
// background processes with CREATE_NO_WINDOW (a console with no window, shared by the program's own children); these
// are the few ways to lose that. Options are matched where they are written: in a call or assigned to a variable.
// Disable a line only with the reason (`-- reason`) its target cannot show a window.
const mousse = {
  rules: {
    'no-console-window': selectorRule({
      ':matches(CallExpression, NewExpression, VariableDeclarator) > ObjectExpression > Property[key.name="detached"][value.type="Literal"][value.value=true]':
        'On Windows `detached: true` starts the program with no console at all, so every console program it starts opens a visible one. Guard it by platform, or give the reason this target is safe.',
      ':matches(CallExpression, NewExpression, VariableDeclarator) > ObjectExpression > Property[key.name="windowsHide"][value.type="Literal"][value.value=false]':
        '`windowsHide: false` lets a console window show on Windows. Give the reason it must.'
    }),
    'no-native-process-start': selectorRule({
      'Literal[value=/CreateProcess/], TemplateElement[value.raw=/CreateProcess/]':
        'Start Windows processes through child_process or the launchers that hide their console (windowsGitProcess.ts, windowsProviderProcess.ts, windowsJobProcess.ts).'
    }),
    'no-inherited-stdio': selectorRule({
      'Property[key.name="stdio"] > Literal[value="inherit"], Property[key.name="stdio"] > ArrayExpression > Literal[value="inherit"], Property[key.name="stdio"] > ArrayExpression > Literal[raw=/^\\d+$/], Property[key.name="stdio"] > ArrayExpression > MemberExpression[object.name="process"]':
        'A background process has no console to share: an inherited stdio handle makes Node skip CREATE_NO_WINDOW on Windows, so a console program opens a window. Use pipes or ignore, or give the reason this target is safe.'
    })
  }
}
const nodeCode = ['src/main', 'src/mms', 'src/preload', 'src/shared', 'src/cli', 'src/browser-worker']

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
    files: tsFiles(nodeCode),
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.node.json'], tsconfigRootDir: import.meta.dirname }
    },
    plugins: { '@typescript-eslint': tseslint.plugin, mousse },
    rules: { ...rules, 'mousse/no-console-window': 'error', 'mousse/no-native-process-start': 'error' }
  },
  {
    // The launchers that call CreateProcessW themselves, each with CREATE_NO_WINDOW.
    files: ['src/mms/git/windowsGitProcess.ts', 'src/mms/harness/windowsProviderProcess.ts', 'src/mms/harness/windowsJobProcess.ts'],
    rules: { 'mousse/no-native-process-start': 'off' }
  },
  {
    // Background code: the daemon, its helpers and the CLI that starts the service.
    files: tsFiles(['src/mms', 'src/cli']),
    rules: { 'mousse/no-inherited-stdio': 'error' }
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
