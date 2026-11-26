// A console program (run by node.exe) that reports whether it has a visible console window, then starts the same
// probe as a child with ordinary defaults, as Git starts a hook, and reports that one too.
// argv: "leaf" for the child.
const { spawn } = require('node:child_process')
const ffi = require('koffi')
const kernel = ffi.load('kernel32.dll')
const user = ffi.load('user32.dll')
const consoleWindow = kernel.func('void * __stdcall GetConsoleWindow()')
const isVisible = user.func('int32_t __stdcall IsWindowVisible(void *)')
const owner = user.func('void * __stdcall GetWindow(void *, uint32_t)')

function window() {
  const hwnd = consoleWindow()
  if (!hwnd) return { window: false, visible: false }
  // A console handed to a terminal (a pseudo console) has a hidden window owned by the terminal's own window.
  const terminal = owner(hwnd, 4) // GW_OWNER
  return { window: true, visible: isVisible(hwnd) !== 0 || (terminal !== null && isVisible(terminal) !== 0) }
}

const self = window()
if (process.argv[2] === 'leaf') {
  process.stdout.write(JSON.stringify(self))
} else {
  const child = spawn(process.execPath, [__filename, 'leaf'])
  let out = ''
  child.stdout.on('data', (data) => { out += data })
  child.stderr.on('data', (data) => process.stderr.write(data))
  child.on('close', (code) => {
    let grandchild
    try { grandchild = JSON.parse(out) } catch { grandchild = { error: 'exit ' + code + ': ' + out } }
    process.stdout.write(JSON.stringify({ self, grandchild }))
  })
}
