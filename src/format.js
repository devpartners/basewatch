// Terminal formatting helpers: colors, links, widths, amounts, sparklines.

export function makeStyle(on) {
  const wrap = (open, close) => (on ? (s) => `\x1b[${open}m${s}\x1b[${close}m` : (s) => String(s))
  return {
    on,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
    rgb: (r, g, b) => wrap(`38;2;${r};${g};${b}`, 39),
  }
}

// OSC 8 hyperlink: clickable in iTerm2, VS Code, Warp, kitty, WezTerm, etc.
export function link(url, text, on) {
  return on ? `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\` : text
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x1b]*\x1b\\/g

export function stripAnsi(s) {
  return s.replace(ANSI, '')
}

export function visibleLength(s) {
  return [...stripAnsi(s)].length
}

export function padEnd(s, width) {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)))
}

export function padStart(s, width) {
  return ' '.repeat(Math.max(0, width - visibleLength(s))) + s
}

// Cut a styled string to `width` visible characters without breaking escapes,
// marking the cut with …
export function truncate(s, width) {
  return visibleLength(s) <= width ? s : cut(s, width, true)
}

// The first `width` visible characters of a styled string, with no … mark.
export function sliceVisible(s, width) {
  return visibleLength(s) <= width ? s : cut(s, width, false)
}

function cut(s, width, ellipsis) {
  const sticky = new RegExp(ANSI.source, 'y')
  let out = ''
  let shown = 0
  let i = 0
  let inLink = false
  while (i < s.length) {
    sticky.lastIndex = i
    const m = sticky.exec(s)
    if (m) {
      out += m[0]
      if (m[0].startsWith('\x1b]8;;')) inLink = m[0] !== '\x1b]8;;\x1b\\'
      i += m[0].length
      continue
    }
    const ch = String.fromCodePoint(s.codePointAt(i))
    if (ellipsis && shown >= width - 1) {
      out += '…'
      break
    }
    if (shown >= width) break
    out += ch
    shown++
    i += ch.length
  }
  if (inLink) out += '\x1b]8;;\x1b\\'
  return out + '\x1b[0m'
}

// Exact fixed-point formatting of a bigint amount. Truncates to `places`
// decimals, but never shows a non-zero amount as zero.
export function fmtAmount(value, decimals, places, { sign = false } = {}) {
  const neg = value < 0n
  const abs = neg ? -value : value
  const base = 10n ** BigInt(decimals)
  const int = abs / base
  const frac = (abs % base).toString().padStart(decimals, '0')
  let shown = frac.slice(0, places)
  if (abs !== 0n && int === 0n && /^0*$/.test(shown)) shown = frac.replace(/0+$/, '')
  const body = shown.length ? `${int.toLocaleString('en-US')}.${shown}` : int.toLocaleString('en-US')
  return (neg ? '-' : sign && abs !== 0n ? '+' : '') + body
}

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values, max = 24) {
  const v = values.slice(-max)
  if (v.length < 2) return ''
  let lo = v[0]
  let hi = v[0]
  for (const x of v) {
    if (x < lo) lo = x
    if (x > hi) hi = x
  }
  if (hi === lo) return BARS[0].repeat(v.length)
  return v.map((x) => BARS[Number(((x - lo) * 7n) / (hi - lo))]).join('')
}

export function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function shortHash(h) {
  return `${h.slice(0, 6)}…${h.slice(-4)}`
}

export function clock(ms) {
  return new Date(ms).toTimeString().slice(0, 8)
}

export function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`
}

export function num(n) {
  return Number(n).toLocaleString('en-US')
}
