#!/usr/bin/env bash
set -euo pipefail
# ---------------------------------------------------------------------------
# go.sh
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

basewatch 0xebDbdC98C7AA8DA34f2A443Dd4C8895D05cDBA3E=random-agent \
          0x9b98695Fc3a1616edE9605416B7D2bB90Fec0ace=ipfacts.com \
	0xdf19568cfaa54436893B8CB4dAACed327413Cd39=billw-funding-wallet
