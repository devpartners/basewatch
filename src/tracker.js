// The history engine. Pure: no I/O, so it is unit-tested directly.
//
// Every balance change becomes a transition { from, to, delta }. Transfer logs
// are applied one at a time in chain order, so several payments in one block
// show as a chain of transitions (a → b → c) rather than one jump. After the
// logs, the balance read from the chain is the truth: any difference left over
// (ETH moves, or token moves without a Transfer event) becomes one more
// transition, so the history always ends at the real balance.

export class Tracker {
  constructor(wallets, assets) {
    this.assets = assets
    this.wallets = wallets.map((w) => ({
      ...w,
      balances: Object.fromEntries(assets.map((a) => [a.symbol, { start: null, current: null }])),
      transitions: [],
    }))
    this.byAddress = new Map(this.wallets.map((w) => [w.address.toLowerCase(), w]))
    this.byToken = new Map(assets.filter((a) => a.address).map((a) => [a.address.toLowerCase(), a]))
    this.seq = 0
    this.startBlock = null
    this.lastBlock = null
  }

  addresses() {
    return this.wallets.map((w) => w.address)
  }

  asset(symbol) {
    return this.assets.find((a) => a.symbol === symbol)
  }

  wallet(address) {
    return this.byAddress.get(address.toLowerCase())
  }

  baseline(balances, block, time = Date.now()) {
    for (const w of this.wallets) {
      for (const a of this.assets) {
        const v = balances.get(w.address)[a.symbol]
        w.balances[a.symbol] = { start: v, current: v }
      }
    }
    this.startBlock = block
    this.startTime = time
    this.lastBlock = block
  }

  // `logs`: Transfer logs for blocks (lastBlock, block], in chain order.
  // `balances`: balances as of `block`. Returns the new transitions.
  apply(logs, balances, block, now = Date.now()) {
    const fresh = []
    for (const log of logs) {
      const asset = this.byToken.get(log.token.toLowerCase())
      if (!asset || log.value === 0n || log.from.toLowerCase() === log.to.toLowerCase()) continue
      const sides = [
        [log.from, -log.value, log.to],
        [log.to, log.value, log.from],
      ]
      for (const [owner, delta, counterparty] of sides) {
        const w = this.wallet(owner)
        if (!w) continue
        const b = w.balances[asset.symbol]
        fresh.push(this.#record(w, asset, b.current + delta, now, {
          kind: 'transfer',
          block: log.block,
          tx: log.tx,
          counterparty,
          polledTo: block,
        }))
      }
    }
    for (const w of this.wallets) {
      for (const a of this.assets) {
        const actual = balances.get(w.address)[a.symbol]
        if (actual !== w.balances[a.symbol].current) {
          fresh.push(this.#record(w, a, actual, now, { kind: a.kind === 'native' ? 'balance' : 'unattributed', block, polledTo: block }))
        }
      }
    }
    this.lastBlock = block
    return fresh
  }

  // The change the `t` key opens: the newest, unless it has no transaction
  // hash (an ETH balance change, such as gas) and a change seen in the same
  // poll has one. Gas paid for a USDC payment then opens the payment, not a
  // block. Balance changes are dated to the end of the poll, after the
  // transfers in it, so block numbers alone can't make this choice.
  newestToOpen() {
    let newest = null
    for (const w of this.wallets) {
      const t = w.transitions.at(-1)
      if (t && (!newest || t.seq > newest.seq)) newest = t
    }
    if (!newest || newest.tx) return newest
    let best = null
    for (const w of this.wallets) {
      for (let i = w.transitions.length - 1; i >= 0 && w.transitions[i].polledTo === newest.polledTo; i--) {
        const t = w.transitions[i]
        if (t.tx && (!best || t.seq > best.seq)) best = t
      }
    }
    return best ?? newest
  }

  #record(w, asset, to, now, info) {
    const b = w.balances[asset.symbol]
    const t = { seq: ++this.seq, address: w.address, asset: asset.symbol, from: b.current, to, delta: to - b.current, seenAt: now, ...info }
    b.current = to
    w.transitions.push(t)
    return t
  }
}
