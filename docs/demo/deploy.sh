#!/bin/sh
# Stand-in deploy command for the demo sandbox. Prints a pretend deploy instead of doing one.
stage=$2
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
c 90 "│  ➜  Deploying acme-shop to $stage"
sleep 0.4
for r in Web Api Database Queue; do sleep 0.25; c 90 "│     ✓ $r"; done
sleep 0.3
c 32 "│  ✓  Live at https://$stage.acme-shop.dev"
