// What a run and doctor share: the options, and how the settings that come
// from them are read. doctor takes every run option, so a run's command line
// can be checked as it is.

export const RUN_OPTIONS = {
  testnet: { type: 'boolean' },
  rpc: { type: 'string' },
  interval: { type: 'string' },
  confirmations: { type: 'string' },
  plain: { type: 'boolean' },
  json: { type: 'boolean' },
  explorer: { type: 'string' },
  bell: { type: 'boolean' },
  'no-wave': { type: 'boolean' },
  'no-logo': { type: 'boolean' },
  'no-color': { type: 'boolean' },
  'no-links': { type: 'boolean' },
  'key-dir': { type: 'string' },
  keychain: { type: 'boolean' },
  'show-key': { type: 'boolean' },
  'no-save': { type: 'boolean' },
  'create-only': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

// A whole-number option, or `fallback` when it isn't given.
export function wholeNumber(value, fallback, name, min) {
  if (value === undefined) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be a whole number of at least ${min}`)
  return n
}

export function timing(o) {
  return {
    intervalMs: wholeNumber(o.interval, 1000, 'interval', 250),
    confirmations: wholeNumber(o.confirmations, 2, 'confirmations', 0),
  }
}

// [url, where it came from]. An empty --rpc or BASE_RPC_URL counts as unset:
// passed on, viem would quietly use mainnet.base.org, which refuses the log
// queries basewatch depends on.
export function rpcFrom(o, env, net) {
  if (o.rpc) return [o.rpc, '[flag --rpc]']
  if (env.BASE_RPC_URL) return [env.BASE_RPC_URL, '[env BASE_RPC_URL]']
  return [net.rpc, '[default]']
}
