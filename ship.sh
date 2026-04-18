#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

echo "── Build ──"
npm run build

echo "── Test ──"
node test/analytics.test.mjs

echo "── Bump patch version ──"
NEW_VERSION=$(node -p "
  const pkg = require('./package.json');
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  major + '.' + minor + '.' + (patch + 1)
")
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Version: $NEW_VERSION"

echo "── Stage & Commit ──"
git add -A
MSG="${1:-chore: bump version to $NEW_VERSION [skip ci]}"
git commit -m "$MSG" || echo "Nothing to commit."

echo "── Pull & Push ──"
git pull --rebase origin main
git push origin main

echo "── Done ──"
