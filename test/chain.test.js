import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { encodeErrorResult } from 'viem'
import { providerError, errorText, fetchTransfers, cleanText, makeClient, readBalances } from '../src/chain.js'
import { NETWORKS, assetsFor } from '../src/networks.js'

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

test('an RPC that answers a balance read with an offchain lookup gets no request sent anywhere else', async (t) => {
  const rpc = 'https://rpc.example.test/'
  const offchainLookup = [{
    name: 'OffchainLookup',
    type: 'error',
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'urls', type: 'string[]' },
      { name: 'callData', type: 'bytes' },
      { name: 'callbackFunction', type: 'bytes4' },
      { name: 'extraData', type: 'bytes' },
    ],
  }]
  const elsewhere = []
  let rpcCalls = 0
  // No network: every request lands here. The RPC's reply is the revert that
  // asks a CCIP-Read client to fetch the listed URLs (EIP-3668).
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    if (String(url) !== rpc) {
      elsewhere.push(String(url))
      return new Response('0x')
    }
    rpcCalls++
    const req = JSON.parse(init.body)
    const data = encodeErrorResult({
      abi: offchainLookup,
      errorName: 'OffchainLookup',
      args: [req.params[0].to, ['https://elsewhere.example.test/x'], '0x1234', '0xaabbccdd', '0x'],
    })
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: 3, message: 'execution reverted', data } }),
      { headers: { 'Content-Type': 'application/json' } },
    )
  })
  const net = NETWORKS.mainnet
  const client = makeClient(net, rpc, { retryCount: 0 })
  const owner = '0x1111111111111111111111111111111111111111'
  await assert.rejects(readBalances(client, [owner], assetsFor(net), 30_000_000n))
  assert.deepEqual(elsewhere, [])
  assert.ok(rpcCalls > 0, 'the balance read reached the RPC')
})

test('an RPC that answers with a redirect is not followed to another host', async (t) => {
  // Two servers on this machine only: one plays the RPC, the other is where
  // its redirect points.
  const listen = async (handler) => {
    const server = createServer(handler).listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => {
      server.closeAllConnections()
      server.close()
    })
    return `http://127.0.0.1:${server.address().port}/`
  }
  const followed = []
  const elsewhere = await listen((req, res) => {
    followed.push(req.method)
    req.resume()
    res.end('{}')
  })
  // 302 would be followed as a GET; 307 would send the request body on too.
  for (const status of [302, 307]) {
    let asked = 0
    const rpc = await listen((req, res) => {
      asked++
      req.resume()
      res.writeHead(status, { Location: elsewhere }).end()
    })
    const client = makeClient(NETWORKS.mainnet, rpc, { retryCount: 0 })
    await assert.rejects(client.getBlockNumber())
    assert.equal(asked, 1, `the RPC was asked, and answered ${status}`)
  }
  assert.deepEqual(followed, [])
})
