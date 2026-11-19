// Everything the user sees: the live screen, plain lines, JSON, summaries.
import { formatUnits } from 'viem'
import {
  fmtAmount, sparkline, visibleLength, truncate, sliceVisible, padEnd, padStart, link,
  clock, duration, num, shortAddr, shortHash,
} from './format.js'
import { rpcHost } from './chain.js'

const FRESH_MS = 8000
export const WAVE_MS = 900
const CREST = ['▁', '▂', '▄', '▆', '█', '▇', '▅', '▃', '▂']
const SEA = [
  [20, 70, 160], [30, 110, 200], [40, 150, 230], [120, 200, 255], [230, 245, 255],
  [120, 200, 255], [40, 150, 230], [30, 110, 200], [20, 70, 160],
]

// A row partway through washing in: its text up to the wave, then the wave.
export function washIn(style, row, progress) {
  const head = Math.floor(Math.max(0, progress) * (visibleLength(row) + CREST.length))
  const start = head - CREST.length
  let out = start > 0 ? sliceVisible(row, start) : ''
  for (let i = Math.max(0, -start); i < CREST.length; i++) out += style.rgb(...SEA[i])(CREST[i])
  return out
}

function host(url) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Connection status as a lifeguard flag. One failed call is retried quietly,
// so it shows yellow without the error; red means calls keep failing.
export function flag(ui) {
  const s = ui.style
  const st = ui.watcher.status
  if (!st.failures) return s.green('⚑ green flag · live')
  if (st.ok) return s.yellow('⚑ yellow flag · retrying')
  return s.red(`⚑ red flag · ${st.error}; retrying`)
}

function amount(ui, symbol, v, opts) {
  const a = ui.tracker.asset(symbol)
  return fmtAmount(v, a.decimals, a.places, opts)
}

function nameOf(ui, address) {
  const w = ui.tracker.wallet(address)
  return w ? ui.style.cyan(w.label) : shortAddr(address)
}

function origin(ui, w) {
  const s = ui.style
  if (w.origin === 'new') {
    const where = [w.keyFile && `key in ${w.keyFile}`, w.keychain && `key in Keychain "${w.keychain}"`].filter(Boolean)
    return s.yellow('new wallet') + (where.length ? s.dim(` · ${where.join(' · ')}`) : '')
  }
  if (w.origin === 'env') return s.dim(`key from $${w.envVar}`)
  if (w.origin === 'keychain') return s.dim(`key from Keychain "${w.keychain}"`)
  return ''
}

function txRef(ui, t, full = false) {
  const url = t.tx ? `${ui.explorer}/tx/${t.tx}` : `${ui.explorer}/block/${t.block}`
  if (full) return url
  return link(url, t.tx ? shortHash(t.tx) : `block ${num(t.block)}`, ui.links)
}

function who(ui, t) {
  const up = t.delta > 0n
  if (t.kind === 'transfer') return `${up ? 'from' : 'to'} ${nameOf(ui, t.counterparty)}`
  if (t.kind === 'balance') return ui.style.dim(up ? 'ETH received' : 'ETH sent / gas')
  return ui.style.dim('no Transfer event')
}

function trend(ui, a, b) {
  return b > a ? ui.style.green : b < a ? ui.style.red : (x) => x
}

// "2.201232 → 2.192232 → … → 2.181232": start, then every value it moved to,
// eliding the middle when the line is too narrow. Start and now always show.
function trail(ui, w, symbol, avail) {
  const s = ui.style
  const b = w.balances[symbol]
  const values = [b.start, ...w.transitions.filter((t) => t.asset === symbol).map((t) => t.to)].map((v) =>
    amount(ui, symbol, v),
  )
  const sep = ' → '
  const last = values.length - 1
  let keep = values.map((_, i) => i)
  if (values.reduce((n, v) => n + v.length, 0) + sep.length * last > avail) {
    keep = [last]
    let used = values[0].length + values[last].length + 1 + sep.length * 2
    for (let i = last - 1; i >= 1; i--) {
      if (used + values[i].length + sep.length > avail) break
      used += values[i].length + sep.length
      keep.unshift(i)
    }
    keep.unshift(0)
  }
  const now = s.bold(trend(ui, b.start, b.current)(values[last]))
  const parts = []
  keep.forEach((i, k) => {
    if (k > 0 && i !== keep[k - 1] + 1) parts.push(s.dim('…'))
    parts.push(i === last ? now : i === 0 ? s.dim(values[i]) : values[i])
  })
  return parts.join(s.dim(sep))
}

