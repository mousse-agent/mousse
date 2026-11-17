/** Curated offline Hugeicons Stroke Rounded geometry, matching renderer/lib/icons.tsx. */
import Add01Icon from '@hugeicons/core-free-icons/Add01Icon'
import Cancel01Icon from '@hugeicons/core-free-icons/Cancel01Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import InformationCircleIcon from '@hugeicons/core-free-icons/InformationCircleIcon'
import Alert02Icon from '@hugeicons/core-free-icons/Alert02Icon'
import Search01Icon from '@hugeicons/core-free-icons/Search01Icon'
import Settings01Icon from '@hugeicons/core-free-icons/Settings01Icon'
import RefreshIcon from '@hugeicons/core-free-icons/RefreshIcon'
import Download04Icon from '@hugeicons/core-free-icons/Download04Icon'
import Copy01Icon from '@hugeicons/core-free-icons/Copy01Icon'
import Edit02Icon from '@hugeicons/core-free-icons/Edit02Icon'
import SaveIcon from '@hugeicons/core-free-icons/SaveIcon'
import Delete02Icon from '@hugeicons/core-free-icons/Delete02Icon'
import PlayIcon from '@hugeicons/core-free-icons/PlayIcon'
import PauseIcon from '@hugeicons/core-free-icons/PauseIcon'
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import DashboardSpeed01Icon from '@hugeicons/core-free-icons/DashboardSpeed01Icon'
import UserGroupIcon from '@hugeicons/core-free-icons/UserGroupIcon'
import UserIcon from '@hugeicons/core-free-icons/UserIcon'
import Folder01Icon from '@hugeicons/core-free-icons/Folder01Icon'
import File02Icon from '@hugeicons/core-free-icons/File02Icon'
import ArrowUpRight01Icon from '@hugeicons/core-free-icons/ArrowUpRight01Icon'
import ArrowDown02Icon from '@hugeicons/core-free-icons/ArrowDown02Icon'
import ArrowDown01Icon from '@hugeicons/core-free-icons/ArrowDown01Icon'
import LinkSquare02Icon from '@hugeicons/core-free-icons/LinkSquare02Icon'
import Mic01Icon from '@hugeicons/core-free-icons/Mic01Icon'
import SentIcon from '@hugeicons/core-free-icons/SentIcon'
import StopIcon from '@hugeicons/core-free-icons/StopIcon'
import SquareIcon from '@hugeicons/core-free-icons/SquareIcon'
import Remove01Icon from '@hugeicons/core-free-icons/Remove01Icon'
import MoreHorizontalIcon from '@hugeicons/core-free-icons/MoreHorizontalIcon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import ArrowUp01Icon from '@hugeicons/core-free-icons/ArrowUp01Icon'
import ArrowLeft02Icon from '@hugeicons/core-free-icons/ArrowLeft02Icon'
import ArrowRight02Icon from '@hugeicons/core-free-icons/ArrowRight02Icon'
import ArrowUp02Icon from '@hugeicons/core-free-icons/ArrowUp02Icon'
import Home01Icon from '@hugeicons/core-free-icons/Home01Icon'
import Image01Icon from '@hugeicons/core-free-icons/Image01Icon'
import Upload04Icon from '@hugeicons/core-free-icons/Upload04Icon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import Attachment01Icon from '@hugeicons/core-free-icons/Attachment01Icon'
import ViewIcon from '@hugeicons/core-free-icons/ViewIcon'
import SquareLock01Icon from '@hugeicons/core-free-icons/SquareLock01Icon'
import Notification02Icon from '@hugeicons/core-free-icons/Notification02Icon'
import BubbleChatIcon from '@hugeicons/core-free-icons/BubbleChatIcon'
import StarIcon from '@hugeicons/core-free-icons/StarIcon'
import Moon02Icon from '@hugeicons/core-free-icons/Moon02Icon'
import VolumeHighIcon from '@hugeicons/core-free-icons/VolumeHighIcon'
import Undo02Icon from '@hugeicons/core-free-icons/Undo02Icon'
import Redo02Icon from '@hugeicons/core-free-icons/Redo02Icon'

export const APPLET_ICON_GEOMETRY = {
  plus: Add01Icon,
  x: Cancel01Icon,
  check: Tick02Icon,
  info: InformationCircleIcon,
  'alert-triangle': Alert02Icon,
  search: Search01Icon,
  settings: Settings01Icon,
  'refresh-cw': RefreshIcon,
  download: Download04Icon,
  copy: Copy01Icon,
  edit: Edit02Icon,
  save: SaveIcon,
  'trash-2': Delete02Icon,
  play: PlayIcon,
  pause: PauseIcon,
  clock: Clock01Icon,
  gauge: DashboardSpeed01Icon,
  users: UserGroupIcon,
  user: UserIcon,
  folder: Folder01Icon,
  'file-text': File02Icon,
  'arrow-up-right': ArrowUpRight01Icon,
  'arrow-down': ArrowDown02Icon,
  'chevron-down': ArrowDown01Icon,
  'external-link': LinkSquare02Icon,
  microphone: Mic01Icon,
  send: SentIcon,
  stop: StopIcon,
  square: SquareIcon,
  minus: Remove01Icon,
  'more-horizontal': MoreHorizontalIcon,
  'chevron-left': ArrowLeft01Icon,
  'chevron-right': ArrowRight01Icon,
  'chevron-up': ArrowUp01Icon,
  'arrow-left': ArrowLeft02Icon,
  'arrow-right': ArrowRight02Icon,
  'arrow-up': ArrowUp02Icon,
  home: Home01Icon,
  image: Image01Icon,
  upload: Upload04Icon,
  link: Link01Icon,
  paperclip: Attachment01Icon,
  eye: ViewIcon,
  lock: SquareLock01Icon,
  bell: Notification02Icon,
  message: BubbleChatIcon,
  star: StarIcon,
  moon: Moon02Icon,
  volume: VolumeHighIcon,
  undo: Undo02Icon,
  redo: Redo02Icon
} as const

type AppletIconName = keyof typeof APPLET_ICON_GEOMETRY

/** Other common names for the same glyphs, so a guessed name still draws the intended icon. */
const ICON_SYNONYMS: Record<string, AppletIconName> = {
  mic: 'microphone', close: 'x', cancel: 'x', done: 'check', tick: 'check', add: 'plus', trash: 'trash-2', delete: 'trash-2',
  'alert-circle': 'alert-triangle', warning: 'alert-triangle', refresh: 'refresh-cw', pencil: 'edit', 'send-horizontal': 'send',
  'stop-circle': 'stop', more: 'more-horizontal', ellipsis: 'more-horizontal', house: 'home', picture: 'image', 'link-2': 'link',
  attach: 'paperclip', view: 'eye', notification: 'bell', chat: 'message', 'message-square': 'message', 'volume-2': 'volume',
  speaker: 'volume', file: 'file-text', 'undo-2': 'undo', 'redo-2': 'redo', timer: 'clock'
}
const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_match, _dash: string, letter: string) => letter.toUpperCase())

/** Each name in PascalCase too (`ChevronDown`), and the synonyms above in both cases. */
export const APPLET_ICON_ALIASES: Record<string, AppletIconName> = Object.fromEntries([
  ...(Object.keys(APPLET_ICON_GEOMETRY) as AppletIconName[]).map((name) => [pascal(name), name]),
  ...Object.entries(ICON_SYNONYMS).flatMap(([alias, name]) => [[alias, name], [pascal(alias), name]])
])
export const APPLET_ICON_NAMES = Object.freeze(Object.keys(APPLET_ICON_GEOMETRY))
