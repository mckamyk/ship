#!/bin/bash
# Builds a throwaway repo with a local bare "origin" for the demo recording.
# Usage: docs/demo/setup.sh <empty-dir>
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$1
mkdir -p "$root" && cd "$root"
git init -q --bare -b main origin.git
git init -q -b main acme-shop && cd acme-shop
git config user.name "Sam Rivera"
git config user.email sam@example.com
git remote add origin ../origin.git
cp "$here/deploy.sh" deploy.sh
cat > ship.config.json <<'JSON'
{
  "deploy": {
    "dev": "./deploy.sh --stage dev",
    "staging": "./deploy.sh --stage staging",
    "prod": "./deploy.sh --stage prod"
  }
}
JSON
mkdir -p src && echo 'export const cart = [];' > src/cart.ts
printf '# acme-shop\n' > README.md
git add -A && git commit -qm "Initial commit" && git push -q -u origin main
git switch -q -c ship/search-bar
echo 'export const search = () => {};' > src/search.ts
git add -A && git commit -qm "Search bar" && git push -q -u origin ship/search-bar 2>/dev/null
git switch -q main
