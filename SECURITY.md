# Security policy

basewatch handles private keys and prints text that comes from an RPC, so
reports of security problems are welcome.

## Reporting a vulnerability

Report it privately, not in a public issue:

1. Open <https://github.com/devpartners/basewatch/security/advisories/new>.
   It is the **Report a vulnerability** button on the repository's Security
   tab.
2. Say what you found, how to reproduce it, and the version or commit you
   used. A proof of concept helps.

Only the maintainers can see the report, and the reply comes there.

Never put a real private key, or an RPC URL that holds an API key, in a report.

## Supported versions

Fixes go into the newest release only.

## What counts

- A private key shown, logged, sent anywhere, or saved where it should not be.
  "Private keys" in the [README](README.md#private-keys) lists what basewatch
  promises.
- Text from an RPC that reaches the terminal with its control characters, or an
  RPC URL's path or key shown on screen or in an error.
- An RPC that can make basewatch send a request to another host, run a command,
  or open a page that is not on the explorer you chose.
- A wallet argument or an option that makes basewatch write outside its key
  folder, or overwrite a file.

## What does not

- An RPC that reports false balances or transfers. basewatch shows what the RPC
  you chose tells it, so use one you trust, over `https://`.
- Anything that first needs control of your shell, your environment variables
  or your files.
