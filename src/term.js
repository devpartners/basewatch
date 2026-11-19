// Terminal extras: inline images, the tab title, the iTerm2 badge, and opening
// a URL in the browser. All of it is decoration. A terminal that can't do one
// of these is simply never asked to.
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

const ESC = '\x1b'
const BEL = '\x07'

// The inline-image protocol the terminal speaks, judged from what it says
// about itself: 'iterm' (iTerm2, WezTerm), 'kitty' (kitty, Ghostty) or null.
// tmux and screen hide the real terminal, so they get null.
export function imageProtocol(env = process.env) {
  if (env.TMUX || /^(screen|tmux)/.test(env.TERM ?? '')) return null
  if (isITerm(env) || env.TERM_PROGRAM === 'WezTerm') return 'iterm'
  if (env.KITTY_WINDOW_ID || env.TERM === 'xterm-kitty' || env.TERM_PROGRAM === 'ghostty') return 'kitty'
  return null
}

export function isITerm(env = process.env) {
  return !env.TMUX && (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2')
}

// The logo as PNG bytes, or null if the file is missing.
export function logoPng(size) {
  try {
    return readFileSync(new URL(`../assets/logo-${size}.png`, import.meta.url))
  } catch {
    return null
  }
}

// A PNG drawn at the cursor, `rows` tall and at most `cols` wide. The cursor
// is left where it was.
export function inlineImage(protocol, png, { rows, cols }) {
  const data = png.toString('base64')
  if (protocol === 'iterm') {
    // The name is what iTerm2's "Allow Terminal-Initiated Display?" prompt shows.
    const name = Buffer.from('basewatch-logo.png').toString('base64')
    return `${ESC}7${ESC}]1337;File=name=${name};inline=1;size=${png.length};height=${rows};width=${cols};preserveAspectRatio=1:${data}${BEL}${ESC}8`
  }
  if (protocol === 'kitty') {
    // q=2 keeps kitty from answering on stdin; C=1 keeps the cursor still.
    const parts = data.match(/.{1,4096}/g)
    return parts
      .map((part, i) => {
        const head = i === 0 ? `a=T,f=100,q=2,C=1,r=${rows},` : ''
        return `${ESC}_G${head}m=${i < parts.length - 1 ? 1 : 0};${part}${ESC}\\`
      })
      .join('')
  }
  return ''
}

// Removes every image this program drew. iTerm2 images go when their cells
// are cleared, so only kitty needs telling.
export function clearImages(protocol) {
  return protocol === 'kitty' ? `${ESC}_Ga=d,d=A,q=2${ESC}\\` : ''
}

export const moveTo = (row, col) => `${ESC}[${row};${col}H`

// The tab title: saved on start, restored on exit.
export const title = {
  save: `${ESC}[22;0t`,
  set: (text) => `${ESC}]2;${String(text).replace(/[\x00-\x1f\x7f]/g, '')}${BEL}`,
  restore: `${ESC}[23;0t`,
}

// iTerm2's badge: large faint text in the corner of the session. '' removes it.
export function badge(text) {
  return `${ESC}]1337;SetBadgeFormat=${Buffer.from(text).toString('base64')}${BEL}`
}

// Opens `url` in the default browser without waiting for it.
export function openUrl(url, platform = process.platform) {
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    // Nothing to open it with; the link is still in the summary on quit.
  }
}

// An image on the next `rows` lines of a scrolling terminal, leaving the
// cursor on the line below it.
export function imageLines(protocol, png, { rows, cols }) {
  return `\r${'\n'.repeat(rows)}${ESC}[${rows}A${inlineImage(protocol, png, { rows, cols })}${ESC}[${rows}B`
}
