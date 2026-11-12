#!/bin/bash
# Usage: consolidation-apply.sh BRAIN_DIR YYYY-MM-DD 'step 5d' [MANIFEST.json|-]
# JSON is read from stdin by default. See the consolidation skill for its schema.
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/consolidation-transaction.mjs" apply "$@"
