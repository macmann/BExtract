#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
NODE_VERSION="${NODE_VERSION:-20}"

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js ${NODE_VERSION} with nvm..."
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install "$NODE_VERSION"
  nvm use "$NODE_VERSION"
else
  echo "Using existing Node.js $(node --version)"
fi

if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm use "$NODE_VERSION" || true
fi

pushd client
npm install
npm run build
popd

pushd server
pip install -r requirements.txt
popd
