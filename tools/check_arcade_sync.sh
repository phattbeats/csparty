#!/bin/sh
# Verify the PHATT GAMING ARCADE selector + logos match across the sibling repos.
# Usage: tools/check_arcade_sync.sh <csparty-arcade-dir> <other-arcade-dir>...   (dirs holding phatt-arcade.js + *.webp)
ref="$1"; shift; rc=0
for d in "$@"; do
  for f in "$ref"/*; do cmp -s "$f" "$d/$(basename "$f")" || { echo "DIFF $d/$(basename "$f")"; rc=1; }; done
done
[ $rc = 0 ] && echo "arcade copies in sync"; exit $rc