function assetLine(ui, w, symbol, width) {
  const s = ui.style
  const b = w.balances[symbol]
  const changes = w.transitions.filter((t) => t.asset === symbol)
  const head = `   ${s.bold(symbol.padEnd(4))}  `
  if (!changes.length) return `${head}${amount(ui, symbol, b.current)}   ${s.dim('no change')}`
  const color = trend(ui, b.start, b.current)
  const right = [
    color(sparkline([b.start, ...changes.map((t) => t.to)])),
    `net ${color(amount(ui, symbol, b.current - b.start, { sign: true }))}`,
    s.dim(`${changes.length} change${changes.length === 1 ? '' : 's'}`),
  ].join('  ')
  const left = head + trail(ui, w, symbol, width - visibleLength(head) - visibleLength(right) - 3)
  return left + ' '.repeat(Math.max(3, width - visibleLength(left) - visibleLength(right))) + right
}

// One row per transition, columns aligned so from ──▶ to reads at a glance.
function rows(ui, list, { now = Date.now(), highlight = true, fullUrls = false, waves = null } = {}) {
  const s = ui.style
  const cells = list.map((t) => ({
    t,
    from: amount(ui, t.asset, t.from),
    to: amount(ui, t.asset, t.to),
    delta: amount(ui, t.asset, t.delta, { sign: true }),
    who: who(ui, t),
  }))
  const width = (k) => Math.max(0, ...cells.map((c) => visibleLength(c[k])))
  const [wf, wt, wd, ww] = ['from', 'to', 'delta', 'who'].map(width)
  return cells.map(({ t, from, to, delta, who: w }) => {
    const c = t.delta > 0n ? s.green : s.red
    const fresh = highlight && now - t.seenAt < FRESH_MS
    const time = clock(t.time ?? t.seenAt)
    const row = [
      fresh ? s.bold(s.yellow(' ▶ ')) : '   ',
      fresh ? s.bold(s.yellow(time)) : s.dim(time),
      '  ', t.asset.padEnd(4), '  ',
      s.dim(padStart(from, wf)), ' ', c('──▶'), ' ', s.bold(padStart(to, wt)),
      '  ', c(padStart(delta, wd)),
      '  ', padEnd(w, ww),
      '  ', s.dim(txRef(ui, t, fullUrls)),
    ].join('')
    const since = waves?.get(t.seq)
    return since === undefined || now - since >= WAVE_MS ? row : washIn(s, row, (now - since) / WAVE_MS)
  })
}

// Split `budget` rows between wallets, giving spare rows to busier wallets.
function share(budget, need) {
  const alloc = need.map(() => 0)
  let left = budget
  let open = need.map((_, i) => i)
  while (left > 0 && open.length) {
    const each = Math.max(1, Math.floor(left / open.length))
    for (const i of open) {
      const give = Math.min(each, need[i] - alloc[i], left)
      alloc[i] += give
      left -= give
    }
    open = open.filter((i) => alloc[i] < need[i])
  }
  return alloc
}

// Keys and messages for the bottom line of the live screen.
function footer(ui, now) {
  const s = ui.style
  if (ui.flash && now < ui.flash.until) return s.yellow(` ${ui.flash.text}`)
  if (!ui.keys) return s.dim(' Ctrl-C quits and prints a summary')
  const n = Math.min(ui.tracker.wallets.length, 9)
  const open = n > 1 ? `1–${n} open a wallet` : '1 opens the wallet'
  return s.dim(` ${open} on ${host(ui.explorer)} · t opens the newest transaction · q quits and prints a summary`)
}

