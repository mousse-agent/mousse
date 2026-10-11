import { useEffect, useRef, useState } from 'react'
import { Plus, Upload } from '../../lib/icons'
import type { IntegrationPlatformClient } from '../../../shared/integrationPlatform'
import type { SkillDescriptor } from '../../../shared/integrations'
import type { SkillEditorDto } from '../../../shared/integrations/lifecycle'
import { MarkdownDocumentEditor } from '../editors/MarkdownDocumentEditor'
import { IntegrationField as Field, IntegrationModal as Modal, useIntegrationBoundary, useIntegrationDirtyGuard } from './dialogSupport'
import { asError, downloadPackage, errorCode, fileToPackage, filesToPackage, toBase64 } from './integrationUi'

interface Identity { client: IntegrationPlatformClient; profileId: string; projectId?: string; onClose: () => void; onSaved: () => void }
export type TestSkill = (params: { profileId: string; projectId?: string; installationId: string; revision: string }) => Promise<unknown>
const STARTER = '## Instructions\n\nDescribe when this skill should be used.\n'

export function AddSkillDialog({ client, profileId, projectId, scope, initialMode, onClose, onSaved }: Identity & { scope: 'global' | 'project'; initialMode: 'create' | 'upload' }) {
  const [mode, setMode] = useState(initialMode)
  const [name, setName] = useState(''), [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState(STARTER)
  const [license, setLicense] = useState(''), [compatibility, setCompatibility] = useState('')
  const [enable, setEnable] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null), [folderFiles, setFolderFiles] = useState<File[]>([])
  const inputRef = useRef<HTMLInputElement>(null), folderRef = useRef<HTMLInputElement>(null)
  const boundary = useIntegrationBoundary(client, profileId, projectId)
  const dirty = Boolean(name || description || license || compatibility || instructions !== STARTER || !enable || file || folderFiles.length)
  const mayLeave = useIntegrationDirtyGuard(dirty, 'Discard the unsaved skill draft and selected upload?')
  const close = () => { if (!busy && mayLeave()) onClose() }
  // React's DOM types do not expose this Chromium directory-picker attribute.
  useEffect(() => { folderRef.current?.setAttribute('webkitdirectory', '') }, [mode])

  const save = async () => {
    if (busy) return
    const ticket = boundary.capture()
    setBusy(true); setError(null)
    try {
      if (mode === 'create') {
        if (!name.trim() || !description.trim()) throw new Error('Name and description are required.')
        await client.createSkill({ profileId, projectId, scope, name: name.trim(), description: description.trim(), instructions, license: license || undefined, compatibility: compatibility || undefined, enable })
      } else {
        if (!file && !folderFiles.length) throw new Error('Choose a SKILL.md, ZIP package, or folder.')
        const pkg = folderFiles.length ? await filesToPackage(folderFiles) : await fileToPackage(file!)
        if (!boundary.current(ticket)) return
        await client.importSkill({ profileId, projectId, scope, zipBase64: toBase64(pkg.bytes), zipName: pkg.name, enable })
      }
      if (boundary.current(ticket)) onSaved()
    } catch (cause) { if (boundary.current(ticket)) setError(asError(cause)) }
    finally { if (boundary.current(ticket)) setBusy(false) }
  }

  return <Modal title="Add skill" onClose={close}>
    <div className="integrations-choice">
      <button type="button" disabled={busy} data-action="choose-create-skill" className={mode === 'create' ? 'selected' : ''} onClick={() => { setMode('create'); setError(null) }}><Plus size={16} /><strong>Create skill</strong><span>Write reusable instructions.</span></button>
      <button type="button" disabled={busy} data-action="choose-upload-skill" className={mode === 'upload' ? 'selected' : ''} onClick={() => { setMode('upload'); setError(null) }}><Upload size={16} /><strong>Upload package</strong><span>Choose Markdown, ZIP, or a folder.</span></button>
    </div>
    <form className="integration-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
      <fieldset className="integration-fields" disabled={busy}>
        {mode === 'create' ? <>
          <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="When to use"><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></Field>
          <div className="integration-form-grid"><Field label="License"><input value={license} onChange={(event) => setLicense(event.target.value)} placeholder="Optional" /></Field><Field label="Compatibility"><input value={compatibility} onChange={(event) => setCompatibility(event.target.value)} placeholder="Optional" /></Field></div>
          <details><summary>Starter instructions</summary><div className="integration-starter-editor"><MarkdownDocumentEditor value={instructions} onChange={setInstructions} readOnly={busy} defaultViewMode="source" path="SKILL.md" aria-label="Skill instructions" /></div></details>
        </> : <>
          <input ref={inputRef} data-action="skill-upload-input" type="file" accept=".md,.zip,text/markdown,application/zip" hidden onChange={(event) => { setFolderFiles([]); setFile(event.target.files?.[0] ?? null) }} />
          <input ref={folderRef} data-action="skill-folder-input" type="file" hidden multiple onChange={(event) => { setFile(null); setFolderFiles(Array.from(event.target.files ?? [])) }} />
          <div className="integration-upload-options">
            <button type="button" className="integration-drop" onClick={() => inputRef.current?.click()}><Upload size={16} /><strong>{file?.name ?? 'Choose SKILL.md or ZIP'}</strong><span>Up to 360 KiB compressed.</span></button>
            <button type="button" className="integration-drop" onClick={() => folderRef.current?.click()}><Upload size={16} /><strong>{folderFiles.length ? `${folderFiles.length} folder files` : 'Import a folder'}</strong><span>Include SKILL.md at the folder root.</span></button>
          </div>
          <p className="integration-help">Scripts and assets are preserved. Import does not execute the package.</p>
        </>}
        <label className="integration-check"><input type="checkbox" checked={enable} onChange={(event) => setEnable(event.target.checked)} /> Enable after {mode === 'create' ? 'save' : 'import'}</label>
      </fieldset>
      {error ? <p className="integration-error" role="alert">{error}</p> : null}
      <div className="integration-dialog-actions"><button type="button" className="btn" onClick={close}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : mode === 'create' ? 'Create skill' : 'Import package'}</button></div>
    </form>
  </Modal>
}

