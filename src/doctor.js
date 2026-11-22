// basewatch doctor: walks install → settings → wallets → the RPC calls a run
// depends on, and stops at the first failure, so the last line printed is the
// thing to fix. It is read-only: it never creates wallets or writes anything.
import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { NETWORKS, assetsFor, explorerFor } from './networks.js'
import {
  makeClient, readBalances, fetchTransfers, providerError, plainHttp, PLAIN_HTTP_RISK, MalformedLog,
} from './chain.js'
import { parseSpec, labelsFor, rejectRepeats, checkKeyStores, checkAddress, addressFromKey, keychainRead } from './wallets.js'
import { RUN_OPTIONS, timing, rpcFrom, keyDirFrom } from './options.js'
import { makeStyle, fmtAmount, num, shortAddr } from './format.js'

export const HELP = `basewatch doctor: check that basewatch can run here, and say what to fix if not

Usage
  basewatch doctor [options] [<wallet>...]

Checks run in this order and stop at the first failure:
  install      Node.js, basewatch and viem versions
  settings     network, RPC and explorer, each with where its value came from
  wallets      each wallet you name resolves (private keys are never shown)
  rpc          chain ID, newest block, a USDC log query and a balance read:
               real calls, each with its time

Put doctor in front of the command you will run: it takes the same wallets
and every option a run does, and checks them as the run would.
Nothing is changed: new wallets are not created, and no key is written.

Options
  --testnet            Base Sepolia instead of Base mainnet
  --rpc URL            JSON-RPC endpoint (or set BASE_RPC_URL)
  --explorer NAME|URL  basescan (default), blockscout, or another explorer's base URL
                       (a URL isn't switched for --testnet; give the testnet one)
  --no-color           no colors (NO_COLOR is honoured too)
  -h, --help           show this help

The other run options are taken too. --interval, --confirmations and
--keychain are checked, and so are --key-dir, --no-save and --show-key when
a new wallet is named; the rest need no check. The log query and balance
read stay --confirmations blocks behind the newest block, as a run does.
`

const LOG_RANGE = 100n // the most blocks one watcher poll asks for
const STALE_S = 60
// Watched in place of a wallet when none is named, so the log query has the same shape as a run.
const PLACEHOLDER = '0x000000000000000000000000000000000000dEaD'

class Stop extends Error {}