// The live screen, one string per row. `mark` ({ rows, cols }) keeps the
// top-left corner free for the logo: the header lines start past it.
export function renderFrame(ui, { width, height, now = Date.now(), mark = null }) {
  const s = ui.style
  const { tracker, watcher } = ui
  const W = Math.max(40, width - 1)
  const skip = mark ? `\x1b[${mark.cols}C` : ''
  const lines = [
    `${s.bold('basewatch')}  ${ui.net.name}  ${s.dim('block')} ${num(watcher.head ?? tracker.lastBlock)}  ${s.dim('up')} ${duration(now - ui.startedAt)}  ${flag(ui)}`,
    s.dim(`history since block ${num(tracker.startBlock)} (${clock(tracker.startTime)}) · ${rpcHost(ui.rpcUrl)}`),
    '',
  ].map((l) => skip + truncate(l, W - (mark ? mark.cols : 0)))
  const fixed = tracker.wallets.reduce((n, w) => n + 2 + (w.key ? 1 : 0) + tracker.assets.length, 0)
  const alloc = share(
    Math.max(0, height - lines.length - fixed - 1),
    tracker.wallets.map((w) => Math.max(1, w.transitions.length)),
  )

  tracker.wallets.forEach((w, i) => {
    const fresh = w.transitions.some((t) => now - t.seenAt < FRESH_MS)
    const label = fresh ? s.bold(s.yellow(w.label)) : s.bold(w.label)
    const key = ui.keys && i < 9 ? `${s.dim(String(i + 1))} ` : ''
    const title = ` ${key}${label}  ${link(`${ui.explorer}/address/${w.address}`, w.address, ui.links)}  ${origin(ui, w)} `
    lines.push(s.dim('━━') + title + s.dim('━'.repeat(Math.max(2, W - 2 - visibleLength(title)))))
    if (w.key) lines.push(`   ${s.yellow('private key')}  ${w.key}`)
    for (const a of tracker.assets) lines.push(assetLine(ui, w, a.symbol, W))
    const n = alloc[i]
    if (n > 0 && !w.transitions.length) lines.push(s.dim('   waiting for changes…'))
    else if (n > 0) {
      const hidden = w.transitions.length - n
      const opts = { now, waves: ui.waves }
      if (hidden > 0 && n >= 2) {
        lines.push(s.dim(`   ⋮ ${hidden + 1} earlier changes`))
        lines.push(...rows(ui, w.transitions.slice(-(n - 1)), opts))
      } else {
        lines.push(...rows(ui, w.transitions.slice(-n), opts))
      }
    }
    lines.push('')
  })
  const body = lines.slice(0, Math.max(0, height - 1)).map((l) => truncate(l, W))
  while (body.length < height - 1) body.push('')
  return [...body, truncate(footer(ui, now), W)]
}

export function renderPlainStart(ui) {
  const s = ui.style
  const t = ui.tracker
  const lw = Math.max(...t.wallets.map((w) => w.label.length))
  const out = [
    `${s.bold('basewatch')}  ${ui.net.name}  ${s.dim(`${rpcHost(ui.rpcUrl)} · history since block ${num(t.startBlock)} (${clock(t.startTime)})`)}`,
  ]
  for (const w of t.wallets) {
    const bal = t.assets.map((a) => `${a.symbol} ${amount(ui, a.symbol, w.balances[a.symbol].start)}`).join('  ')
    out.push(`  ${s.bold(padEnd(w.label, lw))}  ${w.address}  ${bal}  ${origin(ui, w)}`)
    if (w.key) out.push(`  ${' '.repeat(lw)}  ${s.yellow('private key')} ${w.key}`)
  }
  return out.join('\n')
}

export function renderPlainLine(ui, t) {
  const s = ui.style
  const lw = Math.max(...ui.tracker.wallets.map((w) => w.label.length))
  const c = t.delta > 0n ? s.green : s.red
  return [
    clock(t.time ?? t.seenAt),
    s.bold(padEnd(ui.tracker.wallet(t.address).label, lw)),
    t.asset.padEnd(4),
    `${s.dim(amount(ui, t.asset, t.from))} ${c('──▶')} ${s.bold(amount(ui, t.asset, t.to))}`,
    c(`(${amount(ui, t.asset, t.delta, { sign: true })})`),
    who(ui, t),
    s.dim(txRef(ui, t, true)),
  ].join('  ')
}

