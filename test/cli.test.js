import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { onExit } from '../src/cli.js'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))

// A reader that takes nothing until `take()` is called, like `less` waiting
// for a key.
function slowReader() {
  const pending = []
  const out = new Writable({ write: (chunk, _enc, done) => pending.push(done) })
  return { out, take: () => pending.splice(0).forEach((done) => done()) }
}

function quit(out) {
  const events = new EventEmitter()
  const codes = []
  let err = ''
  onExit(() => 'summary\n', { out, err: { write: (s) => (err += s) }, exit: (c) => codes.push(c), events, noteAfterMs: 5 })
  return { events, codes, err: () => err }
}

test('the summary is waited for, however late the reader takes it, and then exits 0', async () => {
  const reader = slowReader()
  const q = quit(reader.out)
  q.events.emit('SIGINT')
  await tick(20)
  assert.deepEqual(q.codes, [], 'still waiting')
  assert.match(q.err(), /waiting for the reader to take the summary; Ctrl-C again quits without it/)
  reader.take()
  await tick()
  assert.deepEqual(q.codes, [0])
})

test('a second Ctrl-C quits without the summary, with exit code 1', async () => {
  const q = quit(slowReader().out)
  q.events.emit('SIGINT')
  q.events.emit('SIGINT')
  assert.deepEqual(q.codes, [1])
  assert.match(q.err(), /quit before the reader took the summary/)
})

test('a reader that takes the summary at once gets no note', async () => {
  const q = quit(new Writable({ write: (_c, _e, done) => done() }))
  q.events.emit('SIGTERM')
  await tick(20)
  assert.deepEqual(q.codes, [0])
  assert.equal(q.err(), '')
})

test('a run warns about a plain http RPC on another machine, and not about a node on this one', () => {
  const bin = fileURLToPath(new URL('../bin/basewatch.js', import.meta.url))
  const wallet = '0x1111111111111111111111111111111111111111'
  // Nothing listens on either port, so each run ends at its first read, and
  // nothing leaves this machine. 0.0.0.0 stands in for another machine: it is
  // not a name basewatch can be sure means this one.
  const run = (rpc) => spawnSync(process.execPath, [bin, '--plain', '--rpc', rpc, wallet], { encoding: 'utf8', timeout: 30_000 })
  const far = run('http://0.0.0.0:1/v2/SECRETKEY12345')
  assert.equal(far.status, 1)
  assert.match(far.stderr, /^basewatch: warning: 0\.0\.0\.0:1 is reached over plain http, so anyone on the network between can read and change its answers; use an https:\/\/ RPC unless you trust that network\n/)
  assert.ok(!far.stderr.includes('SECRETKEY12345'), 'the path, which may hold a key, is not shown')
  const near = run('http://127.0.0.1:1')
  assert.equal(near.status, 1)
  assert.ok(!near.stderr.includes('warning'), near.stderr)
})
