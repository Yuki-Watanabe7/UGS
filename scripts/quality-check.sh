#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> Lint"
npm run lint

echo "==> Test"
npm run test

echo "==> Build"
npm run build
