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
basewatch  Base mainnet  ⚑ green flag · live  block 59,297,849  up 00:04:12
history since block 59,296,614 (19:54:58) · base-rpc.publicnode.com

━━ 1 buyer  0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E  key from $X402_BUYER_PRIVATE_KEY ━━━━━━━━━━━━━━━━━━
   USDC  2.202000 → 2.201000 → 2.200000 → 2.190000           █▇▆▁  net -0.012000  3 changes
   ETH   0.00000000   no change
   19:55:10  USDC  2.202000 ──▶ 2.201000  -0.001000  to seller       0x9f3a…c1d0
   19:55:31  USDC  2.201000 ──▶ 2.200000  -0.001000  to seller       0x41bd…77e2
 ▶ 19:56:02  USDC  2.200000 ──▶ 2.190000  -0.010000  to 0x7c21…a9f3  0x0d3e…9b12

━━ 2 seller  0x1234…  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   USDC  0.000000 → 0.001000 → 0.002000                       ▁█  net +0.002000  2 changes
   ...

 1–2: wallet on basescan.org · t: newest tx · q: quit
```

- The **balance line** shows the starting value, every value it moved to, and
  where it is now, with a sparkline and the net change since start.
- Each **row** is one change: the time, the value before and after, the
  difference, and the other party. A payment between two watched wallets shows
  on both, under their labels.
- **New changes** wash in on a small wave, then stay marked with a yellow ▶
  for 8 seconds. Add `--bell` to ring the terminal bell as well, or
  `--no-wave` to skip the wave.
- **Explorer pages are a keypress away**, so no URLs clutter the screen. Press
  a wallet's number to open it on basescan, or `t` to open the newest
  transaction. Addresses and transaction hashes are also clickable links in
  terminals that support them (iTerm2, VS Code, Warp, kitty, WezTerm).
- **The connection is a lifeguard flag**: green when live, yellow while one
  failed call is retried, red with the error when calls keep failing.
- When you quit, an **end-of-shift summary** with each wallet's history (its
  last 50 changes) and full explorer links for every wallet and transaction is
  printed, so it stays in your scrollback.

## Install

Needs Node.js 20 or newer.

```sh
npm install
npm link            # puts `basewatch` on your PATH; or run ./bin/basewatch.js
basewatch doctor    # checks it can run here, and says what to fix if not
```

## Before a demo: `basewatch doctor`

Give `doctor` the same wallets and options you will watch with. It checks each
link in the chain basewatch needs and stops at the first broken one, so the
last line is the thing to fix:

```text
basewatch doctor

  ✓ install       basewatch 0.1.0 on Node.js 24.20.0
  ✓ viem          2.57.16
  ✓ network       Base mainnet, chain 8453  [default]
  ✓ rpc           mainnet.base.org  [flag --rpc]
  ✓ explorer      https://basescan.org  [default]
  ✓ wallet        buyer  0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E  [key from $X402_BUYER_PRIVATE_KEY, 66 characters]
  ✓ chain id      8453 (Base mainnet)  134 ms
  ✓ newest block  59,575,147, 0 s old  77 ms
  ✗ log query     RPC Request failed. — request limit reached
    hint: this RPC refuses or limits eth_getLogs, which basewatch needs to see x402 payments ...
```

- Every setting shows where its value came from: a flag, an environment
  variable, or the default.
- The RPC checks are real calls, timed: chain ID, newest block, the same USDC
  log query a run makes, and a balance read. A wrong network names the flag to
  change. A provider's error is printed whole.
- A key is shown only as the address it gives and its length. An RPC URL's path
  is hidden, since it may hold an API key.
- It changes nothing: `new` wallets are skipped, not created.
- The exit code is 0 when no check failed, 1 when one did.

## Usage

```sh
basewatch [options] <wallet>...
basewatch doctor [options] [<wallet>...]
```

Each wallet can end with `=label`:

| Wallet              | Meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `0xADDRESS`         | an existing wallet (an explorer's `/address/…` URL works too)        |
| `new`               | a brand-new wallet, created now and tracked from zero                |
| `env:VAR`           | the wallet whose private key is in `$VAR`; the key is never shown    |
| `keychain:SERVICE`  | the wallet whose private key is in macOS Keychain item `SERVICE`     |

### Example

Watch two wallets by address, labeled so the view names them. Both are real
wallets on Base mainnet, so this runs as is:

```sh
basewatch 0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E=buyer \
          0x9b98695Fc3a1616edE9605416B7D2bB90Fec0ace=seller
