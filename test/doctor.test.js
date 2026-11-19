import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { doctor } from '../src/doctor.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDRESS = privateKeyToAccount(KEY).address

function fakeClient({ chainId = 8453, age = 1, getLogs, balance = 2_202_000n } = {}) {
  return {
    getChainId: async () => chainId,
    getBlock: async () => ({ number: 1_000n, timestamp: BigInt(Math.floor(Date.now() / 1000) - age) }),
    getLogs: getLogs ?? (async () => []),
    multicall: async ({ contracts }) => contracts.map(() => balance),
  }
}

async function run(argv, { env = {}, client = fakeClient() } = {}) {
  let out = ''
  let url
  const code = await doctor(argv, {
    env,
    tty: false,
    write: (s) => (out += s),
    makeClient: (_net, u) => ((url = u), client),
  })
  return { code, out, url }
}

test('a healthy setup passes every check, each setting with its source', async () => {
  const { code, out, url } = await run([`${ADDRESS}=seller`], { env: { BASE_RPC_URL: 'https://rpc.example.test' } })
  assert.equal(code, 0)
  assert.equal(url, 'https://rpc.example.test')
  assert.match(out, /✓ rpc +rpc\.example\.test {2}\[env BASE_RPC_URL\]/)
  assert.match(out, /✓ network +Base mainnet, chain 8453 {2}\[default\]/)
  for (const step of ['chain id', 'newest block', 'log query', 'balances']) assert.match(out, new RegExp(`✓ ${step} .* \\d+ ms`))
  assert.match(out, /seller {2}2\.202000 USDC/)
  assert.match(out, /all checks passed/)
})

test('a key is shown as its address and length, never its characters', async () => {
  const { code, out } = await run(['env:BUYER_KEY=buyer'], { env: { BUYER_KEY: KEY } })
  assert.equal(code, 0)
  assert.ok(out.includes(ADDRESS))
  assert.match(out, /\[key from \$BUYER_KEY, 66 characters\]/)
  assert.ok(!out.includes(KEY.slice(2, 10)) && !out.includes(KEY.slice(-8)), 'no part of the key is printed')
})

test('a missing key stops before any RPC call', async () => {
  const { code, out, url } = await run(['env:BUYER_KEY=buyer'])
  assert.equal(code, 1)
  assert.match(out, /✗ wallet +\$BUYER_KEY is not set\n {4}hint: export BUYER_KEY=/)
  assert.equal(url, undefined, 'no client was made')
  assert.ok(!out.includes('chain id'))
})

test('the wrong network says which flag to change', async () => {
  const { code, out } = await run(['--testnet'], { client: fakeClient({ chainId: 8453 }) })
  assert.equal(code, 1)
  assert.match(out, /✗ chain id +8453, but Base Sepolia is 84532\n {4}hint: that RPC serves Base mainnet; drop --testnet/)
})

test("a refused log query prints the provider's whole error and stops there", async () => {
  const getLogs = async () => {
    const e = new Error('RPC Request failed.')
    e.shortMessage = 'RPC Request failed.'
    e.details = 'request limit reached'
    throw e
  }
  const { code, out } = await run([], { client: fakeClient({ getLogs }) })
  assert.equal(code, 1)
  assert.match(out, /✗ log query +RPC Request failed\. — request limit reached\n {4}hint: this RPC refuses or limits eth_getLogs/)
  assert.ok(!out.includes('balances'), 'nothing after the first failure')
})

test('an RPC URL path is hidden, since it may hold an API key', async () => {
  const { out } = await run(['--rpc', 'https://base.example.test/v2/SECRET123'])
  assert.match(out, /✓ rpc +base\.example\.test \(path hidden: it may hold a key\) {2}\[flag --rpc\]/)
  assert.ok(!out.includes('SECRET123'))
})

test('a stale node is a warning, not a failure', async () => {
  const { code, out } = await run([], { client: fakeClient({ age: 600 }) })
  assert.equal(code, 0)
  assert.match(out, /! newest block +1,000, 60[01] s old\n {4}hint: the RPC node is behind/)
  assert.match(out, /all checks passed, 1 warning/)
})

test('doctor never creates a wallet', async () => {
  // In a fresh folder, so a .wallets left by an earlier real run can't matter.
  const home = process.cwd()
  process.chdir(mkdtempSync(join(tmpdir(), 'basewatch-doctor-')))
  try {
    const { code, out } = await run(['new=buyer'])
    assert.equal(code, 0)
    assert.match(out, /– wallet +buyer: created when basewatch runs; doctor never creates wallets/)
    assert.match(out, /✓ new keys +can be stored: \.wallets/)
    assert.ok(!existsSync('.wallets'), 'no key directory was made')
  } finally {
    process.chdir(home)
  }
})

test("doctor takes a run's whole command line, and checks it as the run would", async () => {
  const ok = await run(['--plain', '--interval', '500', '--confirmations', '1', '--no-links', '--bell', `${ADDRESS}=seller`])
  assert.equal(ok.code, 0)
  const slow = await run(['--interval', '10'])
  assert.equal(slow.code, 1)
  assert.match(slow.out, /✗ options +--interval must be a whole number of at least 250/)
})

test('two wallets with one label fail in doctor, as they do in a run', async () => {
  const other = '0x9b98695Fc3a1616edE9605416B7D2bB90Fec0ace'
  const { code, out, url } = await run([`${ADDRESS}=x`, `${other}=x`])
  assert.equal(code, 1)
  assert.match(out, /✗ wallet +label "x" is listed twice\n {4}hint: give each wallet its own =label/)
  assert.equal(url, undefined, 'stops before any RPC call')
})

test('doctor refuses a key folder a run would refuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'basewatch-doctor-'))
  writeFileSync(join(dir, 'README.md'), 'a project\n')
  const { code, out } = await run(['new=buyer', '--key-dir', dir])
  assert.equal(code, 1)
  assert.match(out, /✗ new keys +--key-dir .* already holds other files/)
  assert.deepEqual(readdirSync(dir), ['README.md'], 'nothing was written')
})

test('an empty BASE_RPC_URL counts as unset', async () => {
  const { code, out, url } = await run([], { env: { BASE_RPC_URL: '' } })
  assert.equal(code, 0)
  assert.equal(url, 'https://base-rpc.publicnode.com')
  assert.match(out, /✓ rpc +base-rpc\.publicnode\.com {2}\[default\]/)
})