// Exit code 0 when no check failed. `deps` lets tests swap the environment,
// the RPC client and the output.
export async function doctor(argv, deps = {}) {
  const env = deps.env ?? process.env
  const write = deps.write ?? ((s) => process.stdout.write(s))
  const clientFor = deps.makeClient ?? ((net, url) => makeClient(net, url, { retryCount: 0 }))
  const tty = deps.tty ?? Boolean(process.stdout.isTTY)

  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: RUN_OPTIONS,
    })
  } catch (e) {
    write(`basewatch doctor: ${e.message}\nRun basewatch doctor --help for usage.\n`)
    return 2
  }
  const o = args.values
  if (o.help) {
    write(HELP)
    return 0
  }

  const s = makeStyle(tty && !o['no-color'] && !env.NO_COLOR)
  const line = (mark, what, detail, note) =>
    write(`  ${mark} ${what.padEnd(13)} ${detail}${note ? `  ${s.dim(note)}` : ''}\n`)
  const ok = (what, detail, note) => line(s.green('✓'), what, detail, note)
  const skip = (what, detail) => line(s.dim('–'), what, s.dim(detail))
  let warnings = 0
  const warn = (what, detail, hint, note) => {
    warnings++
    line(s.yellow('!'), what, detail, note)
    if (hint) write(`    ${s.yellow('hint:')} ${hint}\n`)
  }
  const fail = (what, detail, hint) => {
    line(s.red('✗'), what, detail)
    if (hint) write(`    ${s.yellow('hint:')} ${hint}\n`)
    throw new Stop()
  }
  // A real call, timed. A failure prints the provider's whole error, then stops.
  // `hint` may be a function of the error, where the fix depends on it.
  const call = async (what, fn, hint) => {
    const t0 = performance.now()
    try {
      const value = await fn()
      return [value, `${Math.round(performance.now() - t0)} ms`]
    } catch (e) {
      fail(what, providerError(e, rpcUrl), typeof hint === 'function' ? hint(e) : hint)
    }
  }

  let rpcUrl
  write(`${s.bold('basewatch doctor')}\n\n`)
  try {
    // install
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const node = process.versions.node
    if (Number(node.split('.')[0]) < 20) fail('install', `Node.js ${node}`, 'basewatch needs Node.js 20 or newer')
    ok('install', `basewatch ${pkg.version} on Node.js ${node}`)
    ok('viem', createRequire(import.meta.url)('viem/package.json').version)

    // settings
    const net = o.testnet ? NETWORKS.testnet : NETWORKS.mainnet
    const other = o.testnet ? NETWORKS.mainnet : NETWORKS.testnet
    ok('network', `${net.name}, chain ${net.chain.id}`, o.testnet ? '[flag --testnet]' : '[default]')
    const [url, source] = rpcFrom(o, env, net)
    rpcUrl = url
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      fail('rpc', `not a URL (${url.length} characters)`, `${source} must be an https:// URL`)
    }
    if (!/^https?:$/.test(parsed.protocol)) fail('rpc', `${parsed.protocol} URL`, 'use an https:// RPC URL')
    // A path or query often holds an API key, so only the host is shown.
    const hidden = parsed.pathname.length > 1 || parsed.search ? s.dim(' (path hidden: it may hold a key)') : ''
    if (plainHttp(url)) warn('rpc', `${parsed.host}${hidden}, over plain http`, PLAIN_HTTP_RISK, source)
    else ok('rpc', `${parsed.host}${hidden}`, source)
    let explorer
    try {
      explorer = explorerFor(net, o.explorer)
    } catch (e) {
      fail('explorer', e.message)
    }
    ok('explorer', explorer, o.explorer ? '[flag --explorer]' : '[default]')
    let polling
    try {
      polling = timing(o)
    } catch (e) {
      fail('options', e.message)
    }

    // wallets, labeled and checked as a run would
    const specs = []
    for (const raw of args.positionals) {
      try {
        specs.push(parseSpec(raw))
      } catch (e) {
        fail('wallet', e.message)
      }
    }
    const labels = labelsFor(specs)
    const named = specs.map((spec, i) => checkWallet(spec, labels[i], { env, ok, skip, fail, s }))
    try {
      rejectRepeats(named)
    } catch (e) {
      fail('wallet', e.message, e.message.startsWith('label') ? 'give each wallet its own =label' : undefined)
    }
    // Run even with no new wallet, as a run does: --keychain needs macOS anyway.
    const fresh = named.filter((w) => w.isNew)
    const keyDir = keyDirFrom(o)
    try {
      checkKeyStores(fresh.map((w) => w.label), { keyDir, save: !o['no-save'], keychain: o.keychain, showKey: o['show-key'] })
    } catch (e) {
      fail(fresh.length ? 'new keys' : 'options', e.message)
    }
    if (fresh.length) {
      const stores = [!o['no-save'] && keyDir, o.keychain && 'the Keychain', o['show-key'] && 'the screen'].filter(Boolean)
      ok('new keys', `can be stored: ${stores.join(', ')}`)
    }
    if (!specs.length) skip('wallets', 'none named; name the ones you will watch to check them too')
    const wallets = named.filter((w) => w.address)

    // rpc: each a real call, in the order a run makes them
    const client = clientFor(net, rpcUrl)
    const [chainId, t1] = await call('chain id', () => client.getChainId(), `can't get an answer from ${parsed.host}; check the URL and your network`)
    if (chainId !== net.chain.id) {
      fail(
        'chain id',
        `${chainId}, but ${net.name} is ${net.chain.id}`,
        chainId === other.chain.id
          ? `that RPC serves ${other.name}; ${o.testnet ? 'drop --testnet' : 'add --testnet'}, or use another --rpc`
          : 'that RPC serves another chain; use a Base RPC with --rpc',
      )
    }
    ok('chain id', `${chainId} (${net.name})`, t1)

    const [head, t2] = await call('newest block', () => client.getBlock())
    const age = Math.max(0, Math.round(Date.now() / 1000 - Number(head.timestamp)))
    if (age > STALE_S) warn('newest block', `${num(head.number)}, ${age} s old`, `the RPC node is behind, so changes will show late; try another --rpc`)
    else ok('newest block', `${num(head.number)}, ${age} s old`, t2)

    const owners = wallets.length ? wallets.map((w) => w.address) : [PLACEHOLDER]
    const to = head.number - BigInt(polling.confirmations)
    const [logs, t3] = await call(
      'log query',
      () => fetchTransfers(client, [net.usdc], owners, to - LOG_RANGE + 1n, to),
      (e) =>
        e instanceof MalformedLog
          ? 'this RPC answered the log query, but with a log that has a missing or impossible field, ' +
            'so basewatch uses none of that answer; use another --rpc'
          : 'this RPC refuses or limits eth_getLogs, which basewatch needs to see x402 payments ' +
            '(the buyer never sends a transaction itself). mainnet.base.org is one such RPC. ' +
            `Use the default (${net.rpc}) or a provider that allows log queries, with --rpc`,
    )
    ok('log query', `USDC transfers over ${LOG_RANGE} blocks: ${logs.length}`, t3)

    const assets = assetsFor(net)
    const [balances, t4] = await call(
      'balances',
      () => readBalances(client, owners, assets, to),
      'this RPC cannot run the Multicall3 read basewatch uses for balances; use another --rpc',
    )
    ok('balances', wallets.length ? `read for ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}` : 'one batched read answered', t4)
    for (const w of wallets) {
      const b = balances.get(w.address)
      const shown = assets.map((a) => `${fmtAmount(b[a.symbol], a.decimals, a.places)} ${a.symbol}`).join(' · ')
      write(`  ${' '.repeat(15)} ${s.bold(w.label)}  ${shown}\n`)
    }
  } catch (e) {
    if (e instanceof Stop) return 1
    throw e
  }
  write(`\n${s.green('all checks passed')}${warnings ? s.yellow(`, ${warnings} warning${warnings === 1 ? '' : 's'}`) : ''}\n`)
  return 0
}

