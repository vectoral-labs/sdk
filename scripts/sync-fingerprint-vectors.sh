#!/usr/bin/env bash
# MAINTAINERS ONLY — needs a checkout of the Vectoral server repository, which
# is not public. If you are reading this as a user of the SDK: you cannot run
# it and you do not need to. The vectors are committed here, so the test suite
# is self-contained.
#
# What it is for: the Go implementation of the fingerprint is NORMATIVE, and
# every port must reproduce its vectors bit-exactly. They are vendored into
# this repo so its tests stand alone; this re-vendors them when the normative
# side changes.
#
# On a test failure after syncing, fix the SDK — never regenerate the vectors
# from an SDK. A fingerprint that disagrees across languages matches nothing.
#
#   ./scripts/sync-fingerprint-vectors.sh [path-to-server-repo]

set -euo pipefail

SRC="${1:-../vectoral}"   # a server-repo checkout, maintainers only
DEST="$(cd "$(dirname "$0")/.." && pwd)/typescript/packages/sdk/src/fingerprint"

if [ ! -d "$SRC/internal/fingerprint" ]; then
  echo "error: $SRC is not a Vectoral server-repo checkout" >&2
  echo "usage: $0 [path-to-server-repo]   (maintainers only)" >&2
  exit 1
fi

cp "$SRC/internal/fingerprint/testdata/test_vectors.json" "$DEST/testdata/test_vectors.json"
cp "$SRC/internal/fingerprint/minhash_constants.json" "$DEST/testdata/canonical_minhash_constants.json"
# The constants are imported by similarity.ts at runtime, and the copy under
# testdata/ is what the parity test compares against — keep both in step.
cp "$SRC/internal/fingerprint/minhash_constants.json" "$DEST/minhash_constants.json"

echo "synced from $SRC"
echo "now run: (cd typescript && npx vitest run packages/sdk/src/fingerprint)"
