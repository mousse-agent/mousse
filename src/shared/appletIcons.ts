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
  'external-link': LinkSquare02Icon
} as const

export const APPLET_ICON_ALIASES: Record<string, keyof typeof APPLET_ICON_GEOMETRY> = {
  Plus: 'plus',
  X: 'x',
  Check: 'check',
  Info: 'info',
  AlertTriangle: 'alert-triangle',
  Search: 'search',
  Settings: 'settings',
  RefreshCw: 'refresh-cw',
  Download: 'download',
  Copy: 'copy',
  Edit: 'edit',
  Save: 'save',
  Trash2: 'trash-2',
  Play: 'play',
  Pause: 'pause',
  Clock: 'clock',
  Gauge: 'gauge',
  Users: 'users',
  User: 'user',
  Folder: 'folder',
  FileText: 'file-text',
  ArrowUpRight: 'arrow-up-right',
  ArrowDown: 'arrow-down',
  ChevronDown: 'chevron-down',
  ExternalLink: 'external-link'
}
export const APPLET_ICON_NAMES = Object.freeze(Object.keys(APPLET_ICON_GEOMETRY))
