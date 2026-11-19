#!/usr/bin/env node
// Node.js and the dependencies are checked before anything imports them, so a
// broken install says what to fix instead of crashing.
const [major] = process.versions.node.split('.').map(Number)
if (major < 20) {
  process.stderr.write(`basewatch: needs Node.js 20 or newer; this is ${process.versions.node}\n`)
  process.exit(1)
}
let main
try {
  ;({ main } = await import('../src/cli.js'))
} catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e
  const dir = new URL('..', import.meta.url).pathname
  process.stderr.write(`basewatch: ${e.message.split('\n')[0]}\n    hint: run npm install in ${dir}\n`)
  process.exit(1)
}
await main(process.argv.slice(2))
