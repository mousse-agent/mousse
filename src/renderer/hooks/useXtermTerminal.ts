import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { XTERM_FONT, getXtermTheme } from '../lib/xtermTheme'
import {
  dimensionsChanged,
  fitVisibleTerminal,
  hasUsableTerminalLayout,
  type XtermDimensions
} from '../utils/xtermTerminal'

interface UseXtermTerminalOptions {
  ptyId: string | null
  active?: boolean
}

export function useXtermTerminal(
  containerRef: React.RefObject<HTMLDivElement | null>,
  { ptyId, active = true }: UseXtermTerminalOptions
) {
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const mountedPtyRef = useRef<string | null>(null)
  const fitFrameRef = useRef<number | null>(null)
  const focusAfterFitRef = useRef(false)
  const lastPtyDimensionsRef = useRef<XtermDimensions | undefined>(undefined)
  const activeRef = useRef(active)
  activeRef.current = active

  const fitAndResize = useCallback((focus = true) => {
    if (!ptyId || !activeRef.current || !fitAddonRef.current) return
    // A ResizeObserver notification can arrive between activation and its fit.
    // Do not let that non-focusing request cancel the activation focus request.
    focusAfterFitRef.current ||= focus
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current)
    }

    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null
      const shouldFocus = focusAfterFitRef.current
      focusAfterFitRef.current = false
      const terminal = terminalRef.current
      const fitAddon = fitAddonRef.current
      const container = containerRef.current
      if (
        !activeRef.current
        || mountedPtyRef.current !== ptyId
        || !terminal
        || !fitAddon
        || !container
      ) return

      const dimensions = fitVisibleTerminal(container, terminal, fitAddon)
      if (!dimensions) {
        // Character metrics can lag the first frame after a hidden pane is
        // revealed. Focusing is still safe once the host itself has layout.
        if (shouldFocus && hasUsableTerminalLayout(container)) terminal.focus()
        return
      }

      if (dimensionsChanged(lastPtyDimensionsRef.current, dimensions)) {
        lastPtyDimensionsRef.current = dimensions
        void window.mousse.pty.resize(ptyId, dimensions.cols, dimensions.rows)
      }
      if (shouldFocus) terminal.focus()
    })
  }, [ptyId, containerRef])

  useEffect(() => {
    if (!ptyId || !containerRef.current || mountedPtyRef.current === ptyId) return

    if (terminalRef.current) {
      terminalRef.current.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      containerRef.current.innerHTML = ''
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: XTERM_FONT,
      theme: getXtermTheme()
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)

    terminal.onData((data) => {
      void window.mousse.pty.write(ptyId, data)
    })

    const container = containerRef.current
    const onContextMenu = (event: MouseEvent) => {
      if (!terminal.hasSelection()) {
        event.preventDefault()
        return
      }
      event.preventDefault()
      const selection = terminal.getSelection()
      if (selection) {
        void window.mousse.clipboard.showCopyMenu(event.clientX, event.clientY, selection)
      }
    }
    container.addEventListener('contextmenu', onContextMenu)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    mountedPtyRef.current = ptyId
    lastPtyDimensionsRef.current = undefined

    return () => {
      container.removeEventListener('contextmenu', onContextMenu)
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      focusAfterFitRef.current = false
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      mountedPtyRef.current = null
      lastPtyDimensionsRef.current = undefined
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [ptyId, containerRef])

  useEffect(() => {
    const unsub = window.mousse.pty.onData(({ ptyId: id, data }) => {
      // Terminal.write has its own ordered async buffer. In particular, do not
      // call scrollToBottom here: xterm preserves a user-scrolled viewport and
      // resumes following output naturally when the viewport is at the bottom.
      if (id === ptyId) terminalRef.current?.write(data)
    })
    return unsub
  }, [ptyId])

  useEffect(() => {
    if (!active || !ptyId || !containerRef.current) return

    const handleResize = () => fitAndResize(false)
    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(handleResize)
    observer?.observe(containerRef.current)
    window.addEventListener('resize', handleResize)
    fitAndResize(true)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', handleResize)
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      focusAfterFitRef.current = false
    }
  }, [active, ptyId, containerRef, fitAndResize])

  return { fitAndResize }
}