// One parsed wallet spec, resolved without creating or storing anything.
// Returns { label, address }, or { label, isNew } for a wallet not made yet.
function checkWallet(spec, label, { env, ok, skip, fail, s }) {
  if (spec.kind === 'new') {
    skip('wallet', `${label}: created when basewatch runs; doctor never creates wallets`)
    return { label, isNew: true }
  }
  if (spec.kind === 'address') {
    let address
    try {
      address = checkAddress(spec.address)
    } catch (e) {
      fail('wallet', e.message, 'copy the address again from the explorer')
    }
    label ??= shortAddr(address)
    ok('wallet', `${s.bold(label)}  ${address}`, '[address]')
    return { label, address }
  }
  // A key is reported by its length and the address it gives, never by its
  // characters: even a prefix of a private key is key material.
  let key
  let where
  if (spec.kind === 'env') {
    where = `$${spec.name}`
    key = env[spec.name]
    if (!key) fail('wallet', `${where} is not set`, `export ${spec.name}=… in this shell, then run basewatch from the same shell`)
  } else {
    where = `Keychain item "${spec.service}"`
    try {
      key = keychainRead(spec.service)
    } catch (e) {
      fail('wallet', e.message, `make one with: basewatch new=${spec.service} --keychain --create-only`)
    }
  }
  let address
  try {
    address = addressFromKey(key, where)
  } catch (e) {
    fail('wallet', `${e.message}; it holds ${key.trim().length} characters`, 'a private key is 64 hex characters, with or without 0x')
  }
  ok('wallet', `${s.bold(label)}  ${address}`, `[key from ${where}, ${key.trim().length} characters]`)
  return { label, address }
}
