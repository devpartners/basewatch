// Turn command-line wallet specs into watched wallets, creating new ones and
// storing their keys where asked. Private keys are kept in memory only when
// --show-key asks for them to be displayed.
import { getAddress, isAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { shortAddr } from './format.js'

const LABEL = /^[A-Za-z0-9._-]{1,32}$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
// An explorer's address page: /address/0x… with no more hex straight after it,
// so a transaction hash or a longer string is never cut down to an address.
const ADDRESS_PAGE = /\/address\/(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/
const URL_START = /^https?:/i

// "<source>[=label]" where source is 0xADDRESS, an explorer's /address/ URL,
// new, env:VAR or keychain:SERVICE.
export function parseSpec(raw) {
  let source = raw
  let label
  const url = URL_START.test(raw)
  const eq = raw.lastIndexOf('=')
  // In a URL, the "=" of "?tab=tokens" belongs to the URL; it is not a label.
  const inQuery = url && /[?&#][^?&#=/]*$/.test(raw.slice(0, eq))
  if (eq > 0 && !inQuery && LABEL.test(raw.slice(eq + 1))) {
    source = raw.slice(0, eq)
    label = raw.slice(eq + 1)
  } else if (eq > 0 && !url) {
    throw new Error(`label in "${raw}" may use only letters, digits, ".", "_" and "-" (32 at most)`)
  }
  if (source === 'new') return { kind: 'new', label }
  if (source.startsWith('env:') && source.length > 4) {
    return { kind: 'env', name: source.slice(4), label: label ?? source.slice(4) }
  }
  if (source.startsWith('keychain:') && LABEL.test(source.slice(9))) {
    return { kind: 'keychain', service: source.slice(9), label: label ?? source.slice(9) }
  }
  if (ADDRESS.test(source)) return { kind: 'address', address: source, label }
  if (url) {
    const page = source.match(ADDRESS_PAGE)
    if (page) return { kind: 'address', address: page[1], label }
    throw new Error(`"${raw}" isn't a wallet's address page; open the wallet on the explorer and copy its /address/ URL`)
  }
  throw new Error(
    `can't read wallet "${raw}": expected 0xADDRESS, an explorer's /address/ URL, new, env:VAR or keychain:SERVICE, optionally followed by =label`,
  )
}

// The label of each spec as a run names it, or undefined where the short
// address will do: a new wallet without one is "new", or new1, new2… when
// several are unlabeled.
export function labelsFor(parsed) {
  const unlabeled = parsed.filter((p) => p.kind === 'new' && !p.label).length
  let n = 0
  return parsed.map((p) => p.label ?? (p.kind !== 'new' ? undefined : unlabeled > 1 ? `new${++n}` : 'new'))
}

// Throws on the first address or label that is listed twice. A new wallet has
// no address until it is made, so only its label is compared.
export function rejectRepeats(wallets) {
  const seen = new Set()
  for (const w of wallets) {
    for (const k of [w.address && w.address.toLowerCase(), 'label:' + w.label]) {
      if (!k) continue
      if (seen.has(k)) throw new Error(`${k.startsWith('label:') ? `label "${w.label}"` : w.address} is listed twice`)
      seen.add(k)
    }
  }
}

export function checkAddress(a) {
  const mixed = a !== a.toLowerCase() && a !== '0x' + a.slice(2).toUpperCase()
  if (mixed && !isAddress(a)) throw new Error(`${a} fails its checksum; is there a typo?`)
  return getAddress(a)
}

export function addressFromKey(key, where) {
  let k = key.trim()
  if (!k.startsWith('0x')) k = '0x' + k
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${where} doesn't hold a private key (expected 64 hex characters)`)
  return privateKeyToAccount(k).address
}

function account() {
  return process.env.USER || userInfo().username
}

export function keychainRead(service) {
  const r = spawnSync('security', ['find-generic-password', '-a', account(), '-s', service, '-w'], { encoding: 'utf8' })
  if (r.error) throw new Error(`couldn't run the macOS "security" tool: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`no Keychain item "${service}" for account ${account()}`)
  return r.stdout.trim()
}

// Throws unless a new key could be stored as Keychain item `service`. Reads
// nothing secret: without -w, `security` doesn't print the password.
export function keychainCheck(service) {
  const user = account()
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`can't use account name "${user}" with the Keychain`)
  const exists = spawnSync('security', ['find-generic-password', '-a', user, '-s', service], { stdio: 'ignore' })
  if (exists.error) throw new Error(`couldn't run the macOS "security" tool: ${exists.error.message}`)
  if (exists.status === 0) {
    throw new Error(`the Keychain already has an item "${service}"; choose another label (new=<label>)`)
  }
  return user
}

// Uses `security -i` so the key goes over stdin, not the process argument list.
export function keychainWrite(service, key) {
  const user = keychainCheck(service)
  const r = spawnSync('security', ['-i'], {
    input: `add-generic-password -a ${user} -s ${service} -w ${key}\n`,
    encoding: 'utf8',
  })
  let stored = ''
  try {
    stored = keychainRead(service)
  } catch {}
  if (stored !== key) throw new Error(`couldn't store the key in the Keychain ${(r.stderr || '').trim()}`.trim())
}

// Keys go only in a folder that git is sure to ignore: one basewatch makes
// (with a "*" .gitignore), one that is empty, or one basewatch made before.
// Any other folder, such as a project's root, is refused rather than changed.
// Returns 'missing', 'empty' or 'ours'; reads only.
export function keyDirState(dir) {
  const d = resolve(dir)
  let st
  try {
    st = statSync(d)
  } catch (e) {
    if (e.code === 'ENOENT') return 'missing'
    throw new Error(`can't use --key-dir ${dir}: ${e.message}`)
  }
  if (!st.isDirectory()) throw new Error(`--key-dir ${dir} is a file, not a folder`)
  const entries = readdirSync(d)
  if (!entries.length) return 'empty'
  let ignore = null
  try {
    ignore = readFileSync(join(d, '.gitignore'), 'utf8')
  } catch {}
  if (ignore?.trim() === '*') return 'ours'
  throw new Error(
    `--key-dir ${dir} already holds other files, and git might not ignore keys saved there; name a new or empty folder (basewatch gives it its own .gitignore)`,
  )
}

function makeKeyDir(dir) {
  const d = resolve(dir)
  const state = keyDirState(dir)
  if (state === 'ours') return d
  if (state === 'missing') mkdirSync(d, { recursive: true, mode: 0o700 })
  chmodSync(d, 0o700)
  writeFileSync(join(d, '.gitignore'), '*\n')
  return d
}

function saveKeyFile(d, label, address, key) {
  const file = join(d, `${label}-${address.slice(0, 10)}.key`)
  try {
    writeFileSync(file, key + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    throw new Error(e.code === 'EEXIST' ? `${file} already exists; choose another label` : `couldn't save the key: ${e.message}`)
  }
  const rel = relative(process.cwd(), file)
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel
}

// Throws if new wallets with these labels couldn't have their keys stored as
// asked. Changes nothing, so doctor runs it too.
export function checkKeyStores(labels, { keyDir = '.wallets', save = true, keychain = false, showKey = false } = {}) {
  if (keychain && process.platform !== 'darwin') throw new Error('--keychain needs macOS')
  if (!labels.length) return
  if (!save && !keychain && !showKey) {
    throw new Error("--no-save would keep the new wallet's private key nowhere; add --show-key or --keychain, or drop --no-save")
  }
  if (keychain) for (const label of labels) keychainCheck(label)
  if (save) keyDirState(keyDir)
}

export function resolveWallets(specs, { keyDir = '.wallets', save = true, keychain = false, showKey = false } = {}) {
  const parsed = specs.map(parseSpec)
  const labels = labelsFor(parsed)
  const wallets = parsed.map((p, i) => {
    const label = labels[i]
    switch (p.kind) {
      case 'address':
        return { origin: 'address', address: checkAddress(p.address), label }
      case 'env': {
        const v = process.env[p.name]
        if (!v) throw new Error(`$${p.name} is not set`)
        return { origin: 'env', envVar: p.name, address: addressFromKey(v, `$${p.name}`), label }
      }
      case 'keychain': {
        const address = addressFromKey(keychainRead(p.service), `Keychain item "${p.service}"`)
        return { origin: 'keychain', keychain: p.service, address, label }
      }
      default:
        return { origin: 'new', label }
    }
  })
  for (const w of wallets) w.label ??= shortAddr(w.address)
  rejectRepeats(wallets)

  // Every check passes before any key is made or stored, so a refusal never
  // leaves a key behind.
  const fresh = wallets.filter((w) => w.origin === 'new')
  checkKeyStores(fresh.map((w) => w.label), { keyDir, save, keychain, showKey })
  const stored = []
  try {
    const dir = fresh.length && save ? makeKeyDir(keyDir) : null
    for (const w of fresh) {
      const key = generatePrivateKey()
      w.address = privateKeyToAccount(key).address
      if (keychain) {
        keychainWrite(w.label, key)
        w.keychain = w.label
        stored.push(`Keychain item "${w.label}"`)
      }
      if (dir) {
        w.keyFile = saveKeyFile(dir, w.label, w.address, key)
        stored.push(w.keyFile)
      }
      if (showKey) w.key = key
    }
  } catch (e) {
    if (!stored.length) throw e
    throw new Error(`${e.message}. Stored before that, for wallets never shown and so never funded: ${stored.join(', ')}; delete them before trying again`)
  }
  return wallets
}
