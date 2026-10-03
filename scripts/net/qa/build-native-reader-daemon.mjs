import { build } from 'esbuild'
import { buildCli, getCliBuildOptions } from '../../build-cli.mjs'
await buildCli()
await build({ ...getCliBuildOptions(process.cwd()), entryPoints: ['scripts/net/qa/native-reader-daemon.ts'], outfile: 'out/net-qa/native-reader-daemon.js' })
