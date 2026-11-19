// Polls for new blocks and feeds each block range to the tracker.
import { EventEmitter } from 'node:events'
import { readBalances, fetchTransfers, errorText } from './chain.js'

export class Watcher extends EventEmitter {
  constructor({ client, tracker, rpcUrl, confirmations = 2, intervalMs = 1000, maxRange = 100 }) {
    super()
    Object.assign(this, { client, tracker, rpcUrl, confirmations: BigInt(confirmations), intervalMs, maxRange: BigInt(maxRange) })
    this.tokens = tracker.assets.filter((a) => a.kind === 'erc20').map((a) => a.address)
    this.head = null
    this.status = { ok: true, error: null, failures: 0 }
    this.stopped = false
  }

  async start() {
    const head = await this.client.getBlockNumber()
    const at = head - this.confirmations
    const [balances, block] = await Promise.all([
      readBalances(this.client, this.tracker.addresses(), this.tracker.assets, at),
      this.client.getBlock({ blockNumber: at }),
    ])
    this.tracker.baseline(balances, at, Number(block.timestamp) * 1000)
    this.head = head
    this.#schedule()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.#flush()
  }

  // Announces changes that are in the history but not yet announced, so a
  // stop while block times are being fetched never leaves the summary
  // counting changes that no line showed.
  #flush() {
    const fresh = this.pending
    this.pending = null
    if (fresh?.length) this.emit('change', fresh)
  }

  #schedule(delay = this.intervalMs) {
    if (!this.stopped) this.timer = setTimeout(() => this.#tick(), delay)
  }

  async #tick() {
    try {
      this.head = await this.client.getBlockNumber()
      const target = this.head - this.confirmations
      while (!this.stopped && this.tracker.lastBlock < target) {
        const from = this.tracker.lastBlock + 1n
        const to = target < from + this.maxRange - 1n ? target : from + this.maxRange - 1n
        const owners = this.tracker.addresses()
        const [logs, balances] = await Promise.all([
          fetchTransfers(this.client, this.tokens, owners, from, to),
          readBalances(this.client, owners, this.tracker.assets, to),
        ])
        if (this.stopped) return
        const fresh = this.tracker.apply(logs, balances, to)
        if (fresh.length) {
          this.pending = fresh
          await this.#stamp(fresh)
          this.#flush()
        }
      }
      this.status = { ok: true, error: null, failures: 0 }
      this.emit('status', this.status)
      this.#schedule()
    } catch (e) {
      // One failure is usually a load-balanced node a block behind; retry
      // quietly and only report trouble when it repeats.
      const failures = this.status.failures + 1
      this.status = { ok: failures < 2, error: errorText(e, this.rpcUrl), failures }
      this.emit('status', this.status)
      this.#schedule(Math.min(this.intervalMs * 2 ** (failures - 1), 15_000))
    }
  }

  // Use block timestamps, so a catch-up after a stall shows true times.
  async #stamp(transitions) {
    const blocks = [...new Set(transitions.map((t) => t.block))]
    try {
      const got = await Promise.all(blocks.map((b) => this.client.getBlock({ blockNumber: b })))
      const at = new Map(got.map((b) => [b.number, Number(b.timestamp) * 1000]))
      for (const t of transitions) t.time = at.get(t.block)
    } catch {
      // Fall back to the time the change was seen.
    }
  }
}
