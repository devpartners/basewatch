import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Tracker } from '../src/tracker.js'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const assets = [
  { symbol: 'USDC', kind: 'erc20', address: USDC, decimals: 6, places: 6 },
  { symbol: 'ETH', kind: 'native', decimals: 18, places: 8 },
]
const BUYER = '0x1111111111111111111111111111111111111111'
const SELLER = '0x2222222222222222222222222222222222222222'
const OTHER = '0x3333333333333333333333333333333333333333'

function setup(buyer = { USDC: 2_201_232n, ETH: 0n }, seller = { USDC: 0n, ETH: 5n }) {
  const t = new Tracker([{ address: BUYER, label: 'buyer' }, { address: SELLER, label: 'seller' }], assets)
  t.baseline(new Map([[BUYER, buyer], [SELLER, seller]]), 100n, 0)
  return t
}

const transfer = (block, logIndex, from, to, value, tx = `0x${block}${logIndex}`) => ({
  block, logIndex, tx, token: USDC.toLowerCase(), from, to, value,
})

test('several payments in one block become a chain of from → to steps', () => {
  const t = setup()
  const fresh = t.apply(
    [transfer(101n, 1, BUYER, OTHER, 9_000n), transfer(101n, 7, BUYER, SELLER, 1_000n)],
    new Map([[BUYER, { USDC: 2_191_232n, ETH: 0n }], [SELLER, { USDC: 1_000n, ETH: 5n }]]),
    101n,
  )
  const buyer = t.wallet(BUYER)
  assert.deepEqual(
    buyer.transitions.map((x) => [x.from, x.to, x.delta]),
    [[2_201_232n, 2_192_232n, -9_000n], [2_192_232n, 2_191_232n, -1_000n]],
  )
  assert.equal(buyer.transitions[1].counterparty, SELLER)
  assert.equal(buyer.balances.USDC.current, 2_191_232n)
  // A payment between two watched wallets shows on both.
  const seller = t.wallet(SELLER)
  assert.deepEqual(seller.transitions.map((x) => [x.from, x.to, x.counterparty]), [[0n, 1_000n, BUYER]])
  assert.equal(fresh.length, 3)
  // No leftover: the logs explain the whole balance change.
  assert.ok(fresh.every((x) => x.kind === 'transfer'))
})

test('the history always ends at the balance read from the chain', () => {
  const t = setup()
  const fresh = t.apply([], new Map([[BUYER, { USDC: 2_000_000n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 5n }]]), 101n)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0].kind, 'unattributed')
  assert.equal(fresh[0].from, 2_201_232n)
  assert.equal(fresh[0].to, 2_000_000n)
  assert.equal(t.wallet(BUYER).balances.USDC.current, 2_000_000n)
})

test('ETH changes come from balance reads', () => {
  const t = setup()
  t.apply([], new Map([[BUYER, { USDC: 2_201_232n, ETH: 10n ** 15n }], [SELLER, { USDC: 0n, ETH: 4n }]]), 101n)
  const [b] = t.wallet(BUYER).transitions
  assert.deepEqual([b.asset, b.kind, b.from, b.to], ['ETH', 'balance', 0n, 10n ** 15n])
  const [s] = t.wallet(SELLER).transitions
  assert.equal(s.delta, -1n)
})

test('transitions accumulate across blocks and the start stays fixed', () => {
  const t = setup()
  t.apply([transfer(101n, 0, OTHER, BUYER, 500n)], new Map([[BUYER, { USDC: 2_201_732n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 5n }]]), 101n)
  t.apply([transfer(103n, 0, BUYER, OTHER, 732n)], new Map([[BUYER, { USDC: 2_201_000n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 5n }]]), 103n)
  const b = t.wallet(BUYER)
  assert.deepEqual(b.transitions.map((x) => x.to), [2_201_732n, 2_201_000n])
  assert.equal(b.balances.USDC.start, 2_201_232n)
  assert.equal(t.lastBlock, 103n)
})

test('self-transfers, zero transfers and other tokens are ignored', () => {
  const t = setup()
  const same = new Map([[BUYER, { USDC: 2_201_232n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 5n }]])
  const fresh = t.apply(
    [
      transfer(101n, 0, BUYER, BUYER, 5n),
      transfer(101n, 1, BUYER, OTHER, 0n),
      { ...transfer(101n, 2, BUYER, OTHER, 5n), token: OTHER },
    ],
    same,
    101n,
  )
  assert.equal(fresh.length, 0)
})

test('addresses match regardless of letter case', () => {
  const t = setup()
  t.apply([transfer(101n, 0, BUYER.toUpperCase().replace('0X', '0x'), OTHER, 1n)],
    new Map([[BUYER, { USDC: 2_201_231n, ETH: 0n }], [SELLER, { USDC: 0n, ETH: 5n }]]), 101n)
  assert.equal(t.wallet(BUYER).transitions[0].kind, 'transfer')
})