export function renderSummary(ui, { width = 120, now = Date.now(), maxRows = 50 } = {}) {
  const s = ui.style
  const t = ui.tracker
  const out = [
    `${s.bold('basewatch · end-of-shift summary')}  ${ui.net.name}  ${s.dim('ran')} ${duration(now - ui.startedAt)}  ${s.dim(`blocks ${num(t.startBlock)} → ${num(t.lastBlock)}`)}`,
  ]
  for (const w of t.wallets) {
    out.push('', `${s.bold(w.label)}  ${w.address}  ${origin(ui, w)}`)
    out.push(`   ${s.dim(`${ui.explorer}/address/${w.address}`)}`)
    if (w.key) out.push(`   ${s.yellow('private key')}  ${w.key}`)
    for (const a of t.assets) out.push(assetLine(ui, w, a.symbol, width))
    const list = w.transitions.slice(-maxRows)
    if (w.transitions.length > list.length) out.push(s.dim(`   ⋮ ${w.transitions.length - list.length} earlier changes not shown`))
    out.push(...rows(ui, list, { highlight: false, fullUrls: true }))
  }
  return out.join('\n') + '\n'
}

function keyVar(label) {
  return `${label.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PRIVATE_KEY`.replace(/^(\d)/, '_$1')
}

export function renderCreated(wallets, net, explorer, style) {
  const s = style
  const made = wallets.filter((w) => w.origin === 'new')
  const out = [`Created ${made.length} wallet${made.length === 1 ? '' : 's'} for ${net.name}:`]
  for (const w of made) {
    out.push('', `  ${s.bold(w.label)}  ${w.address}`, `      ${s.dim(`${explorer}/address/${w.address}`)}`)
    if (w.keyFile) {
      out.push(`      key file   ${w.keyFile}  ${s.dim('(readable only by you)')}`)
      out.push(`      use it     export ${keyVar(w.label)}=$(cat ${w.keyFile})`)
    }
    if (w.keychain) {
      out.push(`      Keychain   item "${w.keychain}", account $USER`)
      out.push(`      use it     export ${keyVar(w.label)}=$(security find-generic-password -a "$USER" -s ${w.keychain} -w)`)
    }
    if (w.key) out.push(`      ${s.yellow('private key')} ${w.key}`)
  }
  const specs = wallets.map((w) => (/^[A-Za-z0-9._-]+$/.test(w.label) ? `${w.address}=${w.label}` : w.address))
  out.push('', `Watch: basewatch ${specs.join(' ')}`)
  return out.join('\n') + '\n'
}

const units = (ui, symbol, v) => formatUnits(v, ui.tracker.asset(symbol).decimals)

export function startJSON(ui) {
  const t = ui.tracker
  return {
    type: 'start',
    network: ui.net.name,
    rpc: rpcHost(ui.rpcUrl),
    explorer: ui.explorer,
    block: Number(t.startBlock),
    time: new Date(t.startTime).toISOString(),
    wallets: t.wallets.map((w) => ({
      label: w.label,
      address: w.address,
      url: `${ui.explorer}/address/${w.address}`,
      origin: w.origin,
      ...(w.keyFile && { keyFile: w.keyFile }),
      ...(w.keychain && { keychain: w.keychain }),
      ...(w.key && { privateKey: w.key }),
      balances: Object.fromEntries(t.assets.map((a) => [a.symbol, units(ui, a.symbol, w.balances[a.symbol].start)])),
    })),
  }
}

export function changeJSON(ui, t) {
  const cp = t.counterparty && ui.tracker.wallet(t.counterparty)
  return {
    type: 'change',
    time: new Date(t.time ?? t.seenAt).toISOString(),
    block: Number(t.block),
    label: ui.tracker.wallet(t.address).label,
    wallet: t.address,
    asset: t.asset,
    from: units(ui, t.asset, t.from),
    to: units(ui, t.asset, t.to),
    delta: units(ui, t.asset, t.delta),
    kind: t.kind,
    counterparty: t.counterparty ?? null,
    counterpartyLabel: cp ? cp.label : null,
    tx: t.tx ?? null,
    url: txRef(ui, t, true),
  }
}

export function summaryJSON(ui) {
  const t = ui.tracker
  return {
    type: 'summary',
    fromBlock: Number(t.startBlock),
    toBlock: Number(t.lastBlock),
    wallets: t.wallets.map((w) => ({
      label: w.label,
      address: w.address,
      changes: w.transitions.length,
      assets: Object.fromEntries(
        t.assets.map((a) => {
          const b = w.balances[a.symbol]
          return [a.symbol, { start: units(ui, a.symbol, b.start), end: units(ui, a.symbol, b.current), net: units(ui, a.symbol, b.current - b.start) }]
        }),
      ),
    })),
  }
}
