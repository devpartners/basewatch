# basewatch
Real-time wallet watcher for the Base blockchain. Built to be useful for live demos as alternative to drowning in block explorers.

<p align="center">
  <img src="docs/images/basewatch-logo-512.png" width="256"
       alt="BaseWatch logo: binoculars below a lifeguard tower, one lens showing a wallet and the other a blockchain, against a beach sunset">
</p>

`basewatch` shows every USDC and ETH balance change of the wallets you name,
from the moment it starts. Each change is shown as **from ──▶ to**, so a run of
payments reads as a chain. It's built for live demos, such as x402 payments:
start it, make some payments, and the audience watches the balances move.

```text
basewatch  Base mainnet  block 59,297,849  up 00:04:12  ● live
history since block 59,296,614 (19:54:58) · base-rpc.publicnode.com · q or Ctrl-C quits and prints a summary

━━ buyer  0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E  key from $X402_BUYER_PRIVATE_KEY ━━━━━━━━━━━━━━━━━━━━
   USDC  2.202000 → 2.201000 → 2.200000 → 2.190000           █▇▆▁  net -0.012000  3 changes
   ETH   0.00000000   no change
   19:55:10  USDC  2.202000 ──▶ 2.201000  -0.001000  to seller       0x9f3a…c1d0
   19:55:31  USDC  2.201000 ──▶ 2.200000  -0.001000  to seller       0x41bd…77e2
 ▶ 19:56:02  USDC  2.200000 ──▶ 2.190000  -0.010000  to 0x7c21…a9f3  0x0d3e…9b12

━━ seller  0x1234…  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   USDC  0.000000 → 0.001000 → 0.002000                       ▁█  net +0.002000  2 changes
   ...
```

- The **balance line** shows the starting value, every value it moved to, and
  where it is now, with a sparkline and the net change since start.
- Each **row** is one change: the time, the value before and after, the
  difference, and the other party. A payment between two watched wallets shows
  on both, under their labels.
- **New changes** are marked with a yellow ▶ for 8 seconds. Add `--bell` to
  ring the terminal bell as well.
- Transaction hashes are **clickable links** to basescan in terminals that
  support links (iTerm2, VS Code, Warp, kitty, WezTerm).
- When you quit, a **summary** with the full history and full basescan links is
  printed, so it stays in your scrollback.

## Install

Needs Node.js 20 or newer.

```sh
npm install
npm link        # puts `basewatch` on your PATH; or run ./bin/basewatch.js
```

## Usage

```sh
basewatch [options] <wallet>...
```

Each wallet can end with `=label`:

| Wallet              | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `0xADDRESS`         | an existing wallet (a `basescan.org/address/…` URL works too)        |
| `new`               | a brand-new wallet, created now and tracked from zero                |
| `env:VAR`           | the wallet whose private key is in `$VAR`; the key is never shown    |
| `keychain:SERVICE`  | the wallet whose private key is in macOS Keychain item `SERVICE`     |

### Demo recipes

Watch an x402 buyer whose key you already exported, plus the seller:

```sh
basewatch env:X402_BUYER_PRIVATE_KEY=buyer 0xSELLER…=seller
```

Make a fresh buyer wallet before the demo and keep its key in the Keychain:

```sh
basewatch new=x402-buyer --keychain --create-only
export X402_BUYER_PRIVATE_KEY=$(security find-generic-password -a "$USER" -s x402-buyer -w)
basewatch keychain:x402-buyer=buyer 0xSELLER…=seller
```

Create a wallet and watch it from zero in one step:

```sh
basewatch new=buyer            # key saved to ./.wallets/buyer-0x….key
basewatch new=buyer --show-key # also shows the private key on screen
```

Record or share the output instead of using the full-screen view:

```sh
basewatch --plain 0xebDb…=buyer | tee demo.log
basewatch --json  0xebDb…=buyer > demo.ndjson
```

### Options

| Option              | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `--testnet`         | Base Sepolia instead of Base mainnet                                    |
| `--rpc URL`         | JSON-RPC endpoint (or set `BASE_RPC_URL`); only its host is ever shown  |
| `--interval MS`     | how often to look for new blocks (default 1000)                         |
| `--confirmations N` | stay N blocks behind the newest (default 2, which is 0.4 s on Base)     |
| `--plain`           | one line per change, append-only; the default when output isn't a terminal |
| `--json`            | one JSON object per line: `start`, `change`, `error`, `summary`         |
| `--bell`            | ring the terminal bell on each change                                   |
| `--no-color`        | no colors (`NO_COLOR` works too)                                        |
| `--no-links`        | no clickable links                                                      |
| `--key-dir DIR`     | where new keys are saved (default `./.wallets`)                         |
| `--keychain`        | also store each new key in the macOS Keychain, under its label          |
| `--show-key`        | show new private keys on screen                                         |
| `--no-save`         | don't write key files (needs `--show-key` or `--keychain`)              |
| `--create-only`     | create the wallets, print how to use them, and exit                     |

## Private keys

- A new wallet's key is saved by default. Money sent to a wallet whose key was
  never kept is lost for good, so `--no-save` is refused unless `--show-key` or
  `--keychain` keeps the key somewhere else.
- Key files are created with mode 600 in a directory with mode 700. That
  directory gets its own `.gitignore` (`*`), so the keys can't be committed
  from any repository.
- An existing key file is never overwritten. The Keychain item for a new
  wallet must not already exist either.
- Keys reach the Keychain through `security -i` on stdin, not on the command
  line, so they don't show up in `ps`.
- Keys from `env:` and `keychain:` are only used to work out the address. They
  are never shown, logged or kept.

## How it works

- Every `--interval` it asks for the newest block. For each new range of
  blocks it makes two calls:
  - **USDC `Transfer` logs** sent from or to any watched wallet.
  - **One multicall** reading every wallet's USDC and ETH balance at the end of
    the range.
- The logs are applied one at a time in chain order. Several payments in one
  block therefore show as a chain of steps instead of one jump.
- The balances read from the chain are the truth. If anything is left
  unexplained, such as an ETH move or a token move without a `Transfer` event,
  it becomes one more step. So the history always ends at the real balance.
- Logs matter for x402 because the buyer never sends a transaction itself. The
  buyer signs an EIP-3009 authorization, and the facilitator submits it. The
  buyer's nonce and ETH balance never change; only the USDC `Transfer` log
  shows the payment.
- The default RPC is publicnode. `mainnet.base.org` refuses `eth_getLogs`
  ("request limit reached").
- Base produces a block every 0.2 s, so each poll covers several blocks.
- A single failed RPC call is retried quietly. An error shows only when calls
  keep failing.

## Development

```sh
npm test
```

The history engine (`src/tracker.js`) is pure and unit-tested. The live
behaviour has been checked against Base mainnet: on a busy Uniswap pool, every
step's from equals the previous step's to, and the last to equals the balance
read from the chain.
