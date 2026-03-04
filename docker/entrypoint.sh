#!/bin/bash
set -e

USER_HOME="/home/${USER_NAME}"

# Fix ownership of named volumes (root-owned on first creation)
chown "$USER_NAME":"$USER_NAME" "${USER_HOME}/.local" node_modules

# ~/.claude is bind-mounted at the host path (e.g. /home/host-user/.claude).
# Create a symlink from the container home so both paths resolve.
if [ -n "$HOST_HOME" ] && [ "$HOST_HOME" != "$USER_HOME" ]; then
  ln -sfn "${HOST_HOME}/.claude" "${USER_HOME}/.claude"
  ln -sfn "${HOST_HOME}/.claude.json" "${USER_HOME}/.claude.json"
fi

if ! command -v mise &>/dev/null; then
  echo "[haruna-docker] Installing mise..."
  su -s /bin/bash "$USER_NAME" -c 'curl https://mise.run | sh'
fi

if ! command -v claude &>/dev/null; then
  echo "[haruna-docker] Installing Claude Code..."
  su -s /bin/bash "$USER_NAME" -c 'curl -fsSL https://claude.ai/install.sh | bash'
fi

# Skip mise install if mise.toml hasn't changed.
MISE_HASH=$(md5sum mise.toml 2>/dev/null | cut -d' ' -f1)
MISE_CACHED=$(cat "${USER_HOME}/.local/.mise-toml-hash" 2>/dev/null || true)
if [ "$MISE_HASH" != "$MISE_CACHED" ]; then
  echo "[haruna-docker] Installing tools..."
  su -s /bin/bash "$USER_NAME" -c 'mise trust && mise install'
  echo "$MISE_HASH" > "${USER_HOME}/.local/.mise-toml-hash"
fi

# Skip bun install if bun.lock hasn't changed.
LOCK_HASH=$(md5sum bun.lock 2>/dev/null | cut -d' ' -f1)
LOCK_CACHED=$(cat node_modules/.bun-lock-hash 2>/dev/null || true)
if [ "$LOCK_HASH" != "$LOCK_CACHED" ]; then
  su -s /bin/bash "$USER_NAME" -c 'bun install'
  echo "$LOCK_HASH" > node_modules/.bun-lock-hash
fi

# Drop to non-root and exec
exec setpriv \
  --reuid=$(id -u "$USER_NAME") \
  --regid=$(id -g "$USER_NAME") \
  --init-groups \
  env HOME="$USER_HOME" "$@"
