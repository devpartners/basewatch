// Turn command-line wallet specs into watched wallets, creating new ones and
// storing their keys where asked. Private keys are kept in memory only when
// --show-key asks for them to be displayed.
import { getAddress, isAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { shortAddr } from './format.js'

const LABEL = /^[A-Za-z0-9._-]{1,32}$/
const ADDRESS = /0x[0-9a-fA-F]{40}/

// "<source>[=label]" where source is 0xADDRESS, a URL containing one, new,
// env:VAR or keychain:SERVICE.
export function parseSpec(raw) {
  let source = raw
  let label
  const eq = raw.lastIndexOf('=')
  if (eq > 0 && LABEL.test(raw.slice(eq + 1))) {
    source = raw.slice(0, eq)
    label = raw.slice(eq + 1)
  } else if (eq > 0 && !/^https?:/.test(raw)) {
    throw new Error(`label in "${raw}" may use only letters, digits, ".", "_" and "-" (32 at most)`)
  }
  if (source === 'new') return { kind: 'new', label }
  if (source.startsWith('env:') && source.length > 4) {
    return { kind: 'env', name: source.slice(4), label: label ?? source.slice(4) }
  }
  if (source.startsWith('keychain:') && LABEL.test(source.slice(9))) {
    return { kind: 'keychain', service: source.slice(9), label: label ?? source.slice(9) }
  }
  const m = source.match(ADDRESS)
  if (m && (source === m[0] || /^https?:\/\//.test(source))) return { kind: 'address', address: m[0], label }
  throw new Error(
    `can't read wallet "${raw}": expected 0xADDRESS, a basescan URL, new, env:VAR or keychain:SERVICE, optionally followed by =label`,
  )
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

// Uses `security -i` so the key goes over stdin, not the process argument list.
export function keychainWrite(service, key) {
  const user = account()
  if (!/^[A-Za-z0-9._-]+$/.test(user)) throw new Error(`can't use account name "${user}" with the Keychain`)
  const exists = spawnSync('security', ['find-generic-password', '-a', user, '-s', service], { stdio: 'ignore' })
  if (exists.error) throw new Error(`couldn't run the macOS "security" tool: ${exists.error.message}`)
  if (exists.status === 0) {
    throw new Error(`the Keychain already has an item "${service}"; choose another label (new=<label>)`)
  }
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

function saveKeyFile(dir, label, address, key) {
  const d = resolve(dir)
  mkdirSync(d, { recursive: true, mode: 0o700 })
  const ignore = join(d, '.gitignore')
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n')
  const file = join(d, `${label}-${address.slice(0, 10)}.key`)
  try {
    writeFileSync(file, key + '\n', { mode: 0o600, flag: 'wx' })
  } catch (e) {
    throw new Error(e.code === 'EEXIST' ? `${file} already exists; choose another label` : `couldn't save the key: ${e.message}`)
  }
  const rel = relative(process.cwd(), file)
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel
}

export function resolveWallets(specs, { keyDir = '.wallets', save = true, keychain = false, showKey = false } = {}) {
  const parsed = specs.map(parseSpec)
  const fresh = parsed.filter((p) => p.kind === 'new')
  if (fresh.length && !save && !keychain && !showKey) {
    throw new Error("--no-save would keep the new wallet's private key nowhere; add --show-key or --keychain, or drop --no-save")
  }
  if (keychain && process.platform !== 'darwin') throw new Error('--keychain needs macOS')

  const unlabeledNew = fresh.filter((p) => !p.label).length
  let n = 0
  const wallets = parsed.map((p) => {
    switch (p.kind) {
      case 'address':
        return { origin: 'address', address: checkAddress(p.address), label: p.label }
      case 'env': {
        const v = process.env[p.name]
        if (!v) throw new Error(`$${p.name} is not set`)
        return { origin: 'env', envVar: p.name, address: addressFromKey(v, `$${p.name}`), label: p.label }
      }
      case 'keychain': {
        const address = addressFromKey(keychainRead(p.service), `Keychain item "${p.service}"`)
        return { origin: 'keychain', keychain: p.service, address, label: p.label }
      }
      default: {
        const key = generatePrivateKey()
        const label = p.label ?? (unlabeledNew > 1 ? `new${++n}` : 'new')
        return { origin: 'new', address: privateKeyToAccount(key).address, label, _key: key }
      }
    }
  })

  for (const w of wallets) w.label ??= shortAddr(w.address)
  const seen = new Map()
  for (const w of wallets) {
    for (const k of [w.address.toLowerCase(), 'label:' + w.label]) {
      if (seen.has(k)) throw new Error(`${k.startsWith('label:') ? `label "${w.label}"` : w.address} is listed twice`)
      seen.set(k, true)
    }
  }

  // Store keys only once every spec is known to be good.
  for (const w of wallets.filter((x) => x.origin === 'new')) {
    if (keychain) {
      keychainWrite(w.label, w._key)
      w.keychain = w.label
    }
    if (save) w.keyFile = saveKeyFile(keyDir, w.label, w.address, w._key)
    if (showKey) w.key = w._key
    delete w._key
  }
  return wallets
}
