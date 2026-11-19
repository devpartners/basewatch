import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Watcher } from '../src/watcher.js'
import { Tracker } from '../src/tracker.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const BUYER = '0x1111111111111111111111111111111111111111'
const OTHER = '0x3333333333333333333333333333333333333333'
const assets = [
  { symbol: 'USDC', kind: 'erc20', address: USDC, decimals: 6, places: 6 },
  { symbol: 'ETH', kind: 'native', decimals: 18, places: 8 },
]

test('stopping while block times are fetched still announces the changes already recorded', async () => {
  const tracker = new Tracker([{ address: BUYER, label: 'buyer' }], assets)
  let head = 105n
  let stamping
  const stamped = new Promise((r) => (stamping = r))
  const client = {
    getBlockNumber: async () => head++,
    // The baseline's block answers; the block-time lookup for a change never does.
    getBlock: ({ blockNumber }) => (blockNumber === 103n ? Promise.resolve({ number: 103n, timestamp: 1n }) : (stamping(), new Promise(() => {}))),
    multicall: async ({ blockNumber }) => (blockNumber === 103n ? [5_000n, 0n] : [4_000n, 0n]),
    getLogs: async ({ args }) =>
      args.from
        ? [{ blockNumber: 104n, logIndex: 0, transactionHash: '0x' + 'cd'.repeat(32), address: USDC, args: { from: BUYER, to: OTHER, value: 1_000n } }]
        : [],
  }
  const watcher = new Watcher({ client, tracker, rpcUrl: 'https://rpc.example.test', intervalMs: 1 })
  const announced = []
  watcher.on('change', (fresh) => announced.push(...fresh))
  await watcher.start()
  await stamped
  assert.equal(tracker.wallet(BUYER).transitions.length, 1, 'recorded, waiting for its block time')
  assert.equal(announced.length, 0)
  watcher.stop()
  assert.equal(announced.length, 1, 'announced on stop, with the time it was seen')
  assert.equal(announced[0].delta, -1_000n)
})
