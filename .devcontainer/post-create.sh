#!/usr/bin/env bash
#
# Dev container postCreateCommand. Claude Code comes from the devcontainer
# feature; OpenCode is installed from npm here.
#
set -euo pipefail

cd "$(dirname "$0")/.."

sudo chown -R node:node /home/node/.claude
corepack enable

# The claude-code feature installs as root, so Claude Code's auto-updater
# (running as node) fails with "Insufficient permissions to install update".
NPM_GLOBAL="$(npm config get prefix)"
sudo chown -R node:npm "$NPM_GLOBAL/lib/node_modules/@anthropic-ai"
sudo chown -h node:npm "$NPM_GLOBAL/bin/claude"

# OpenCode's state lives in volumes (see "mounts" in devcontainer.json).
# Docker creates the volumes root-owned, along with any parent dirs of the
# mount points the image didn't already have. Hand them over before the
# install: opencode-ai's postinstall runs `opencode --version`, which exits
# non-zero if it can't create its data dir, and the postinstall then falls
# through to the musl builds and fails with EBADPLATFORM.
OPENCODE_DIRS=("$HOME/.local/share/opencode" "$HOME/.config/opencode")
sudo chown "$(id -u):$(id -g)" "$HOME/.local" "$HOME/.local/share" "$HOME/.config" "${OPENCODE_DIRS[@]}"

# auth.json holds provider credentials.
chmod 700 "${OPENCODE_DIRS[@]}"

npm config set allow-scripts='opencode-ai' --location=user
npm install -g opencode-ai
