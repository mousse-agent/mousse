import { createServer } from 'vite'
const server = await createServer({ configFile: false, esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 5428, strictPort: true } })
await server.listen()
console.log('Renderer layout fixture: http://127.0.0.1:5428/tests/fixtures/net-gui/preview.html')
