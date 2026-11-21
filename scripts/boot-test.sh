#!/usr/bin/env bash
# Boots the working tree's server against a database made by an earlier commit
# (default HEAD), in live mode with a dummy key: the check CLAUDE.md asks for
# when startup or the schema changes. Walmart calls fail ("fetch failed"); that's
# expected. Prints the health check, one deal and any other log lines.
#   scripts/boot-test.sh [commit]
set -euo pipefail
cd "$(dirname "$0")/.."
commit="${1:-HEAD}"
tmp="$(mktemp -d)"
trap 'git worktree remove --force "$tmp/old" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
git worktree add -f "$tmp/old" "$commit" >/dev/null 2>&1
node -e "require('fs').writeFileSync('$tmp/key.pem', require('crypto').generateKeyPairSync('rsa',{modulusLength:1024}).privateKey.export({type:'pkcs1',format:'pem'}))"
# Old code: create its schema and a little data.
cat > "$tmp/fill.mjs" <<JS
import { DatabaseSync } from 'node:sqlite';
import { StorePrices } from '$tmp/old/src/retailers/walmart/storePrices.js';
import { TierStore } from '$tmp/old/src/retailers/walmart/tierLists.js';
const db = new StorePrices(new DatabaseSync('$tmp/boot.db')); new TierStore(db);
db.recordStorePrices('walmart', '573', [{ itemId: '11', title: 'Lamp', price: 3, wasPrice: 9, clearance: true, seller: 'Walmart.com', inStock: true, category: 'Home' }], new Date().toISOString().slice(0, 10));
db.ensureMarkdowns('walmart');
console.log('database made by', '$commit');
JS
node "$tmp/fill.mjs" 2>/dev/null
# New code on it.
PORT=3999 DATABASE_PATH="$tmp/boot.db" WALMART_CONSUMER_ID=x WALMART_PRIVATE_KEY_PATH="$tmp/key.pem" node src/server.js > "$tmp/server.log" 2>&1 &
pid=$!
for _ in $(seq 1 30); do curl -s localhost:3999/api/health >/dev/null 2>&1 && break; sleep 0.5; done
echo "health: $(curl -s localhost:3999/api/health)"
echo "deals:  $(curl -s 'localhost:3999/api/walmart/all-deals?limit=1' | head -c 120)"
kill $pid
grep -iv 'experimental\|trace-warnings\|fetch failed\|failed: fetch' "$tmp/server.log" || true
