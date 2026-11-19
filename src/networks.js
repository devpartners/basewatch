import { base, baseSepolia } from 'viem/chains'

// eth_getLogs is refused by mainnet.base.org ("request limit reached"), so the
// defaults are publicnode endpoints, which answer filtered log queries.
export const NETWORKS = {
  mainnet: {
    key: 'mainnet',
    name: 'Base mainnet',
    chain: base,
    rpc: 'https://base-rpc.publicnode.com',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  testnet: {
    key: 'testnet',
    name: 'Base Sepolia',
    chain: baseSepolia,
    rpc: 'https://base-sepolia-rpc.publicnode.com',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
}

// `places` is how many decimals the screen shows; values are kept exact.
export function assetsFor(net) {
  return [
    { symbol: 'USDC', kind: 'erc20', address: net.usdc, decimals: 6, places: 6 },
    { symbol: 'ETH', kind: 'native', decimals: 18, places: 8 },
  ]
}

// Block explorers by name. Each serves /address/<a>, /tx/<hash> and /block/<n>.
export const EXPLORERS = {
  basescan: { mainnet: 'https://basescan.org', testnet: 'https://sepolia.basescan.org' },
  blockscout: { mainnet: 'https://base.blockscout.com', testnet: 'https://base-sepolia.blockscout.com' },
}

// `choice` is an EXPLORERS name or the base URL of any explorer with the same paths.
export function explorerFor(net, choice = 'basescan') {
  if (Object.hasOwn(EXPLORERS, choice)) return EXPLORERS[choice][net.key]
  let url
  try {
    url = new URL(choice)
  } catch {
    throw new Error(`--explorer must be ${Object.keys(EXPLORERS).join(' or ')}, or an https:// URL`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('--explorer URL must start with https://')
  return url.href.replace(/\/+$/, '')
}
