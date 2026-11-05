import { useId, useRef, useState } from 'react'
import { findLocalSttModel, type DictationSelection } from '../../shared/dictation'
import { normalizeVocabulary, parseSoundsLike, MAX_TERM_LENGTH, type DictationVocabularyTerm } from '../../shared/dictationVocabulary'
import { SettingsRow } from '../components/settings/SettingsRow'
import { Modal } from '../components/ui/Modal'
import { Plus, X } from '../lib/icons'

interface DraftRow {
  key: number
  term: string
  soundsLike: string
}

/** Whether dictation with `selection` writes vocabulary terms: only local Parakeet models do. */
export function usesVocabulary(selection: DictationSelection | null): boolean {
  if (selection?.source !== 'local') return false
  return findLocalSttModel(selection.modelId)?.runtime === 'nemo-transducer'
}

export function vocabularyCountLabel(count: number): string {
  return count === 0 ? 'Add terms' : count === 1 ? '1 term' : `${count} terms`
}

/** Rows typed in the editor as the saved list: blank rows dropped, duplicates merged. */
export function vocabularyFromDrafts(rows: readonly Pick<DraftRow, 'term' | 'soundsLike'>[]): DictationVocabularyTerm[] {
  return normalizeVocabulary(rows.map((row) => ({ term: row.term, soundsLike: parseSoundsLike(row.soundsLike) })))
}

/**
 * Settings, Speech, Dictation: the names dictation should spell right, edited in a dialog. Shown
 * only beside a model that uses them (`usesVocabulary`); the saved list is kept for every model.
 */
export function VocabularySetting({
  vocabulary,
  onChange
}: {
  vocabulary: readonly DictationVocabularyTerm[]
  onChange: (vocabulary: DictationVocabularyTerm[]) => void
}) {
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const nextKey = useRef(0)
  const focusKey = useRef<number | null>(null)
  const termHeaderId = useId()
  const soundsHeaderId = useId()

  const row = (term = '', soundsLike = ''): DraftRow => ({ key: nextKey.current++, term, soundsLike })
  const open = (): void => {
    const saved = vocabulary.map((entry) => row(entry.term, entry.soundsLike.join(', ')))
    const drafts = saved.length > 0 ? saved : [row()]
    if (saved.length === 0) focusKey.current = drafts[0].key
    setRows(drafts)
  }
  const close = (): void => {
    if (rows) onChange(vocabularyFromDrafts(rows))
    setRows(null)
  }
  const edit = (key: number, change: Partial<DraftRow>): void =>
    setRows((current) => current?.map((draft) => (draft.key === key ? { ...draft, ...change } : draft)) ?? null)
  const add = (): void => {
    const added = row()
    focusKey.current = added.key
    setRows((current) => [...(current ?? []), added])
  }
  const remove = (key: number): void => setRows((current) => current?.filter((draft) => draft.key !== key) ?? null)

  return (
    <>
      <SettingsRow
        title="Vocabulary"
        description="Names dictation should spell right."
        control={
          <button type="button" className="settings-btn" title="Edit vocabulary" onClick={open}>
            {vocabularyCountLabel(vocabulary.length)}
          </button>
        }
      />
      <Modal
        open={rows !== null}
        title="Vocabulary"
        onClose={close}
        className="speech-vocab-dialog"
        footer={
          <button type="button" className="btn btn-primary" onClick={close}>
            Done
          </button>
        }
      >
        <p className="speech-vocab-intro">Dictation writes a term when what it heard sounds like it.</p>
        <div className="speech-vocab-list" role="table" aria-label="Vocabulary terms">
          <div className="speech-vocab-head" role="row">
            <span id={termHeaderId} role="columnheader">
              Term
            </span>
            <span id={soundsHeaderId} role="columnheader" title="Spellings dictation tends to write instead, separated by commas">
              Sounds like
            </span>
            <span />
          </div>
          {rows?.map((draft) => (
            <div key={draft.key} className="speech-vocab-row" role="row">
              <input
                className="settings-input"
                aria-labelledby={termHeaderId}
                placeholder="OpenCode"
                maxLength={MAX_TERM_LENGTH}
                value={draft.term}
                autoFocus={focusKey.current === draft.key}
                onChange={(event) => edit(draft.key, { term: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add()
                }}
              />
              <input
                className="settings-input"
                aria-labelledby={soundsHeaderId}
                placeholder="open code"
                value={draft.soundsLike}
                onChange={(event) => edit(draft.key, { soundsLike: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') add()
                }}
              />
              <button type="button" className="settings-icon-btn" title="Remove" aria-label={`Remove ${draft.term || 'term'}`} onClick={() => remove(draft.key)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="settings-btn speech-vocab-add" onClick={add}>
          <Plus size={14} aria-hidden="true" />
          Add term
        </button>
      </Modal>
    </>
  )
}
