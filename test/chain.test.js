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
