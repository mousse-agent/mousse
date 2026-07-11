import { useEffect, useRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { XTERM_FONT, getXtermTheme } from '../lib/xtermTheme'

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

  const fitAndResize = useCallback((focus = true) => {
    if (!ptyId || !fitAddonRef.current) return
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current)
    }

    fitFrameRef.current = requestAnimationFrame(() => {
      fitFrameRef.current = null
      if (!fitAddonRef.current) return

      fitAddonRef.current.fit()
      const dims = fitAddonRef.current.proposeDimensions()
      if (dims) {
        void window.mousse.pty.resize(ptyId, dims.cols, dims.rows)
      }
      if (focus) {
        terminalRef.current?.focus()
      }
    })
  }, [ptyId])

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
    fitAddon.fit()

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
    container?.addEventListener('contextmenu', onContextMenu)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    mountedPtyRef.current = ptyId

    return () => {
      container?.removeEventListener('contextmenu', onContextMenu)
      if (fitFrameRef.current !== null) {
        cancelAnimationFrame(fitFrameRef.current)
        fitFrameRef.current = null
      }
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
      mountedPtyRef.current = null
      if (containerRef.current) containerRef.current.innerHTML = ''
    }
  }, [ptyId, containerRef])

  useEffect(() => {
    const unsub = window.mousse.pty.onData(({ ptyId: id, data }) => {
      if (id === ptyId) terminalRef.current?.write(data)
    })
    return unsub
  }, [ptyId])

  useEffect(() => {
    if (!active || !ptyId) return
    requestAnimationFrame(() => fitAndResize())
  }, [active, ptyId, fitAndResize])

  useEffect(() => {
    if (!active || !ptyId) return
    const handleResize = () => fitAndResize(false)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [active, ptyId, fitAndResize])

  return { fitAndResize }
}
