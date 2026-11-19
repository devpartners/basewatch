// RPC access: balances via one multicall, USDC movements via Transfer logs.
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const multicallAbi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)'])
const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
const TX_HASH = /^0x[0-9a-fA-F]{64}$/

export function makeClient(net, rpcUrl, { retryCount = 2 } = {}) {
  return createPublicClient({
    chain: net.chain,
    cacheTime: 0,
    transport: http(rpcUrl, { retryCount, timeout: 10_000 }),
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
    unique.set(`${l.transactionHash}:${l.logIndex}`, {
      block: l.blockNumber,
      logIndex: l.logIndex,
      // Shown, linked and opened, so only a well-formed hash is kept; without
      // one, the change links to its block instead.
      tx: TX_HASH.test(l.transactionHash) ? l.transactionHash : undefined,
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

// Keep API keys that some RPC URLs carry out of the screen and logs.
export function rpcHost(url) {
  try {
    return new URL(url).host
  } catch {
    return 'rpc'
  }
}

// The parts of an RPC URL that may be an API key, longest first: the login,
// path segments and query values long enough to be one.
function urlSecrets(rpcUrl) {
  let u
  try {
    u = new URL(rpcUrl)
  } catch {
    return []
  }
  const found = new Set()
  for (const part of [u.username, u.password, ...u.pathname.split('/'), ...u.searchParams.values()]) {
    if (!part) continue
    found.add(part)
    try {
      found.add(decodeURIComponent(part))
    } catch {}
  }
  return [...found].filter((p) => p.length >= 8).sort((a, b) => b.length - a.length)
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

// The whole error, provider text and underlying cause included, on one line.
export function providerError(e, rpcUrl) {
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
  return cleanText(String(e?.shortMessage || e?.message || e).split('\n')[0], rpcUrl)
}
