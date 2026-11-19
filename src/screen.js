// The full-screen live view: alternate screen, keys, logo, tab title, waves.
import { renderFrame, renderSummary, WAVE_MS } from './render.js'
import { inlineImage, clearImages, moveTo, title, openUrl, logoPng } from './term.js'
import { visibleLength, shortHash, num } from './format.js'
import { rpcHost } from './chain.js'

const SPLASH_MIN_MS = 1200 // long enough to see, even when the RPC answers at once
const MARK = { rows: 3, cols: 8 } // header logo: 3 rows tall; header text starts after 8 columns
const FLASH_MS = 3000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const host = (url) => new URL(url).host

export class Screen {
  // `protocol`: inline-image protocol, or null for no images.
  constructor(ui, { protocol = null, wave = true, bell = false } = {}) {
    this.ui = ui
    this.out = process.stdout
    this.keys = process.stdin.isTTY ? process.stdin : null
    this.protocol = protocol
    this.bell = bell
    this.splashPng = protocol && logoPng(768)
    this.markPng = protocol && logoPng(256)
    this.quit = () => {
      this.close()
      process.exit(0)
    }
    ui.keys = Boolean(this.keys)
    ui.waves = wave ? new Map() : null
  }

  // Takes over the terminal and shows the splash while basewatch connects.
  open() {
    const { out } = this
    this.opened = true
    process.on('exit', () => this.close())
    process.on('uncaughtException', (e) => {
      this.close()
      process.stderr.write(`${e.stack || e}\n`)
      process.exit(1)
    })
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => this.quit())
    out.on('error', (e) => (e.code === 'EPIPE' ? process.exit(0) : this.quit()))
    // Raw mode keeps typed keys from echoing over the screen.
    if (this.keys) {
      this.keys.setRawMode(true)
      this.keys.resume()
      this.keys.on('data', (b) => this.key(b.toString('utf8')))
    }
    this.titled = this.titleText()
    out.write(title.save + title.set(this.titled) + '\x1b[?1049h\x1b[?25l')
    this.splash()
  }

  // Gives the terminal back: images, cursor, main screen, tab title.
  close() {
    if (!this.opened || this.closed) return
    this.closed = true
    if (this.keys) this.keys.setRawMode(false)
    this.out.write(clearImages(this.protocol) + '\x1b[?25h\x1b[?1049l' + title.restore)
  }

  splash() {
    const { out, ui } = this
    const s = ui.style
    const rows = out.rows || 30
    const cols = out.columns || 100
    const n = ui.tracker.wallets.length
    const text = [
      s.bold('basewatch'),
      s.dim(`connecting to ${rpcHost(ui.rpcUrl)} · ${n} wallet${n === 1 ? '' : 's'}`),
    ]
    const size = Math.min(16, rows - 6, Math.floor((cols - 4) / 2))
    const image = this.splashPng && size >= 6
    const top = Math.max(1, Math.floor((rows - (image ? size + 1 : 0) - text.length) / 2) + 1)
    let frame = '\x1b[2J'
    if (image) {
      frame += moveTo(top, Math.max(1, Math.floor((cols - size * 2) / 2) + 1))
      frame += inlineImage(this.protocol, this.splashPng, { rows: size, cols: size * 2 })
      this.splashedAt = Date.now()
    }
    text.forEach((line, i) => {
      const row = top + (image ? size + 1 : 0) + i
      frame += moveTo(row, Math.max(1, Math.floor((cols - visibleLength(line)) / 2) + 1)) + line
    })
    out.write(frame)
  }

  // Starts the live view once the watcher has its baseline.
  async run() {
    const { out, ui } = this
    if (this.splashedAt) await sleep(SPLASH_MIN_MS - (Date.now() - this.splashedAt))
    if (this.closed) return
    this.running = true
    this.quit = () => this.finish()
    this.repaint()
    ui.watcher.on('change', (fresh) => {
      if (this.bell) out.write('\x07')
      if (ui.waves) {
        const now = Date.now()
        for (const t of fresh) ui.waves.set(t.seq, now)
        this.animate()
      }
      this.draw()
    })
    ui.watcher.on('status', () => {
      this.retitle()
      this.draw()
    })
    out.on('resize', () => this.repaint())
    this.timer = setInterval(() => this.draw(), 1000)
  }

  // Clears the screen and redraws everything, logo included.
  repaint() {
    const wide = (this.out.columns || 100) >= 60
    this.mark = this.markPng && wide ? MARK : null
    let frame = clearImages(this.protocol) + '\x1b[2J'
    if (this.mark) frame += moveTo(1, 1) + inlineImage(this.protocol, this.markPng, { rows: MARK.rows, cols: MARK.cols - 2 })
    this.out.write(frame)
    this.draw()
  }

  draw() {
    if (!this.running || this.closed) return
    const { out } = this
    const lines = renderFrame(this.ui, { width: out.columns || 100, height: out.rows || 30, mark: this.mark })
    out.write(`\x1b[H${lines.join('\x1b[K\n')}\x1b[K\x1b[J`)
  }

  // Redraws quickly while any wave is still rolling in.
  animate() {
    if (this.anim) return
    this.anim = setInterval(() => {
      const now = Date.now()
      for (const [seq, at] of this.ui.waves) if (now - at >= WAVE_MS) this.ui.waves.delete(seq)
      this.draw()
      if (!this.ui.waves.size) {
        clearInterval(this.anim)
        this.anim = null
      }
    }, 40)
  }

  titleText() {
    const st = this.ui.watcher.status
    const names = this.ui.tracker.wallets.map((w) => w.label).join(', ')
    const text = `${st.ok ? '🛟' : '🚩'} basewatch · ${names}`
    return text.length > 60 ? `${text.slice(0, 59)}…` : text
  }

  retitle() {
    const text = this.titleText()
    if (text !== this.titled) this.out.write(title.set((this.titled = text)))
  }

  key(str) {
    if (str.startsWith('\x1b')) return // arrow keys and terminal replies
    for (const ch of str) {
      if (ch === '\x03' || ch === '\x04' || ch === 'q' || ch === 'Q') return this.quit()
      if (!this.running) continue
      if (ch >= '1' && ch <= '9') this.openWallet(Number(ch) - 1)
      else if (ch === 't' || ch === 'T') this.openNewest()
    }
  }

  say(text) {
    this.ui.flash = { text, until: Date.now() + FLASH_MS }
    this.draw()
  }

  openWallet(i) {
    const w = this.ui.tracker.wallets[i]
    if (!w) return
    openUrl(`${this.ui.explorer}/address/${w.address}`)
    this.say(`↗ opening ${w.label} on ${host(this.ui.explorer)}`)
  }

  openNewest() {
    const newest = this.ui.tracker.newestToOpen()
    if (!newest) return this.say('no changes yet, so no transaction to open')
    const { explorer } = this.ui
    openUrl(newest.tx ? `${explorer}/tx/${newest.tx}` : `${explorer}/block/${newest.block}`)
    const what = newest.tx ? `transaction ${shortHash(newest.tx)}` : `block ${num(newest.block)}`
    this.say(`↗ opening ${what} on ${host(explorer)}`)
  }

  finish() {
    if (this.done) return
    this.done = true
    clearInterval(this.timer)
    clearInterval(this.anim)
    this.ui.watcher.stop()
    this.close()
    this.out.write(renderSummary(this.ui, { width: this.out.columns || 120 }))
    process.exit(0)
  }
}
