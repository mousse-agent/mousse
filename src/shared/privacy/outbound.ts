/**
 * Every internet address Mousse's own code names (Settings → General → Privacy). Each host found in
 * a string in `src/**` is listed here once, as one of:
 * - `contacted`: Mousse itself connects to it, in the situations `when` names, sending what `sends` says;
 * - `link`: Mousse never connects to it itself: it opens in your browser when you click it, is shown
 *   as text, or is only a name (an XML namespace, a key in a file);
 * - `local`: this computer only (loopback sign-in callbacks, Mousse's own servers).
 *
 * `tests/privacy/noProductTelemetry.test.ts` fails on a host in the code that is not listed, and on a
 * contacted entry whose source files no longer name any of its hosts.
 */

export type OutboundKind = 'contacted' | 'link' | 'local'

export interface OutboundEntry {
  /** What it is, as the Privacy list shows it. */
  label: string
  kind: OutboundKind
  hosts: readonly string[]
  /** `contacted`: when Mousse connects. */
  when?: string
  /** `contacted`: what the request carries. */
  sends?: string
  /** `contacted`: the files (from the repository root) that make the request. */
  sources?: readonly string[]
}

export const OUTBOUND: readonly OutboundEntry[] = [
  {
    label: 'Mousse updates (GitHub)',
    kind: 'contacted',
    hosts: ['github.com'],
    when: 'In installed builds, when Mousse checks for an update and downloads one.',
    sends: 'A request for the newest release of your update channel.',
    sources: ['src/main/updates/index.ts']
  },
  {
    label: 'Codex download (GitHub)',
    kind: 'contacted',
    hosts: ['github.com'],
    when: 'When you add Codex set up by Mousse, or Mousse updates that copy.',
    sends: 'A download request for the pinned Codex release.',
    sources: ['src/mms/harness/codex/release.ts']
  },
  {
    label: 'Mousse on another computer over SSH (GitHub)',
    kind: 'contacted',
    hosts: ['github.com'],
    when: 'When you set up Mousse on another computer over SSH: that computer downloads the release.',
    sends: 'A download request for that Mousse release.',
    sources: ['src/mms/net/ssh/scripts.ts']
  },
  {
    label: 'ACP agent registry',
    kind: 'contacted',
    hosts: ['cdn.agentclientprotocol.com'],
    when: 'When you browse or install agents in Add provider → More ACP agents.',
    sends: 'A request for the registry list.',
    sources: ['src/mms/harness/agents/registry.ts']
  },
  {
    label: 'npm registry',
    kind: 'contacted',
    hosts: ['registry.npmjs.org'],
    when: 'At most once a day, to learn the newest version of the agents you added; and when you install an agent published on npm.',
    sends: 'The names of the agent packages.',
    sources: ['src/mms/harness/latest.ts', 'src/mms/harness/agents/install.ts']
  },
  {
    label: 'Model lists of model APIs (npm registry, jsDelivr)',
    kind: 'contacted',
    hosts: ['registry.npmjs.org', 'cdn.jsdelivr.net'],
    when: 'When Mousse refreshes the models of the model APIs you added.',
    sends: 'The names of those providers.',
    sources: ['src/mms/providers/piCatalogOverlay.ts']
  },
  {
    label: 'Agent browser (Chrome for Testing)',
    kind: 'contacted',
    hosts: ['googlechromelabs.github.io', 'storage.googleapis.com'],
    when: 'When you install the browser agents use.',
    sends: 'A request for the version list and the download.',
    sources: ['src/mms/browser/install/platform.ts', 'src/browser-worker/binary/platform.ts']
  },
  {
    label: 'Antigravity download (Google)',
    kind: 'contacted',
    hosts: ['dl.google.com'],
    when: 'When you install Antigravity.',
    sends: 'A download request for its agent server.',
    sources: ['src/mms/providers/antigravity/installation.ts']
  },
  {
    label: 'Voice models (Hugging Face)',
    kind: 'contacted',
    hosts: ['huggingface.co'],
    when: 'When you download a read-aloud or dictation model.',
    sends: 'A download request for the model files.',
    sources: ['src/shared/localModels.ts']
  },
  {
    label: 'Web search and fetch tools (Exa, Parallel)',
    kind: 'contacted',
    hosts: ['mcp.exa.ai', 'search.parallel.ai'],
    when: 'When an agent uses Mousse\'s web search or fetch tool.',
    sends: 'The search words or the address to fetch, and your key for that service when you saved one.',
    sources: ['src/mms/orchestrator/WebTools.ts']
  },
  {
    label: 'Interface font (Google Fonts)',
    kind: 'contacted',
    hosts: ['fonts.googleapis.com', 'fonts.gstatic.com'],
    when: 'When a Mousse window opens.',
    sends: 'A request for the font, as any web page makes.',
    sources: ['src/renderer/index.html']
  },
  {
    label: 'Searches from the browser panel (Google)',
    kind: 'contacted',
    hosts: ['www.google.com'],
    when: 'When you type words that are not an address into the browser panel.',
    sends: 'Your search words.',
    sources: ['src/main/browser/BrowserViewManager.ts', 'src/renderer/components/BrowserPanel.tsx']
  },
  {
    label: 'Providers you set up',
    kind: 'contacted',
    hosts: ['api.anthropic.com', 'api.openai.com', 'auth.openai.com', 'opencode.ai', 'grok.com', 'cli-chat-proxy.grok.com'],
    when: 'Only for a provider you added: Claude API key, ChatGPT sign-in in Mousse, OpenCode, Grok.',
    sends: 'Your chats, the provider sign-in, and requests for its models and usage.',
    sources: [
      'src/mms/harness/claude/apiKey.ts',
      'src/mms/harness/chatgpt/discovery.ts',
      'src/mms/providers/ProviderAuthService.ts',
      'src/mms/providers/xaiBilling.ts'
    ]
  },
  {
    label: 'Telegram',
    kind: 'contacted',
    hosts: ['api.telegram.org'],
    when: 'When you connect a Telegram channel.',
    sends: 'The channel\'s messages and the replies.',
    sources: ['src/mms/channels/adapters/TelegramAdapter.ts']
  },
  {
    label: 'Links and names Mousse never connects to',
    kind: 'link',
    hosts: [
      'accounts.google.com', 'agentclientprotocol.com', 'auth.x.ai', 'chatgpt.com', 'code.claude.com',
      'example.com', 'example.invalid', 'www.apple.com', 'www.w3.org'
    ]
  },
  {
    label: 'This computer',
    kind: 'local',
    hosts: ['127.0.0.1', 'localhost']
  }
]

/** What the Privacy section lists: the services Mousse connects to. */
export function contactedServices(): OutboundEntry[] {
  return OUTBOUND.filter((entry) => entry.kind === 'contacted')
}
