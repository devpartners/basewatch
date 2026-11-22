import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { encodeErrorResult } from 'viem'
import {
  providerError, errorText, fetchTransfers, cleanText, makeClient, readBalances, plainHttp, rpcShown,
} from '../src/chain.js'
import { NETWORKS, assetsFor } from '../src/networks.js'

const RPC = 'https://base-mainnet.example.test/v2/SECRETKEY123456?token=ANOTHERSECRET'
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const OWNER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'

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
    blockNumber: 10n, logIndex, transactionHash: tx, address: USDC,
    args: { from: OWNER, to: OTHER, value: 1n },
  })
  const client = { getLogs: async ({ args }) => (args.from ? [log(good, 0), log('0xabc\x1b[2J', 1), log([good], 2)] : []) }
  const got = await fetchTransfers(client, [USDC], [OWNER], 10n, 10n)
  assert.deepEqual(got.map((l) => l.tx), [good, undefined, undefined])
})

test('a Transfer log with a field the history cannot trust is refused, and none of it is shown', async () => {
  const hostile = '\x1b]0;owned\x07\x1b[2JEVIL'
  const sound = { blockNumber: 10n, logIndex: 0, transactionHash: '0x' + 'ab'.repeat(32), address: USDC }
  const args = { from: OWNER, to: OTHER, value: 1n }
  const broken = {
    'a counterparty that is not an address': { ...sound, args: { ...args, to: hostile } },
    'a sender that is not an address': { ...sound, args: { ...args, from: hostile } },
    'an amount that is not a whole number': { ...sound, args: { ...args, value: '1' } },
    'no amount': { ...sound, args: { from: OWNER, to: OTHER } },
    'no decoded fields': { ...sound, args: undefined },
    'a token that is not an address': { ...sound, address: hostile, args },
    'no block number': { ...sound, blockNumber: null, args },
    'a block after the ones asked for': { ...sound, blockNumber: 11n, args },
    'a block before the ones asked for': { ...sound, blockNumber: 9n, args },
    'no place in its block': { ...sound, logIndex: null, args },
    'a place that is not a number': { ...sound, logIndex: NaN, args },
    'a place before the first': { ...sound, logIndex: -1, args },
  }
  for (const [what, log] of Object.entries(broken)) {
    // A sound log first: nothing is returned, so nothing is half recorded.
    const client = { getLogs: async ({ args }) => (args.from ? [{ ...sound, logIndex: 1, args: { from: OWNER, to: OTHER, value: 2n } }, log] : []) }
    await assert.rejects(fetchTransfers(client, [USDC], [OWNER], 10n, 10n), (e) => {
      assert.equal(e.message, 'the RPC sent a Transfer log that is not well formed', what)
      return true
    })
  }
})

test('read through viem, an honest Transfer log is kept and one carrying its own args is refused', async (t) => {
  const rpc = 'https://rpc.example.test/'
  const topic = (address) => '0x' + '0'.repeat(24) + address.slice(2).toLowerCase()
  let extra = {}
  // No network: the RPC's reply to eth_getLogs is made here.
  t.mock.method(globalThis, 'fetch', async (_url, init = {}) => {
    const req = JSON.parse(init.body)
    const result = [{
      address: USDC,
      // Transfer(address,address,uint256), from OWNER to OTHER, of 5
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', topic(OWNER), topic(OTHER)],
      data: '0x' + '5'.padStart(64, '0'),
      blockNumber: '0x10',
      logIndex: '0x0',
      transactionIndex: '0x0',
      blockHash: '0x' + '22'.repeat(32),
      transactionHash: '0x' + 'ab'.repeat(32),
      ...extra,
    }]
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }), { headers: { 'Content-Type': 'application/json' } })
  })
  const client = makeClient(NETWORKS.mainnet, rpc, { retryCount: 0 })
  const [log] = await fetchTransfers(client, [USDC], [OWNER], 16n, 16n)
  assert.deepEqual(
    { block: log.block, from: log.from.toLowerCase(), to: log.to.toLowerCase(), value: log.value },
    { block: 16n, from: OWNER, to: OTHER, value: 5n },
  )
  extra = { args: { from: OWNER, to: '\x1b]0;owned\x07\x1b[2JEVIL', value: '5' } }
  await assert.rejects(fetchTransfers(client, [USDC], [OWNER], 16n, 16n), /^Error: the RPC sent a Transfer log that is not well formed$/)
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
    // Both a run (errorText) and doctor (providerError) say what happened.
    await assert.rejects(client.getBlockNumber(), (e) => {
      for (const text of [errorText(e, rpc), providerError(e, rpc)]) {
        assert.equal(text, 'the RPC answered with a redirect, which basewatch does not follow')
      }
      return true
    })
    assert.equal(asked, 1, `the RPC was asked, and answered ${status}`)
  }
  assert.deepEqual(followed, [])
})

test("an RPC cannot make its own error read as a redirect by using fetch's words", () => {
  const words = 'unexpected redirect'
  // The shapes an RPC's JSON reply can take once viem has wrapped it.
  const fromReply = [
    Object.assign(new Error('RPC Request failed.'), { cause: { code: -32000, message: words } }),
    Object.assign(new Error('RPC Request failed.'), { cause: { code: -32000, message: 'fetch failed', cause: { message: words } } }),
    new Error(words),
  ]
  for (const e of fromReply) {
    for (const text of [errorText(e, RPC), providerError(e, RPC)]) assert.doesNotMatch(text, /answered with a redirect/)
  }
})

test('plain http is marked for another machine, and not for a node on this one', () => {
  for (const url of [
    'http://192.168.1.20:8545',
    'http://rpc.example.test/v2/key',
    'http://localhost.example.test',
    'http://notlocalhost',
    'http://127.0.0.1.example.test',
    'http://anvil.localhost:8545', // the system's resolver decides where this goes
    'http://[::ffff:127.0.0.1]:8545',
  ]) {
    assert.equal(plainHttp(url), true, url)
  }
  for (const url of [
    'https://rpc.example.test',
    'http://localhost:8545',
    'http://LOCALHOST.:8545',
    'http://127.0.0.1:8545',
    'http://127.9.9.9',
    'http://[::1]:8545',
    'not a url',
    '',
  ]) {
    assert.equal(plainHttp(url), false, url)
  }
  assert.equal(rpcShown('http://192.168.1.20:8545/v2/key'), '192.168.1.20:8545 (plain http)')
  assert.equal(rpcShown('http://localhost:8545'), 'localhost:8545')
  assert.equal(rpcShown('https://rpc.example.test/v2/key'), 'rpc.example.test')
})
