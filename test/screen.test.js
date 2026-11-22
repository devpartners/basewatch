import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Screen } from '../src/screen.js'
import { makeStyle } from '../src/format.js'

// The splash as it would be written, without taking over a terminal.
function splash(rpcUrl) {
  const ui = { style: makeStyle(false), rpcUrl, tracker: { wallets: [{}, {}] } }
  const screen = new Screen(ui)
  let frame = ''
  screen.out = { rows: 30, columns: 100, write: (s) => (frame += s) }
  screen.splash()
  return frame
}

test('the splash marks a plain http RPC on another machine, and shows only its host', () => {
  const far = splash('http://192.168.1.20:8545/v2/SECRETKEY12345')
  assert.ok(far.includes('connecting to 192.168.1.20:8545 (plain http) · 2 wallets'), JSON.stringify(far))
  assert.ok(!far.includes('SECRETKEY12345'))
  for (const rpcUrl of ['http://localhost:8545', 'https://rpc.example.test/v2/SECRETKEY12345']) {
    const near = splash(rpcUrl)
    assert.ok(near.includes(`connecting to ${new URL(rpcUrl).host} · 2 wallets`), JSON.stringify(near))
    assert.ok(!near.includes('plain http') && !near.includes('SECRETKEY12345'))
  }
})
