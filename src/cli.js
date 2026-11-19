import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { NETWORKS, assetsFor } from './networks.js'
import { resolveWallets } from './wallets.js'
import { makeClient, errorText, rpcHost } from './chain.js'
import { Tracker } from './tracker.js'
import { Watcher } from './watcher.js'
import { makeStyle } from './format.js'
import {
  renderFrame, renderPlainStart, renderPlainLine, renderSummary, renderCreated,
  startJSON, changeJSON, summaryJSON,
} from './render.js'

const HELP = `basewatch: watch Base wallets live and show every balance change since it started

Usage
  basewatch [options] <wallet>...

Wallets (any of them may end with =label)
  0xADDRESS            an existing wallet (a basescan.org/address/... URL works too)
  new                  a brand-new wallet, created now and tracked from zero
  env:VAR              the wallet whose private key is in $VAR (the key is never shown)
  keychain:SERVICE     the wallet whose private key is in macOS Keychain item SERVICE

Examples
  basewatch 0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E=buyer
  basewatch new=buyer 0x1234...=seller
  basewatch env:X402_BUYER_PRIVATE_KEY=buyer keychain:x402-seller=seller
  basewatch new=x402-buyer --keychain --create-only

Network
  --testnet            Base Sepolia instead of Base mainnet
  --rpc URL            JSON-RPC endpoint (default: publicnode; or set BASE_RPC_URL)
  --interval MS        how often to look for new blocks (default 1000)
  --confirmations N    stay N blocks behind the newest block (default 2; a Base
                       block is 0.2 s, and this keeps lagging RPC nodes from erroring)

Output
  (default)            full-screen live view when run in a terminal
  --plain              one line per change, append-only (recordings, tee, piping)
  --json               one JSON object per line
  --bell               ring the terminal bell on each change
  --no-color           no colors (NO_COLOR is honoured too)
  --no-links           no clickable links

New wallets
  --key-dir DIR        where new keys are saved (default ./.wallets, files are mode 600)
  --keychain           also store each new key in the macOS Keychain, item named by its label
  --show-key           show new private keys on screen
  --no-save            don't write key files (needs --show-key or --keychain)
  --create-only        create the wallets, print how to use them, and exit

  -h, --help           show this help
  -v, --version        show the version
`

function fail(message, code = 1) {
  process.stderr.write(`basewatch: ${message}\n`)
  process.exit(code)
}

function intOption(value, fallback, name, min) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be a whole number of at least ${min}`, 2)
  return n
}

export async function main(argv) {
  let args
  try {
    args = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        testnet: { type: 'boolean' },
        rpc: { type: 'string' },
        interval: { type: 'string' },
        confirmations: { type: 'string' },
        plain: { type: 'boolean' },
        json: { type: 'boolean' },
        bell: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        'no-links': { type: 'boolean' },
        'key-dir': { type: 'string' },
        keychain: { type: 'boolean' },
        'show-key': { type: 'boolean' },
        'no-save': { type: 'boolean' },
        'create-only': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    })
  } catch (e) {
    fail(`${e.message}\nRun basewatch --help for usage.`, 2)
  }
  const o = args.values
  if (o.help) return void process.stdout.write(HELP)
  if (o.version) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return void process.stdout.write(`${pkg.version}\n`)
  }
  if (!args.positionals.length) {
    process.stderr.write(HELP)
    process.exit(2)
  }

  const net = o.testnet ? NETWORKS.testnet : NETWORKS.mainnet
  const rpcUrl = o.rpc ?? process.env.BASE_RPC_URL ?? net.rpc
  const intervalMs = intOption(o.interval, 1000, 'interval', 250)
  const confirmations = intOption(o.confirmations, 2, 'confirmations', 0)
  const tty = Boolean(process.stdout.isTTY)
  const mode = o.json ? 'json' : o.plain || !tty ? 'plain' : 'tui'
  const style = makeStyle(tty && mode !== 'json' && !o['no-color'] && !process.env.NO_COLOR)

  let wallets
  try {
    wallets = resolveWallets(args.positionals, {
      keyDir: o['key-dir'] ?? '.wallets',
      save: !o['no-save'],
      keychain: o.keychain,
      showKey: o['show-key'],
    })
  } catch (e) {
    fail(e.message, 2)
  }

  if (o['create-only']) return void process.stdout.write(renderCreated(wallets, net, style))

  const assets = assetsFor(net)
  const client = makeClient(net, rpcUrl)
  const tracker = new Tracker(wallets, assets)
  const watcher = new Watcher({ client, tracker, rpcUrl, confirmations, intervalMs })
  const ui = { net, rpcUrl, tracker, watcher, style, links: tty && mode !== 'json' && !o['no-links'], startedAt: Date.now() }

  try {
    await watcher.start()
  } catch (e) {
    // A new wallet's key is already saved, so say where before giving up.
    if (wallets.some((w) => w.origin === 'new')) process.stderr.write(renderCreated(wallets, net, style))
    fail(`couldn't read from ${rpcHost(rpcUrl)}: ${errorText(e, rpcUrl)}`)
  }

  if (mode === 'tui') runScreen(ui, o.bell)
  else if (mode === 'plain') runPlain(ui, o.bell)
  else runJSON(ui)
}

