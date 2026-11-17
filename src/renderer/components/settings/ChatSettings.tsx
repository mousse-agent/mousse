import type { CSSProperties } from 'react'
import { FROSTED_COMPOSER_RANGES, type ChatWidth, type FrostedComposerSlider, type MousseSettings, type MousseSettingsUpdate, type TurnChangedFilesMode } from '../../../shared/settings'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsGroup, SettingsRow, Switch } from './SettingsRow'
import { MessageSquare, MessagesSquare } from '../../lib/icons'

const CHAT_WIDTH_OPTIONS: readonly SelectOption<ChatWidth>[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
  { value: 'full', label: 'Full' }
]

const TURN_CHANGED_FILES_OPTIONS: readonly SelectOption<TurnChangedFilesMode>[] = [
  { value: 'summary', label: 'Summary line' },
  { value: 'list', label: 'Full list' },
  { value: 'off', label: 'Off' }
]

const FROSTED_COMPOSER_SLIDERS: readonly { key: FrostedComposerSlider; title: string; id: string; format: (value: number) => string }[] = [
  { key: 'frostedComposerOpacity', title: 'Opacity', id: 'frosted-composer-opacity', format: (value) => `${value}%` },
  { key: 'frostedComposerBlur', title: 'Blur', id: 'frosted-composer-blur', format: (value) => `${value}px` },
  { key: 'frostedComposerSaturation', title: 'Color boost', id: 'frosted-composer-color-boost', format: (value) => `${Math.round((value - 1) * 100)}%` }
]

export interface ChatSettingsProps {
  settings: MousseSettings
  onUpdate: (partial: MousseSettingsUpdate) => Promise<void>
  /** Applies a frosted composer slider locally while it moves. */
  onPreviewFrostedComposer: (key: FrostedComposerSlider, value: number) => void
  /** Saves a frosted composer slider (debounced by the caller). */
  onCommitFrostedComposer: (key: FrostedComposerSlider, value: number) => void
}

/**
 * Settings → Chat: how the conversation reads (width, math, reply pacing, the changed-files line) and the
 * composer (the context ring and the frosted composer). The values are stored under `appearance`.
 */
export function ChatSettings({ settings, onUpdate, onPreviewFrostedComposer, onCommitFrostedComposer }: ChatSettingsProps) {
  const appearance = settings.appearance
  return (
    <section id="chat" className="settings-section">
      <SettingsGroup title="Conversation" icon={MessagesSquare} anchor="chat-conversation">
        <SettingsRow
          title="Chat width"
          anchor="chat-width"
          description="How wide the conversation is."
          control={
            <Select
              ariaLabel="Chat width"
              value={appearance.chatWidth}
              onChange={(chatWidth) => void onUpdate({ appearance: { ...appearance, chatWidth } })}
              options={CHAT_WIDTH_OPTIONS}
            />
          }
        />
        <SettingsRow
          title="Render math"
          anchor="chat-render-math"
          description="Show LaTeX in replies and Markdown previews as formatted equations."
          control={
            <Switch
              label="Render math"
              checked={appearance.renderMath}
              onChange={(renderMath) => void onUpdate({ appearance: { ...appearance, renderMath } })}
            />
          }
        />
        <SettingsRow
          title="Replies by paragraph"
          anchor="chat-reply-pacing"
          description={<span title="Each finished paragraph, list item or code line fades in; off shows text as it arrives.">Instead of word by word.</span>}
          control={
            <Switch
              label="Replies by paragraph"
              checked={appearance.replyPacing}
              onChange={(replyPacing) => void onUpdate({ appearance: { ...appearance, replyPacing } })}
            />
          }
        />
        <SettingsRow
          title="Changed files after each turn"
          anchor="chat-turn-changed-files"
          control={
            <Select
              ariaLabel="Changed files after each turn"
              value={appearance.turnChangedFiles}
              onChange={(turnChangedFiles) => void onUpdate({ appearance: { ...appearance, turnChangedFiles } })}
              options={TURN_CHANGED_FILES_OPTIONS}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="Composer" icon={MessageSquare} anchor="chat-composer">
        <SettingsRow
          title="Context ring"
          anchor="chat-context-ring"
          description="How full the model's context is."
          control={
            <Switch
              label="Context ring"
              checked={appearance.contextRingInComposer}
              onChange={(contextRingInComposer) => void onUpdate({ appearance: { ...appearance, contextRingInComposer } })}
            />
          }
        />
        <SettingsRow
          title="Frosted composer"
          anchor="chat-frosted-composer"
          description={<span title="Uses more graphics memory.">The chat shows blurred behind the composer.</span>}
          control={
            <Switch
              label="Frosted composer"
              checked={appearance.frostedComposer}
              onChange={(frostedComposer) => void onUpdate({ appearance: { ...appearance, frostedComposer } })}
            />
          }
        />
        {appearance.frostedComposer && FROSTED_COMPOSER_SLIDERS.map(({ key, title, id, format }) => {
          const range = FROSTED_COMPOSER_RANGES[key]
          const value = appearance[key]
          const fill = ((value - range.min) / (range.max - range.min)) * 100
          return (
            <SettingsRow
              key={key}
              title={title}
              htmlFor={id}
              indent
              control={
                <>
                  <input
                    id={id}
                    type="range"
                    className="acrylic-intensity-dial"
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={value}
                    style={{ '--fill': `${fill}%` } as CSSProperties}
                    onInput={(e) => {
                      // onInput only, as for glass intensity: one preview and one save per move.
                      const next = Number(e.currentTarget.value)
                      onPreviewFrostedComposer(key, next)
                      onCommitFrostedComposer(key, next)
                    }}
                  />
                  <span className="acrylic-intensity-value frosted-composer-value">{format(value)}</span>
                </>
              }
            />
          )
        })}
      </SettingsGroup>
    </section>
  )
}
