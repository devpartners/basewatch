import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { privateKeyToAccount } from 'viem/accounts'
import { doctor } from '../src/doctor.js'

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const ADDRESS = privateKeyToAccount(KEY).address

function fakeClient({ chainId = 8453, age = 1, getLogs, balance = 2_202_000n, seen = {} } = {}) {
  return {
    getChainId: async () => chainId,
    getBlock: async () => ({ number: 1_000n, timestamp: BigInt(Math.floor(Date.now() / 1000) - age) }),
    getLogs: getLogs ?? (async ({ toBlock }) => ((seen.logsTo = toBlock), [])),
    multicall: async ({ contracts, blockNumber }) => ((seen.balancesAt = blockNumber), contracts.map(() => balance)),
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

test('a plain http RPC on another machine is a warning; a node on this machine is not', async () => {
  const far = await run(['--rpc', 'http://192.168.1.20:8545/v2/key'])
  assert.equal(far.code, 0)
  assert.match(far.out, /! rpc +192\.168\.1\.20:8545 \(path hidden: it may hold a key\), over plain http {2}\[flag --rpc\]\n {4}hint: anyone on the network between can read and change its answers; use an https:\/\/ RPC/)
  assert.match(far.out, /all checks passed, 1 warning/)
  const near = await run(['--rpc', 'http://localhost:8545'])
  assert.equal(near.code, 0)
  assert.match(near.out, /✓ rpc +localhost:8545 {2}\[flag --rpc\]/)
  assert.ok(!near.out.includes('warning'), near.out)
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

test('a log query answered with a malformed log gets a hint about the answer, not about a refusal', async () => {
  const getLogs = async ({ args, address }) =>
    args.from
      ? [{ blockNumber: 998n, logIndex: 0, transactionHash: '0x' + 'ab'.repeat(32), address: address[0], args: { from: ADDRESS, to: 'nowhere', value: 1n } }]
      : []
  const { code, out } = await run([ADDRESS], { client: fakeClient({ getLogs }) })
  assert.equal(code, 1)
  assert.match(out, /✗ log query +the RPC sent a Transfer log that is not well formed\n {4}hint: this RPC answered the log query, but with a log that has a missing or impossible field/)
  assert.ok(!out.includes('eth_getLogs'), 'the RPC did not refuse the query')
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

test('the log query and balance read stay --confirmations blocks behind, as a run does', async () => {
  const seen = {}
  assert.equal((await run([], { client: fakeClient({ seen }) })).code, 0)
  assert.deepEqual(seen, { logsTo: 998n, balancesAt: 998n })
  assert.equal((await run(['--confirmations', '0'], { client: fakeClient({ seen }) })).code, 0)
  assert.deepEqual(seen, { logsTo: 1_000n, balancesAt: 1_000n })
})

test('--keychain off macOS fails in doctor even with no new wallet, as it does in a run', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux' })
  try {
    const { code, out, url } = await run(['--keychain', ADDRESS])
    assert.equal(code, 1)
    assert.match(out, /✗ options +--keychain needs macOS/)
    assert.equal(url, undefined, 'stops before any RPC call')
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})

test('doctor refuses a key folder that cannot be made, and treats an empty --key-dir as unset', { skip: process.getuid?.() === 0 && 'root can write anywhere' }, async () => {
  const home = process.cwd()
  const locked = mkdtempSync(join(tmpdir(), 'basewatch-doctor-'))
  chmodSync(locked, 0o500)
  try {
    const refused = await run(['new=buyer', '--key-dir', join(locked, 'keys')])
    assert.equal(refused.code, 1)
    assert.match(refused.out, /✗ new keys +can't make --key-dir .*isn't writable/)
    process.chdir(mkdtempSync(join(tmpdir(), 'basewatch-doctor-')))
    const empty = await run(['new=buyer', '--key-dir', ''])
    assert.equal(empty.code, 0)
    assert.match(empty.out, /✓ new keys +can be stored: \.wallets/)
  } finally {
    process.chdir(home)
    chmodSync(locked, 0o700)
  }
})