function onExit(cleanup) {
  let done = false
  const finish = () => {
    if (done) return
    done = true
    cleanup()
    process.exit(0)
  }
  process.on('SIGINT', finish)
  process.on('SIGTERM', finish)
  process.on('SIGHUP', finish)
  // A closed pipe (e.g. `| head`) ends the run quietly.
  process.stdout.on('error', (e) => (e.code === 'EPIPE' ? process.exit(0) : finish()))
  return finish
}

function runScreen(ui, bell) {
  const out = process.stdout
  const keys = process.stdin.isTTY ? process.stdin : null
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    if (keys) keys.setRawMode(false)
    out.write('\x1b[?25h\x1b[?1049l')
  }
  process.on('exit', restore)
  process.on('uncaughtException', (e) => {
    restore()
    process.stderr.write(`${e.stack || e}\n`)
    process.exit(1)
  })

  out.write('\x1b[?1049h\x1b[?25l')
  const draw = () => {
    const lines = renderFrame(ui, { width: out.columns || 100, height: out.rows || 30 })
    out.write(`\x1b[H${lines.join('\x1b[K\n')}\x1b[K\x1b[J`)
  }
  ui.watcher.on('change', () => {
    if (bell) out.write('\x07')
    draw()
  })
  ui.watcher.on('status', draw)
  out.on('resize', draw)
  const timer = setInterval(draw, 1000)
  draw()

  const finish = onExit(() => {
    clearInterval(timer)
    ui.watcher.stop()
    restore()
    out.write(renderSummary(ui, { width: out.columns || 120 }))
  })
  // Raw mode keeps typed keys from echoing over the screen; q or Ctrl-C quits.
  if (keys) {
    keys.setRawMode(true)
    keys.resume()
    keys.on('data', (b) => {
      if (b.includes(3) || b.includes(4) || b.includes(113) || b.includes(81)) finish()
    })
  }
}

function runPlain(ui, bell) {
  const out = process.stdout
  out.write(renderPlainStart(ui) + '\n')
  ui.watcher.on('change', (fresh) => {
    for (const t of fresh) out.write(renderPlainLine(ui, t) + '\n')
    if (bell) out.write('\x07')
  })
  let failing = false
  ui.watcher.on('status', (st) => {
    if (!st.ok && !failing) process.stderr.write(`basewatch: ${st.error}; retrying\n`)
    else if (st.ok && failing) process.stderr.write('basewatch: reconnected\n')
    failing = !st.ok
  })
  onExit(() => {
    ui.watcher.stop()
    out.write('\n' + renderSummary(ui, { width: out.columns || 120 }))
  })
}

function runJSON(ui) {
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  emit(startJSON(ui))
  ui.watcher.on('change', (fresh) => fresh.forEach((t) => emit(changeJSON(ui, t))))
  ui.watcher.on('status', (st) => !st.ok && emit({ type: 'error', message: st.error }))
  onExit(() => {
    ui.watcher.stop()
    emit(summaryJSON(ui))
  })
}
