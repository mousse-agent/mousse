/** Pinned BrowserGym gymnasium observation/action protocol.
 * Sources: browsergym-core 0.14.3 release commit 0a785fbed075224ae81ca9c1fe924f66050696fe
 * and later inspected GitHub snapshot 9e779f087de9a65668b6974d11f9ce9816026e96
 * (https://github.com/ServiceNow/BrowserGym, https://browsergym.readthedocs.io/en/latest/).
 */

export const BROWSERGYM_PYPI_VERSION = '0.14.3'

export const BROWSERGYM_OBSERVATION_KEYS = [
  'chat_messages',
  'goal',
  'goal_object',
  'open_pages_urls',
  'open_pages_titles',
  'active_page_index',
  'url',
  'screenshot',
  'dom_object',
  'axtree_object',
  'extra_element_properties',
  'focused_element_bid',
  'last_action',
  'last_action_error',
  'elapsed_time'
] as const

export type BrowserGymObservationKey = typeof BROWSERGYM_OBSERVATION_KEYS[number]

export interface BrowserGymChatMessage {
  role: string
  timestamp?: number
  message: string
}

export interface BrowserGymObservation {
  chat_messages: BrowserGymChatMessage[]
  goal: string
  goal_object: Array<{ type: string; text?: string }>
  open_pages_urls: string[]
  open_pages_titles: string[]
  active_page_index: number[]
  url: string
  screenshot: { omitted: true; reason: string } | { pixelWidth: number; pixelHeight: number; artifactId: string }
  dom_object: Record<string, unknown>
  axtree_object: Record<string, unknown>
  extra_element_properties: Record<string, { visibility: number | null; bbox: number[] | null; clickable: boolean; set_of_marks: boolean | null }>
  focused_element_bid: string
  last_action: string
  last_action_error: string
  elapsed_time: number[]
}

export const BROWSERGYM_HIGH_LEVEL_ACTIONS = [
  'click', 'dblclick', 'hover', 'fill', 'select_option', 'check', 'uncheck',
  'press', 'focus', 'clear', 'drag_and_drop', 'scroll', 'scroll_at',
  'mouse_move', 'mouse_up', 'mouse_down', 'mouse_click', 'mouse_dblclick',
  'mouse_drag_and_drop', 'keyboard_press', 'keyboard_up', 'keyboard_down',
  'keyboard_type', 'keyboard_insert_text', 'goto', 'go_back', 'go_forward',
  'new_tab', 'tab_close', 'tab_focus', 'upload_file', 'mouse_upload_file',
  'send_msg_to_user', 'report_infeasible', 'noop'
] as const

export type BrowserGymActionName = typeof BROWSERGYM_HIGH_LEVEL_ACTIONS[number]

export interface ParsedBrowserGymCall {
  name: string
  args: unknown[]
  kwargs: Record<string, unknown>
  source: string
}

export const BROWSERGYM_EXTERNAL_RUN_COMMAND = [
  'python -m pip install browsergym-core==0.14.3 gymnasium',
  'python -m pip install browsergym-miniwob==0.14.3',
  'playwright install chromium',
  'python -c "import gymnasium as gym, browsergym.miniwob; env=gym.make(\'browsergym/miniwob.click-test\'); obs,info=env.reset(seed=0); print(sorted(obs)); env.close()"'
]

export const BROWSERGYM_MISSING_ENVIRONMENT = [
  'Python interpreter with browsergym-core==0.14.3 is not installed in this worktree',
  'Official MiniWoB/WebArena/WorkArena task servers and datasets are not provisioned',
  'BrowserGym\'s Playwright page cannot be the Mousse action executor; Mousse actions use BrowserToolDispatcher/CDP',
  'A shared CDP target between Playwright observation and Mousse actions is not composed in this package'
]
