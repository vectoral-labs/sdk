#!/usr/bin/env bash
# Refresh the vendored fingerprint test vectors from the Go monorepo.
#
# The Go implementation in internal/fingerprint is NORMATIVE: every SDK port
# must reproduce its vectors bit-exactly. These files are vendored here so this
# repo's tests stand alone, but the monorepo remains the source of truth.
#
# On a test failure after syncing, fix the SDK — never regenerate the vectors
# from an SDK. A fingerprint that disagrees across languages matches nothing.
#
#   ./scripts/sync-fingerprint-vectors.sh [path-to-vectoral-monorepo]

set -euo pipefail

SRC="${1:-../vectoral}"
DEST="$(cd "$(dirname "$0")/.." && pwd)/typescript/packages/sdk/src/fingerprint"

if [ ! -d "$SRC/internal/fingerprint" ]; then
  echo "error: $SRC does not look like the vectoral monorepo" >&2
  echo "usage: $0 [path-to-vectoral-monorepo]" >&2
  exit 1
fi

cp "$SRC/internal/fingerprint/testdata/test_vectors.json" "$DEST/testdata/test_vectors.json"
cp "$SRC/internal/fingerprint/minhash_constants.json" "$DEST/testdata/canonical_minhash_constants.json"
# The constants are imported by similarity.ts at runtime, and the copy under
# testdata/ is what the parity test compares against — keep both in step.
cp "$SRC/internal/fingerprint/minhash_constants.json" "$DEST/minhash_constants.json"

echo "synced from $SRC"
echo "now run: (cd typescript && npx vitest run packages/sdk/src/fingerprint)"
