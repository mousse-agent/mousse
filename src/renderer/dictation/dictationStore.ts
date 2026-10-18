import { create } from 'zustand'
import type { DictationSelection, LocalSttModelId, LocalSttModelStatus } from '../../shared/dictation'
import { useAppStore } from '../stores/appStore'
import { disposeLocalEngine } from './localEngine'
import { loadDictationSelection, saveDictationSelection } from './selection'

interface DictationState {
  selection: DictationSelection | null
  selectionProfileId: string | null
  pickerOpen: boolean
  /** Runs once the user confirms a model in the picker (starts the recording that was asked for). */
  onConfirmed: (() => void) | null
  syncProfile: (profileId: string) => void
  /** Opens the model dialog; `onConfirmed` runs after a model is chosen, not when it is cancelled. */
  openPicker: (onConfirmed?: () => void) => void
  closePicker: () => void
  confirmPicker: (selection: DictationSelection) => void
  setSelection: (selection: DictationSelection | null) => void
  deleteLocalModel: (modelId: LocalSttModelId) => Promise<LocalSttModelStatus>
}

export const useDictationStore = create<DictationState>((set, get) => ({
  selection: null,
  selectionProfileId: null,
  pickerOpen: false,
  onConfirmed: null,

  syncProfile: (profileId) => {
    if (get().selectionProfileId === profileId) return
    set({ selectionProfileId: profileId, selection: loadDictationSelection(profileId), pickerOpen: false, onConfirmed: null })
  },

  openPicker: (onConfirmed) => {
    get().syncProfile(useAppStore.getState().profileId)
    set({ pickerOpen: true, onConfirmed: onConfirmed ?? null })
  },

  closePicker: () => set({ pickerOpen: false, onConfirmed: null }),

  confirmPicker: (selection) => {
    const { onConfirmed } = get()
    get().setSelection(selection)
    set({ pickerOpen: false, onConfirmed: null })
    onConfirmed?.()
  },

  setSelection: (selection) => {
    const profileId = useAppStore.getState().profileId
    saveDictationSelection(profileId, selection)
    set({ selection, selectionProfileId: profileId })
  },

  deleteLocalModel: async (modelId) => {
    const { selection } = get()
    const usesModel = selection?.source === 'local' && selection.modelId === modelId
    // A transcription may be reading from the files that are about to disappear.
    disposeLocalEngine()
    const status = await window.mousse.dictation.deleteLocalModel(modelId)
    if (usesModel) get().setSelection(null)
    return status
  }
}))
