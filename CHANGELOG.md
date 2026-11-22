# Changelog

Notable changes to basewatch, newest first. Versions follow
[Semantic Versioning](https://semver.org).

## 0.1.0 - 2026-11-22

First release.

- **Live view:** every USDC and ETH balance change of the wallets you name,
  from the moment basewatch starts. Each change shows as from ──▶ to, with the
  other party, a sparkline and the net change. Quitting prints a summary with
  explorer links.
- **`basewatch doctor`:** checks the install, the settings, the wallets and the
  RPC calls a run makes, stops at the first failure and says what to fix. It
  changes nothing.
- **Wallets:** an address or an explorer URL, `new` for a wallet created on the
  spot, `env:VAR` or `keychain:SERVICE` for one whose key you hold. Each can
  take a `=label`.
- **Output:** the full-screen view, `--plain` for one line per change, or
  `--json` for one object per line.
- **Networks:** Base mainnet, or Base Sepolia with `--testnet`, over any
  JSON-RPC endpoint given with `--rpc` or `BASE_RPC_URL`.
- **Private keys:** new keys are saved with mode 600 in a folder of their own,
  or kept in the macOS Keychain. Keys you bring are used only to work out the
  address, and are never shown, logged or kept.
- **Untrusted RPC:** text from the RPC is stripped of control characters, and
  an RPC URL's path and keys are never shown. Redirects are refused, offchain
  lookups are off, and a malformed `Transfer` log is an error. A plain
  `http://` RPC on another machine gets a warning.
