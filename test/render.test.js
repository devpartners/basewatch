import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Tracker } from '../src/tracker.js'
import { makeStyle, stripAnsi, visibleLength } from '../src/format.js'
import { NETWORKS, assetsFor } from '../src/networks.js'
import { renderFrame, renderSummary, washIn, flag, WAVE_MS } from '../src/render.js'

const net = NETWORKS.mainnet
const BUYER = '0x1111111111111111111111111111111111111111'
const SELLER = '0x2222222222222222222222222222222222222222'
const TX = `0x${'ab'.repeat(32)}`

function makeUi({ keys = true, failures = 0, explorer = 'https://basescan.org' } = {}) {
  const tracker = new Tracker([{ address: BUYER, label: 'buyer' }, { address: SELLER, label: 'seller' }], assetsFor(net))
  tracker.baseline(new Map([[BUYER, { USDC: 2_000_000n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 0n }]]), 100n, 0)
  tracker.apply(
    [{ block: 101n, logIndex: 0, tx: TX, token: net.usdc, from: BUYER, to: SELLER, value: 1_000n }],
    new Map([[BUYER, { USDC: 1_999_000n, ETH: 0n }], [SELLER, { USDC: 1_000n, ETH: 0n }]]),
    101n,
    1_000,
  )
  const status = { ok: failures < 2, failures, error: failures ? 'request timed out' : null }
  return {
    net, explorer, tracker, keys, waves: null, startedAt: 0,
    rpcUrl: 'https://base-rpc.publicnode.com',
    watcher: { status, head: 103n },
    style: makeStyle(false),
    links: false,
  }
}

test('the frame fills the screen and ends with the keys', () => {
  const lines = renderFrame(makeUi(), { width: 140, height: 24, now: 60_000 })
  assert.equal(lines.length, 24)
  assert.match(lines.at(-1), /1–2: wallet on basescan\.org · t: newest tx · q: quit/)
  assert.ok(lines.at(-1).length <= 60, 'the key hints fit a large demo font')
  assert.match(lines[0], /live {2}block/, 'the flag comes before the block number')
  assert.ok(lines.some((l) => /━━ 1 buyer {2}0x1111/.test(l)), 'wallets are numbered for their keys')
  assert.ok(lines.some((l) => /━━ 2 seller/.test(l)))
  assert.ok(lines.every((l) => !l.includes('https://')), 'no URLs on the live screen')
})

test('without a keyboard there are no numbers and no key hints', () => {
  const lines = renderFrame(makeUi({ keys: false }), { width: 140, height: 24, now: 60_000 })
  assert.match(lines.at(-1), /Ctrl-C: quit/)
  assert.ok(lines.some((l) => /━━ buyer/.test(l)))
})

test('a flash message replaces the key hints until it expires', () => {
  const ui = makeUi()
  ui.flash = { text: '↗ opening buyer on basescan.org', until: 5_000 }
  assert.match(renderFrame(ui, { width: 140, height: 24, now: 4_000 }).at(-1), /opening buyer/)
  assert.match(renderFrame(ui, { width: 140, height: 24, now: 6_000 }).at(-1), /1–2: wallet/)
})

test('the header skips the corner kept for the logo', () => {
  const lines = renderFrame(makeUi(), { width: 100, height: 24, now: 60_000, mark: { rows: 3, cols: 8 } })
  for (const l of lines.slice(0, 3)) assert.ok(l.startsWith('\x1b[8C'), JSON.stringify(l))
  assert.ok(!lines[3].startsWith('\x1b[8C'))
  assert.ok(visibleLength(lines[0]) <= 99 - 8)
})

test('connection status is a lifeguard flag', () => {
  assert.equal(flag(makeUi({ failures: 0 })), '⚑ green flag · live')
  assert.equal(flag(makeUi({ failures: 1 })), '⚑ yellow flag · retrying', 'one failure is retried quietly')
  assert.equal(flag(makeUi({ failures: 3 })), '⚑ red flag · request timed out; retrying')
})

test('a new change washes in from the left', () => {
  const s = makeStyle(false)
  const row = 'abcdefghijklmnopqrst'
  assert.equal(washIn(s, row, 0), '')
  // Halfway: the crest's leading edge is at column 14 of 20 + 9.
  assert.equal(stripAnsi(washIn(s, row, 0.5)), 'abcde▁▂▄▆█▇▅▃▂')
  assert.equal(stripAnsi(washIn(s, row, 0.1)), '▃▂', 'the leading edge arrives before any text')
  assert.equal(stripAnsi(washIn(s, row, 1)), row + '▁▂▄▆█▇▅▃▂', 'at the end the whole row is behind the wave')

  const ui = makeUi()
  const seq = ui.tracker.wallet(BUYER).transitions[0].seq
  ui.waves = new Map([[seq, 10_000]])
  const mid = renderFrame(ui, { width: 140, height: 24, now: 10_000 + WAVE_MS / 2 })
  const done = renderFrame(ui, { width: 140, height: 24, now: 10_000 + WAVE_MS })
  assert.ok(mid.some((l) => l.includes('▆█▇')), 'the wave is on screen mid-way')
  assert.ok(!done.some((l) => l.includes('▆█▇')), 'and gone once it has passed')
})

test('the summary links each wallet and transaction on the chosen explorer', () => {
  const ui = makeUi({ explorer: 'https://base.blockscout.com' })
  const out = stripAnsi(renderSummary(ui, { now: 60_000 }))
  assert.match(out, /end-of-shift summary/)
  assert.match(out, /https:\/\/base\.blockscout\.com\/address\/0x1111111111111111111111111111111111111111/)
  assert.match(out, new RegExp(`https://base\\.blockscout\\.com/tx/${TX}`))
})