```

Put `doctor` in front of the same wallets to check them before you start.

### Demo recipes

Watch an x402 buyer whose key you already exported, plus the seller:

```sh
basewatch env:X402_BUYER_PRIVATE_KEY=buyer 0xSELLER…=seller
```

Make a fresh buyer wallet before the demo and keep its key only in the
Keychain, with no key file on disk:

```sh
basewatch new=x402-buyer --keychain --no-save --create-only
export X402_BUYER_PRIVATE_KEY=$(security find-generic-password -a "$USER" -s x402-buyer -w)
basewatch keychain:x402-buyer=buyer 0xSELLER…=seller
```

Or keep it in the Keychain and in a key file in `./.wallets` as a backup (drop
`--no-save`):

```sh
basewatch new=x402-buyer --keychain --create-only
```

Create a wallet and watch it from zero in one step:

```sh
basewatch new=buyer            # key saved to ./.wallets/buyer-0x….key
basewatch new=buyer --show-key # also shows the private key on screen
```

Record or share the output instead of using the full-screen view. `tee -i`
keeps writing when you press Ctrl-C, so the summary reaches the log too:

```sh
basewatch --plain 0xebDb…=buyer | tee -i demo.log
basewatch --json  0xebDb…=buyer > demo.ndjson
```

### Keys

In the full-screen view:

| Key         | Effect                                           |
| ----------- | ------------------------------------------------ |
| `1`–`9`     | open that wallet on the explorer                 |
| `t`         | open the newest transaction on the explorer      |
| `q`, Ctrl-C | quit and print the end-of-shift summary          |

### Options

| Option              | Effect                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| `--testnet`         | Base Sepolia instead of Base mainnet                                    |
| `--rpc URL`         | JSON-RPC endpoint (or set `BASE_RPC_URL`); only its host is ever shown  |
| `--interval MS`     | how often to look for new blocks (default 1000)                         |
| `--confirmations N` | stay N blocks behind the newest (default 2, which is 0.4 s on Base)     |
| `--plain`           | one line per change, append-only; the default when output isn't a terminal |
| `--json`            | one JSON object per line: `start`, `change`, `error`, `summary`         |
| `--explorer NAME`   | where links and keys open: `basescan` (default), `blockscout`, or the base URL of another explorer. A name switches to its Sepolia site under `--testnet`; a URL is used as given, so pass the testnet explorer's URL there |
| `--bell`            | ring the terminal bell on each change                                   |
| `--no-wave`         | show new changes without the wave                                       |
| `--no-logo`         | no logo or splash                                                       |
| `--no-color`        | no colors (`NO_COLOR` works too)                                        |
| `--no-links`        | no clickable links                                                      |
| `--key-dir DIR`     | where new keys are saved (default `./.wallets`): a new or empty folder, or one basewatch made |
| `--keychain`        | also store each new key in the macOS Keychain, under its label          |
| `--show-key`        | show new private keys on screen                                         |
| `--no-save`         | don't write key files (needs `--show-key` or `--keychain`)              |
| `--create-only`     | create the wallets, print how to use them, and exit                     |

## The logo in your terminal

In terminals that can show images (iTerm2, WezTerm, kitty, Ghostty), the
logo shows on a splash screen while basewatch connects, then stays small in the
corner of the live view. `--help` opens with it too. The tab title reads
`🛟 basewatch · buyer, seller`, and switches to 🚩 when the RPC keeps failing.
Everything is restored on quit.
Other terminals, tmux included, get no images. `--no-logo` turns it all off.

**Before a demo in iTerm2:** the first time basewatch shows the logo, iTerm2
asks **Allow Terminal-Initiated Display?** for `basewatch-logo.png`. Tick
**Remember my choice** and click **Yes** in a rehearsal, so the question never
pops up in front of an audience. A remembered **No** means iTerm2 stops showing
the images. basewatch keeps running without them.

## Private keys

- A new wallet's key is saved by default. Money sent to a wallet whose key was
  never kept is lost for good, so `--no-save` is refused unless `--show-key` or
  `--keychain` keeps the key somewhere else.
- Key files are created with mode 600 in a directory with mode 700. That
  directory gets its own `.gitignore` (`*`), so the keys can't be committed
  from any repository. For that to hold, the key directory must be new,
  empty, or one basewatch made before. A folder that already holds other
  files, such as a project's root, is refused rather than changed.
- An existing key file is never overwritten. The Keychain item for a new
  wallet must not already exist either. Both are checked for every new wallet
  before any key is made, so a refusal leaves nothing behind.
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