export function SkillEditorDialog({ client, profileId, projectId, skill, onClose, onSaved, onTestSkill }: Identity & { skill: SkillDescriptor; onTestSkill?: TestSkill }) {
  const [editor, setEditor] = useState<SkillEditorDto | null>(null)
  const [content, setContent] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null), [feedback, setFeedback] = useState<string | null>(null), [reload, setReload] = useState(0)
  const installationId = skill.installationId ?? skill.id
  const boundary = useIntegrationBoundary(client, profileId, projectId, installationId)
  const dirty = Boolean(editor && content !== editor.source)
  const mayLeave = useIntegrationDirtyGuard(dirty, 'Discard unsaved skill edits?')
  const close = () => { if (!busy && mayLeave()) onClose() }
  const identity = { profileId, projectId, installationId }

  useEffect(() => {
    let current = true
    setLoading(true); setError(null)
    // Load the current source and revision together; a catalog row can be stale.
    void client.skillEditor({ profileId, projectId, installationId }).then((value) => {
      if (current) { setEditor(value); setContent(value.source) }
    }).catch((cause) => { if (current) setError(asError(cause)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [client, profileId, projectId, installationId, reload])

  const action = async (kind: 'save' | 'toggle' | 'archive' | 'zip' | 'markdown' | 'test') => {
    if (!editor || busy || loading) return
    if ((kind === 'toggle' || kind === 'archive') && !mayLeave()) return
    if (kind === 'archive' && !window.confirm('Archive this skill?')) return
    if (dirty && ['zip', 'markdown', 'test'].includes(kind)) return
    const ticket = boundary.capture()
    setBusy(true); setError(null); setFeedback(null)
    try {
      if (kind === 'save') {
        if (!editor.skill.revision) throw new Error('Reload the saved skill before editing it.')
        await client.updateSkill({ ...identity, content, expectedRevision: editor.skill.revision })
      } else if (kind === 'toggle') await client.enableSkill({ ...identity, enabled: editor.skill.enabled === false })
      else if (kind === 'archive') await client.archiveSkill(identity)
      else if (kind === 'test') {
        if (!onTestSkill || !editor.skill.revision) throw new Error('Skill testing is unavailable.')
        await onTestSkill({ ...identity, revision: editor.skill.revision })
        if (boundary.current(ticket)) setFeedback('Test run requested.')
      } else {
        const exported = await client.exportSkill({ ...identity, format: kind })
        if (boundary.current(ticket)) downloadPackage(exported.fileName, exported.base64, exported.contentType)
      }
      if (boundary.current(ticket) && ['save', 'toggle', 'archive'].includes(kind)) onSaved()
    } catch (cause) {
      if (boundary.current(ticket)) setError(errorCode(cause) === 'revision_conflict'
        ? 'This skill changed elsewhere. Your edits are retained. Reload the saved skill before saving again.' : asError(cause))
    } finally { if (boundary.current(ticket)) setBusy(false) }
  }

  return <Modal title={`Edit ${editor?.skill.name ?? skill.name}`} onClose={close} wide>
    <div className="integration-editor" data-skill-editor="">
      <div className="integration-editor__toolbar"><span>{dirty ? 'Unsaved changes' : 'Saved source'}</span><div>
        <button type="button" className="btn btn-sm" disabled={busy || loading} onClick={() => { if (mayLeave()) setReload((value) => value + 1) }}>Reload saved</button>
        <button type="button" className="btn btn-sm" disabled={busy || loading || !editor || dirty} onClick={() => void action('zip')}>Export ZIP</button>
        {onTestSkill ? <button type="button" className="btn btn-sm" disabled={busy || loading || !editor || dirty} onClick={() => void action('test')}>Test skill</button> : null}
        <button type="button" className="btn btn-sm" disabled={busy || loading || !editor} onClick={() => void action('toggle')}>{editor?.skill.enabled === false ? 'Enable' : 'Disable'}</button>
        <button type="button" className="btn btn-sm btn-danger" disabled={busy || loading || !editor} onClick={() => void action('archive')}>Archive</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || loading || !editor || !dirty} onClick={() => void action('save')}>Save changes</button>
      </div></div>
      {error ? <p className="integration-error" role="alert">{error}</p> : null}
      {feedback ? <p role="status">{feedback}</p> : null}
      {loading ? <p className="integrations-state" role="status">Loading skill…</p> : editor ? <>
        <div className="integration-package-tree" aria-label="Package files">{editor.packageTree.map((file) => <span key={file.relativePath}>{file.relativePath}</span>)}</div>
        <div className="integration-editor__body">
          <MarkdownDocumentEditor value={content} onChange={setContent} readOnly={busy} onSave={() => void action('save')} path="SKILL.md" aria-label="Skill instructions" />
          <aside><h3>Diagnostics</h3>{editor.skill.diagnostics?.length ? <ul>{editor.skill.diagnostics.map((item, index) => <li key={index}>{item.message}</li>)}</ul> : <p>No diagnostics.</p>}
            {dirty ? <p className="integration-help">Save changes before exporting or testing.</p> : null}
            <button type="button" className="btn btn-sm" disabled={busy || dirty} onClick={() => void action('markdown')}>Export Markdown</button>
          </aside>
        </div>
      </> : null}
    </div>
  </Modal>
}
