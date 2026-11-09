#!/bin/bash
# Обновляет боевой /opt/rita из origin/main. .env, data и резервные копии не в git и не затираются.
set -euo pipefail
cd /opt/rita

systemctl stop rita
trap 'systemctl start rita' EXIT

git fetch origin main
git reset --hard origin/main
npm ci
npx prisma generate
npx prisma migrate deploy
npx tsc

systemctl start rita
trap - EXIT
systemctl is-active --quiet rita
echo "deployed $(git rev-parse --short HEAD)"
