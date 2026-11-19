// RPC access: balances via one multicall, USDC movements via Transfer logs.
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem'

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const multicallAbi = parseAbi(['function getEthBalance(address addr) view returns (uint256 balance)'])
const erc20Abi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')

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
      tx: l.transactionHash,
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

// The whole error, provider text and underlying cause included, on one line,
// with the RPC URL (and any API key in it) cut down to its host.
export function providerError(e, rpcUrl) {
  const parts = []
  const add = (t) => {
    const text = String(t ?? '').replace(/\s+/g, ' ').trim()
    if (text && !parts.some((p) => p.includes(text))) parts.push(text)
  }
  add(e?.shortMessage || e?.message || e)
  for (let c = e; c; c = c.cause) add(c.details ?? (c === e ? '' : c.message))
  const text = parts.join(' — ')
  return rpcUrl ? text.split(rpcUrl).join(rpcHost(rpcUrl)) : text
}

export function errorText(e, rpcUrl) {
  const msg = String(e?.shortMessage || e?.message || e).split('\n')[0]
  return rpcUrl ? msg.split(rpcUrl).join(rpcHost(rpcUrl)) : msg
}
