import { test } from 'node:test'
import assert from 'node:assert/strict'
import { providerError, errorText, fetchTransfers, cleanText } from '../src/chain.js'

const RPC = 'https://base-mainnet.example.test/v2/SECRETKEY123456?token=ANOTHERSECRET'

test('RPC errors never show the URL path, query or a key the provider quotes back', () => {
  const e = new Error(`invalid api key SECRETKEY123456 for /v2/SECRETKEY123456 at ${RPC}`)
  e.details = 'token ANOTHERSECRET rejected'
  const text = providerError(e, RPC)
  assert.ok(!text.includes('SECRETKEY123456') && !text.includes('ANOTHERSECRET'), text)
  assert.match(text, /invalid api key … for \/v2\/… at base-mainnet\.example\.test/)
  assert.ok(!errorText(new Error(`HTTP 401 for /v2/SECRETKEY123456`), RPC).includes('SECRETKEY123456'))
})

test('a key is masked as written in the URL, decoded, and as a bare query key', () => {
  const url = 'https://bob:pw1@rpc.example.test/v2?k=AB%2BCD%3DEF123&q=GH+IJ+KL+MN&BAREKEY12345&network=base'
  const text = cleanText('echo AB%2BCD%3DEF123 AB+CD=EF123 GH+IJ+KL+MN GH IJ KL MN BAREKEY12345 bob pw1 on base v2', url)
  for (const s of ['AB%2BCD', 'AB+CD=EF123', 'GH+IJ', 'GH IJ', 'BAREKEY', 'bob', 'pw1']) assert.ok(!text.includes(s), text)
  assert.match(text, /on base v2$/, 'short path and query parts that are ordinary words stay')
})

test('RPC text loses control characters that could clear the screen or fake a line', () => {
  const hostile = new Error('boom\x1b[2J\x1b]2;owned\x07\r  ✓ all checks passed\x9b')
  for (const text of [providerError(hostile, RPC), errorText(hostile, RPC), cleanText(hostile.message)]) {
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(text), JSON.stringify(text))
  }
})

test('a log without a well-formed transaction hash keeps no hash, so it links to its block', async () => {
  const good = '0x' + 'ab'.repeat(32)
  const log = (tx, logIndex) => ({
    blockNumber: 10n, logIndex, transactionHash: tx, address: '0xusdc',
    args: { from: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', value: 1n },
  })
  const client = { getLogs: async ({ args }) => (args.from ? [log(good, 0), log('0xabc\x1b[2J', 1)] : []) }
  const got = await fetchTransfers(client, ['0xusdc'], ['0x1111111111111111111111111111111111111111'], 10n, 10n)
  assert.deepEqual(got.map((l) => l.tx), [good, undefined])
})
