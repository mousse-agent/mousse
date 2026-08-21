import { execFile } from 'child_process'
import { promisify } from 'util'
import { writeFileSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { MacroConfig, MacroStep } from '../../shared/types'
import type { MacroExecutor, MacroRunContext } from './types'

const execFileAsync = promisify(execFile)

/** Escape a value for safe interpolation inside a single-quoted PowerShell string. */
export function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

function finiteIntLiteral(value: unknown, field: string): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(`Macro step field ${field} must be a finite number, got: ${String(value)}`)
  }
  return n
}

/** Build the full PowerShell script for a macro run. Exported for security regression tests. */
export function buildMacroPowerShellScript(config: MacroConfig, context: MacroRunContext): string {
  const promptEscaped = escapePowerShellSingleQuoted(context.prompt)
  const titlePatternEscaped = escapePowerShellSingleQuoted(
    context.windowTitle || config.windowTitlePattern || ''
  )

  const stepScripts = config.steps.map((step) => stepToPowerShell(step, promptEscaped))

  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
}
"@

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Focus-TerminalWindow {
  param([string]$Pattern)
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -match $Pattern -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) {
    [Win32]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 300
    return $proc.MainWindowHandle
  }
  Write-Host "[macro] No window matching pattern - using active window"
  return [IntPtr]::Zero
}

$hwnd = Focus-TerminalWindow -Pattern '${titlePatternEscaped}'
$offsetX = 0
$offsetY = 0
if ($hwnd -ne [IntPtr]::Zero) {
  $rect = New-Object Win32+RECT
  [Win32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
  $offsetX = $rect.Left
  $offsetY = $rect.Top
  Write-Host "[macro] Window offset: ($offsetX, $offsetY)"
}

${stepScripts.join('\n')}
Write-Host "[macro] Done"
`.trim()
}

function stepToPowerShell(step: MacroStep, promptEscaped: string): string {
  switch (step.type) {
    case 'click': {
      const x = finiteIntLiteral(step.x, 'x')
      const y = finiteIntLiteral(step.y, 'y')
      return `
Write-Host "[macro] click (${x}, ${y})"
[Win32]::SetCursorPos($offsetX + (${x}), $offsetY + (${y}))
Start-Sleep -Milliseconds 50
[Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
[Win32]::mouse_event([Win32]::MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
`.trim()
    }
    case 'delay':
      return `Start-Sleep -Milliseconds ${finiteIntLiteral(step.ms ?? 300, 'ms')}`
    case 'paste':
      return `
Write-Host "[macro] paste prompt"
[System.Windows.Forms.Clipboard]::SetText('${promptEscaped}')
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait('^v')
`.trim()
    case 'key': {
      const key = mapKey(step.key || 'Enter')
      return `
Write-Host "[macro] key"
[System.Windows.Forms.SendKeys]::SendWait('${key}')
`.trim()
    }
    case 'type':
      return `
Write-Host "[macro] type text"
[System.Windows.Forms.SendKeys]::SendWait('${escapePowerShellSingleQuoted(step.text || '')}')
`.trim()
    default:
      return `Write-Host "[macro] unknown step type"`
  }
}

function mapKey(key: string): string {
  const map: Record<string, string> = {
    Enter: '{ENTER}',
    Tab: '{TAB}',
    Escape: '{ESC}',
    '^l': '^l',
    '^v': '^v'
  }
  return escapePowerShellSingleQuoted(map[key] || key)
}

export class Win32MacroExecutor implements MacroExecutor {
  async execute(
    config: MacroConfig,
    context: MacroRunContext
  ): Promise<{ success: boolean; log: string[] }> {
    const log: string[] = []
    log.push(`[macro] Running ${config.name} macro (${config.steps.length} steps)`)

    if (process.platform !== 'win32') {
      log.push('[macro] Non-Windows: simulating macro steps (no real input)')
      for (const step of config.steps) {
        log.push(this.describeSimulatedStep(step, context))
        if (step.type === 'delay' && step.ms) {
          await sleep(step.ms)
        } else {
          await sleep(100)
        }
      }
      return { success: true, log }
    }

    try {
      const script = buildMacroPowerShellScript(config, context)
      const scriptPath = join(tmpdir(), `mousse-macro-${uuidv4()}.ps1`)
      writeFileSync(scriptPath, script, { encoding: 'utf-8', mode: 0o600 })

      try {
        const { stdout, stderr } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
          { timeout: 60000 }
        )
        if (stdout) log.push(stdout.trim())
        if (stderr) log.push(stderr.trim())
      } finally {
        try {
          unlinkSync(scriptPath)
        } catch {
          /* ignore */
        }
      }

      log.push('[macro] Execution completed')
      return { success: true, log }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.push(`[macro] Error: ${msg}`)
      return { success: false, log }
    }
  }

  private describeSimulatedStep(step: MacroStep, context: MacroRunContext): string {
    switch (step.type) {
      case 'click':
        return `[sim] click at (${step.x}, ${step.y})`
      case 'delay':
        return `[sim] delay ${step.ms}ms`
      case 'paste':
        return `[sim] paste: ${context.prompt.slice(0, 40)}...`
      case 'key':
        return `[sim] key: ${step.key}`
      case 'type':
        return `[sim] type: ${step.text}`
      default:
        return `[sim] ${step.type}`
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
