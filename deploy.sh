#!/bin/sh
# Build the plugin and copy it into a vault, e.g. one in iCloud Drive for iPhone/iPad.
# Usage: ./deploy.sh "/path/to/Vault"
set -e
[ -n "$1" ] || { echo "Usage: ./deploy.sh /path/to/vault"; exit 1; }
cd "$(dirname "$0")"
npm run build
dest="$1/.obsidian/plugins/mind-atlas"
# A symlinked plugin folder (used for local development) doesn't sync, so replace it.
[ -L "$dest" ] && rm "$dest"
mkdir -p "$dest"
cp main.js manifest.json styles.css "$dest/"
echo "Copied to $dest"
