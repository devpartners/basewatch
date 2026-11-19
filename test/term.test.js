import { test } from 'node:test'
import assert from 'node:assert/strict'
import { imageProtocol, isITerm, inlineImage, clearImages, badge, title, logoPng } from '../src/term.js'
import { NETWORKS, explorerFor } from '../src/networks.js'

test('image protocol comes from what the terminal says it is', () => {
  assert.equal(imageProtocol({ TERM_PROGRAM: 'iTerm.app' }), 'iterm')
  assert.equal(imageProtocol({ LC_TERMINAL: 'iTerm2' }), 'iterm', 'iTerm2 over ssh')
  assert.equal(imageProtocol({ TERM_PROGRAM: 'WezTerm' }), 'iterm')
  assert.equal(imageProtocol({ TERM: 'xterm-kitty' }), 'kitty')
  assert.equal(imageProtocol({ TERM_PROGRAM: 'ghostty' }), 'kitty')
  assert.equal(imageProtocol({ TERM_PROGRAM: 'Apple_Terminal' }), null)
  assert.equal(imageProtocol({ TERM_PROGRAM: 'iTerm.app', TMUX: '/tmp/tmux' }), null, 'tmux hides the terminal')
  assert.equal(isITerm({ TERM_PROGRAM: 'WezTerm' }), false, 'the badge is iTerm2 only')
})

test('inline images keep the cursor where it was', () => {
  const png = Buffer.alloc(5000, 7)
  const iterm = inlineImage('iterm', png, { rows: 3, cols: 6 })
  assert.match(iterm, /^\x1b7\x1b\]1337;File=inline=1;size=5000;height=3;width=6;preserveAspectRatio=1:/)
  assert.ok(iterm.endsWith('\x07\x1b8'))

  const kitty = inlineImage('kitty', png, { rows: 3, cols: 6 })
  const chunks = kitty.split('\x1b\\').filter(Boolean)
  assert.equal(chunks.length, 2, '6,668 base64 bytes go in two 4096-byte chunks')
  assert.match(chunks[0], /^\x1b_Ga=T,f=100,q=2,C=1,r=3,m=1;/)
  assert.match(chunks[1], /^\x1b_Gm=0;/)
  assert.equal(inlineImage(null, png, { rows: 3, cols: 6 }), '')
  assert.equal(clearImages('iterm'), '')
})

test('badge and title escapes', () => {
  assert.equal(badge('BaseWatch'), `\x1b]1337;SetBadgeFormat=${Buffer.from('BaseWatch').toString('base64')}\x07`)
  assert.equal(title.set('a\x07b\x1bc'), '\x1b]2;abc\x07', 'control characters cannot end the title early')
})

test('the logo ships in the sizes the screen asks for', () => {
  for (const size of [256, 768]) assert.ok(logoPng(size)?.subarray(1, 4).toString() === 'PNG', `logo-${size}.png`)
})

test('explorers by name or URL', () => {
  assert.equal(explorerFor(NETWORKS.mainnet), 'https://basescan.org')
  assert.equal(explorerFor(NETWORKS.testnet, 'basescan'), 'https://sepolia.basescan.org')
  assert.equal(explorerFor(NETWORKS.mainnet, 'blockscout'), 'https://base.blockscout.com')
  assert.equal(explorerFor(NETWORKS.mainnet, 'https://example.test/base/'), 'https://example.test/base')
  assert.throws(() => explorerFor(NETWORKS.mainnet, 'etherscan'), /basescan or blockscout/)
  assert.throws(() => explorerFor(NETWORKS.mainnet, 'toString'), /basescan or blockscout/)
  assert.throws(() => explorerFor(NETWORKS.mainnet, 'javascript:alert(1)'), /https/)
})
