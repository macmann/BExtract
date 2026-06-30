#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ -f ".env" ]; then
  set -a
  # shellcheck source=/dev/null
  . ".env"
  set +a
fi

missing=()
for name in GOOGLE_API_KEY DATABASE_URL DIRECT_URL; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required environment variable(s): ${missing[*]}" >&2
  echo "Create .env or export GOOGLE_API_KEY, DATABASE_URL, and DIRECT_URL before running this script." >&2
  exit 1
fi

PRISMA_CLI_VERSION="${PRISMA_CLI_VERSION:-6.19.0}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8000}"
PYTHON_BIN="${PYTHON_BIN:-python}"

echo "==> Installing root Node/Prisma dependencies"
npm install

echo "==> Installing frontend dependencies"
npm --prefix client install

echo "==> Building static frontend"
npm --prefix client run build

echo "==> Installing backend Python dependencies"
"$PYTHON_BIN" -m pip install -r server/requirements.txt

echo "==> Applying Prisma schema to the database with prisma@$PRISMA_CLI_VERSION"
npx -y "prisma@$PRISMA_CLI_VERSION" db push --schema prisma/schema.prisma

echo "==> Generating Prisma clients with prisma@$PRISMA_CLI_VERSION"
npx -y "prisma@$PRISMA_CLI_VERSION" generate --schema prisma/schema.prisma

echo "==> Starting BExtractor at http://localhost:$PORT"
exec "$PYTHON_BIN" -m uvicorn server.main:app --host "$HOST" --port "$PORT"
