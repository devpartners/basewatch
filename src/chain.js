// RPC access: balances via one multicall, USDC movements via Transfer logs.
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const multicallAbi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)'])
const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const isAddress = (v) => typeof v === 'string' && ADDRESS.test(v)

export function makeClient(net, rpcUrl, { retryCount = 2 } = {}) {
  return createPublicClient({
    chain: net.chain,
    cacheTime: 0,
    // viem follows offchain lookups (CCIP-Read, EIP-3668) unless told not to:
    // an RPC could answer a balance read with a list of URLs, and viem would
    // request each one from this machine. Nothing basewatch reads needs one.
    ccipRead: false,
    // A redirect is the same reach by another route: followed, it sends the
    // request, and for a 307 or 308 its body too, to whatever host the RPC names.
    transport: http(rpcUrl, { retryCount, timeout: 10_000, fetchOptions: { redirect: 'error' } }),
  })
}

// Map<address, { [symbol]: bigint }> as of `blockNumber`.
export async function readBalances(client, addresses, assets, blockNumber) {
  const contracts = []
  for (const owner of addresses) {
    for (const a of assets) {
      contracts.push(
        a.kind === 'native'
          ? { address: MULTICALL3, abi: multicallAbi, functionName: 'getEthBalance', args: [owner] }
          : { address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] },
      )
    }
  }
  const results = await client.multicall({ contracts, blockNumber, allowFailure: false })
  const out = new Map()
  let i = 0
  for (const owner of addresses) {
    const row = {}
    for (const a of assets) row[a.symbol] = results[i++]
    out.set(owner, row)
  }
  return out
}

// Transfer logs of `tokens` sent from or to any of `owners`, in chain order.
// An x402 payment is sent by the facilitator, not the payer, so logs (not the
// payer's own transactions) are what reveal it.
export async function fetchTransfers(client, tokens, owners, fromBlock, toBlock) {
  const q = (args) => client.getLogs({ address: tokens, event: transferEvent, args, fromBlock, toBlock })
  const [sent, received] = await Promise.all([q({ from: owners }), q({ to: owners })])
  const unique = new Map()
  for (const l of [...sent, ...received]) {
    // The history is built from these fields, and the counterparty is shown.
    // An RPC's reply can carry `args` of its own, which viem keeps in place of
    // the ones it decoded, so they are checked here, before any is recorded.
    if (!wellFormed(l, fromBlock, toBlock)) throw new Error('the RPC sent a Transfer log that is not well formed')
    unique.set(`${l.transactionHash}:${l.logIndex}`, {
      block: l.blockNumber,
      logIndex: l.logIndex,
      // Shown, linked and opened, so only a well-formed hash is kept; without
      // one, the change links to its block instead.
      tx: typeof l.transactionHash === 'string' && TX_HASH.test(l.transactionHash) ? l.transactionHash : undefined,
      token: l.address,
      from: l.args.from,
      to: l.args.to,
      value: l.args.value,
    })
  }
  return [...unique.values()].sort((a, b) =>
    a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1,
  )
}

// The block must be one that was asked for, and the index a whole number,
// since the two put the logs in chain order.
function wellFormed(l, fromBlock, toBlock) {
  return (
    typeof l?.blockNumber === 'bigint' &&
    l.blockNumber >= fromBlock &&
    l.blockNumber <= toBlock &&
    Number.isInteger(l.logIndex) &&
    l.logIndex >= 0 &&
    isAddress(l.address) &&
    isAddress(l.args?.from) &&
    isAddress(l.args?.to) &&
    typeof l.args.value === 'bigint'
  )
}

// Keep API keys that some RPC URLs carry out of the screen and logs.
export function rpcHost(url) {
  try {
    return new URL(url).host
  } catch {
    return 'rpc'
  }
}

// True for an RPC URL that is plain http to another machine: anyone on the
// network between can read and change what it answers. A node on this machine
// (anvil, a local Base node) is reached without leaving it, so it doesn't count.
// Only names sure to mean this machine are let through: "anvil.localhost" is
// not, since the system's resolver decides where that goes.
export function plainHttp(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  const host = u.hostname.replace(/\.$/, '')
  return !(host === 'localhost' || /^127(\.\d+){3}$/.test(host) || host === '[::1]')
}

// What a run and doctor say about such a URL.
export const PLAIN_HTTP_RISK =
  'anyone on the network between can read and change its answers; use an https:// RPC unless you trust that network'

// The host as the screen shows it, marked when it is reached over plain http.
export function rpcShown(url) {
  return plainHttp(url) ? `${rpcHost(url)} (plain http)` : rpcHost(url)
}

// The parts of an RPC URL that may be an API key, longest first, each as
// written, percent-decoded and with "+" read as a space: the login from 3
// characters, and the path segments, query values and bare query keys from
// 8. Shorter path and query parts ("v2", "base") are too often ordinary words
// to blank out of every message, and providers don't issue keys that short.
function urlSecrets(rpcUrl) {
  let u
  try {
    u = new URL(rpcUrl)
  } catch {
    return []
  }
  const found = new Set()
  const add = (part, min) => {
    for (const form of [part, decoded(part), decoded(part.replace(/\+/g, ' '))]) {
      if (form && form.length >= min) found.add(form)
    }
  }
  add(u.username, 3)
  add(u.password, 3)
  for (const segment of u.pathname.split('/')) add(segment, 8)
  for (const pair of u.search.slice(1).split('&')) {
    const eq = pair.indexOf('=')
    add(eq < 0 ? pair : pair.slice(eq + 1), 8)
  }
  return [...found].sort((a, b) => b.length - a.length)
}

function decoded(part) {
  try {
    return decodeURIComponent(part)
  } catch {
    return null
  }
}

// Text from an RPC, made safe to print: control characters, which could clear
// the screen or fake a line, become spaces; the RPC URL is cut down to its
// host; and any piece of the URL that may be an API key becomes "…", even
// where the provider quotes it back on its own.
export function cleanText(text, rpcUrl) {
  let out = String(text ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
  if (!rpcUrl) return out
  out = out.split(rpcUrl).join(rpcHost(rpcUrl))
  for (const secret of urlSecrets(rpcUrl)) out = out.split(secret).join('…')
  return out
}

// makeClient refuses redirects, and fetch then fails with these words, which
// viem wraps in "HTTP request failed". Said plainly instead, since the fix is
// the person's to make: give the address the RPC has moved to.
const REDIRECTED = 'the RPC answered with a redirect, which basewatch does not follow'

// Only fetch's own error objects count. An RPC's reply can carry the same
// words in its JSON, but parsed JSON is never a TypeError holding an Error.
function refusedRedirect(e) {
  for (let c = e, depth = 0; c && depth < 8; c = c.cause, depth++) {
    if (c instanceof TypeError && c.cause instanceof Error && c.cause.message === 'unexpected redirect') return true
  }
  return false
}

// The whole error, provider text and underlying cause included, on one line.
export function providerError(e, rpcUrl) {
  if (refusedRedirect(e)) return REDIRECTED
  const parts = []
  const add = (t) => {
    const text = String(t ?? '').replace(/\s+/g, ' ').trim()
    if (text && !parts.some((p) => p.includes(text))) parts.push(text)
  }
  add(e?.shortMessage || e?.message || e)
  for (let c = e; c; c = c.cause) add(c.details ?? (c === e ? '' : c.message))
  return cleanText(parts.join(' — '), rpcUrl)
}

export function errorText(e, rpcUrl) {
  if (refusedRedirect(e)) return REDIRECTED
  return cleanText(String(e?.shortMessage || e?.message || e).split('\n')[0], rpcUrl)
}
