# Sourced by demo.tape from the repo root: builds the sandbox and defines `ship`.
SHIP_CLI="$PWD/src/cli.ts"
sandbox=$(mktemp -d)
docs/demo/setup.sh "$sandbox"
cd "$sandbox/acme-shop"
PS1='\[\e[38;5;117m\]acme-shop\[\e[0m\] \[\e[38;5;183m\]($(git branch --show-current))\[\e[0m\] $ '
ship() { bun "$SHIP_CLI"; }
clear
