import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { parseSpec, resolveWallets } from '../src/wallets.js'

const A = '0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E'

test('wallet specs', () => {
  assert.deepEqual(parseSpec(A), { kind: 'address', address: A, label: undefined })
  assert.deepEqual(parseSpec(`${A}=buyer`), { kind: 'address', address: A, label: 'buyer' })
  assert.deepEqual(parseSpec(`https://basescan.org/address/${A}`).address, A)
  assert.deepEqual(parseSpec('new'), { kind: 'new', label: undefined })
  assert.deepEqual(parseSpec('new=x402-buyer'), { kind: 'new', label: 'x402-buyer' })
  assert.deepEqual(parseSpec('env:X402_BUYER_PRIVATE_KEY'), { kind: 'env', name: 'X402_BUYER_PRIVATE_KEY', label: 'X402_BUYER_PRIVATE_KEY' })
  assert.deepEqual(parseSpec('keychain:x402-buyer=buyer'), { kind: 'keychain', service: 'x402-buyer', label: 'buyer' })
  assert.throws(() => parseSpec('0x1234'), /can't read wallet/)
  assert.throws(() => parseSpec(`${A}=has space`), /label/)
})

test('an explorer URL gives a wallet only from its /address/ page', () => {
  const tx = '0x' + 'ab'.repeat(32)
  assert.deepEqual(parseSpec(`https://base.blockscout.com/address/${A}?tab=token_transfers`), { kind: 'address', address: A, label: undefined })
  assert.deepEqual(parseSpec(`https://basescan.org/address/${A}#tokentxns`).label, undefined)
  assert.deepEqual(parseSpec(`https://basescan.org/address/${A}=buyer`), { kind: 'address', address: A, label: 'buyer' })
  assert.deepEqual(parseSpec(`https://basescan.org/address/${A}?a=b=buyer`).label, 'buyer')
  assert.deepEqual(parseSpec(`https://www.oklink.com/base/address/${A.toLowerCase()}`).address, A.toLowerCase())
  // A transaction hash or a token page's ?a= is not the wallet's address.
  assert.throws(() => parseSpec(`https://basescan.org/tx/${tx}`), /isn't a wallet's address page/)
  assert.throws(() => parseSpec(`https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?a=${A}`), /address page/)
  assert.throws(() => parseSpec(`https://basescan.org/address/${A}00`), /address page/)
})

test('a mistyped mixed-case address fails its checksum', () => {
  const typo = A.replace('ebDb', 'ebDB')
  assert.throws(() => resolveWallets([typo]), /checksum/)
  // All-lowercase has no checksum to check, so it is accepted.
  assert.equal(resolveWallets([A.toLowerCase()])[0].address, A)
})

test('new wallets save a key file only the owner can read, matching the address', () => {
  const dir = mkdtempSync(join(tmpdir(), 'basewatch-test-'))
  const [w] = resolveWallets(['new=buyer'], { keyDir: dir })
  assert.equal(w.key, undefined, 'the key is not kept unless --show-key')
  const file = join(dir, `buyer-${w.address.slice(0, 10)}.key`)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(privateKeyToAccount(readFileSync(file, 'utf8').trim()).address, w.address)
  assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), '*\n')
})

test('env:VAR gives the address without keeping the key', () => {
  const key = '0x' + '11'.repeat(32)
  process.env.BW_TEST_KEY = key
  const [w] = resolveWallets(['env:BW_TEST_KEY=buyer'])
  assert.equal(w.address, privateKeyToAccount(key).address)
  assert.equal(JSON.stringify(w).includes('11'.repeat(32)), false)
  process.env.BW_TEST_KEY = 'nope'
  assert.throws(() => resolveWallets(['env:BW_TEST_KEY']), /doesn't hold a private key/)
})

test('refuses a new wallet whose key would be kept nowhere, and duplicates', () => {
  assert.throws(() => resolveWallets(['new'], { save: false }), /--no-save/)
  assert.throws(() => resolveWallets([A, A.toLowerCase()]), /listed twice/)
  assert.throws(() => resolveWallets([`${A}=x`, 'new=x'], { save: false, showKey: true }), /label "x"/)
})

test('keys go only in a folder git is sure to ignore', () => {
  // A folder that already holds other files is refused, and nothing is written.
  const project = mkdtempSync(join(tmpdir(), 'basewatch-test-'))
  writeFileSync(join(project, '.gitignore'), 'node_modules\n')
  assert.throws(() => resolveWallets(['new=buyer'], { keyDir: project }), /already holds other files/)
  assert.deepEqual(readdirSync(project), ['.gitignore'])
  assert.equal(readFileSync(join(project, '.gitignore'), 'utf8'), 'node_modules\n', 'its .gitignore is left alone')

  // An empty folder is taken over: mode 700 and a "*" .gitignore.
  const empty = mkdtempSync(join(tmpdir(), 'basewatch-test-'))
  resolveWallets(['new=a'], { keyDir: empty })
  assert.equal(statSync(empty).mode & 0o777, 0o700)
  assert.equal(readFileSync(join(empty, '.gitignore'), 'utf8'), '*\n')

  // basewatch's own folder is used again, and a missing one is made.
  resolveWallets(['new=b'], { keyDir: empty })
  assert.equal(readdirSync(empty).filter((f) => f.endsWith('.key')).length, 2)
  const fresh = join(mkdtempSync(join(tmpdir(), 'basewatch-test-')), 'keys', 'demo')
  resolveWallets(['new=c'], { keyDir: fresh })
  assert.equal(statSync(fresh).mode & 0o777, 0o700)

  const file = join(project, 'notes.txt')
  writeFileSync(file, '')
  assert.throws(() => resolveWallets(['new'], { keyDir: file }), /is a file, not a folder/)
})
