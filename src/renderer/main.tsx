import React, { Suspense, useState } from 'react'
import App from './App'
import { createAppRoot, RootErrorBoundary } from './lib/appRoot'
import { installWindowErrorReporting } from './services/rendererErrors'
import { keepShellUnscrolled } from './lib/shellScroll'
// Settings loads as its own chunk the first time it opens (preloaded once the workspace has painted).
import { SettingsPage } from './lib/lazySurfaces'
import { applyAppearance, useTheme } from './hooks/useTheme'
import { getDefaultSettings } from '../shared/settings'
import { useAppStore } from './stores/appStore'
import { AppTooltip } from './components/AppTooltip'
import { DictationHost } from './dictation/DictationModal'
import { ReadAloudHost } from './readAloud/ReadAloudModal'
import { PhoneSpeechHost } from './speechRelay/PhoneSpeechHost'
import { EnrollmentRequestHost } from './components/EnrollmentRequestPrompt'
import { EditorAskHost } from './components/EditorAskPrompt'
import { AccessAskHost } from './components/netEngine/AccessAskHost'
import { OnboardingHost } from './components/onboarding/Onboarding'
import { startFaceFrameStore, warmFaceRendererAfterPaint } from './components/bots/face/faceRenderer'
import { startFacePictures } from './components/bots/face/startFacePictures'
import './styles/global.css'
import './styles/compact-shell.css'
import './styles/sentence-case.css'
import './styles/polish.css'
import './styles/ambient-glow.css'
import './styles/wallpaper.css'
import './styles/geist-fonts.css'
import './styles/frameless-shell.css'
import './styles/specular.css'

// Uncaught errors and rejected promises outside React go to main's log, from here on.
installWindowErrorReporting()

// The page and the app's frame never scroll, whatever a scrollIntoView or focus deep inside asks.
keepShellUnscrolled()

// Apply the saved profile's appearance before React paints or MMS connects.
const startupAppearance = window.mousse?.startupAppearance
applyAppearance(startupAppearance && typeof startupAppearance === 'object'
  ? startupAppearance
  : getDefaultSettings().appearance)

// Warm the local monospace face before canvas-based terminals measure glyphs.
// The normal app shell renders immediately while the asset loads.
void document.fonts.load('400 13px "Geist Mono"').catch(() => { /* system monospace fallback */ })

// Bot faces: read the pictures saved in earlier runs now (IndexedDB, off the main thread), so a
// known face shows its real picture from its first paint.
startFaceFrameStore()

function ProfilePages() {
  useTheme()
  // Settings mounts once the workspace has painted (or when it is opened first), then stays mounted; closed, it
  // draws nothing. Until its chunk is in, the app stays as it was: no empty page.
  const settingsOpen = useAppStore((state) => state.settingsOpen)
  const workspaceReady = useAppStore((state) => state.workspaceReady)
  const [mounted, setMounted] = useState(false)
  if (!mounted && (settingsOpen || workspaceReady)) setMounted(true)
  if (!mounted) return null
  return (
    <Suspense fallback={null}>
      <SettingsPage />
    </Suspense>
  )
}

function Root() {
  const profileReady = useAppStore((state) => state.profileReady)
  return (
    <>
      <App />
      {profileReady && <ProfilePages />}
      {profileReady && <ReadAloudHost />}
      {profileReady && <DictationHost />}
      {profileReady && <PhoneSpeechHost />}
      {profileReady && <EnrollmentRequestHost />}
      {profileReady && <EditorAskHost />}
      {/* A computer this one uses asks to use this one too: the Allow prompt, wherever the window is (Settings too). */}
      {profileReady && <AccessAskHost />}
      {profileReady && <OnboardingHost />}
      <AppTooltip />
    </>
  )
}

// A component that throws shows one line with Reload in place of the app (never a blank window), and is logged.
createAppRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <Root />
    </RootErrorBoundary>
  </React.StrictMode>
)

// Start compiling the bot face shader once the first frame is painted (seconds on Direct3D 11), so
// faces are live by the time one shows.
warmFaceRendererAfterPaint()
// Each bot's face picture (face.png in its files folder) is drawn here, in idle time once the faces draw live.
startFacePictures()
