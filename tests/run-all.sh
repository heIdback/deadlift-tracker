#!/bin/sh
# Runs every automated test that doesn't need the Firebase emulator.
# From the project root:  sh tests/run-all.sh
# Browser tests need Playwright (see tests/README.md).
set -e
cd "$(dirname "$0")/.."
export TZ=Europe/Zagreb
echo "== unit";    node --test tests/unit/*.test.mjs
echo "== service"; node --import ./tests/support/register.mjs --test tests/service/*.test.mjs
echo "== precache"; node tests/support/precache-audit.mjs
echo "== browser"; node --test --test-concurrency=1 tests/browser/*.test.mjs
