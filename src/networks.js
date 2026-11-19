import { base, baseSepolia } from 'viem/chains'

// eth_getLogs is refused by mainnet.base.org ("request limit reached"), so the
// defaults are publicnode endpoints, which answer filtered log queries.
export const NETWORKS = {
  mainnet: {
    name: 'Base mainnet',
    chain: base,
    rpc: 'https://base-rpc.publicnode.com',
    explorer: 'https://basescan.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  testnet: {
    name: 'Base Sepolia',
    chain: baseSepolia,
    rpc: 'https://base-sepolia-rpc.publicnode.com',
    explorer: 'https://sepolia.basescan.org',
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
