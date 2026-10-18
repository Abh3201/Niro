#!/usr/bin/env sh
# Build the two zip packages for Azure App Service's built-in Node runtime:
# out/azure/web.zip and out/azure/realtime.zip. See docs/deploy-azure.md.
#
# Each zip holds the built app and its production dependencies, with a flat
# node_modules (no symlinks, which zip deploy may not keep), so App Service only
# has to run `node`. Nothing is built on Azure.
set -eu

cd "$(dirname "$0")/../.."
out="$PWD/out/azure"
rm -rf "$out"
mkdir -p "$out"

pnpm install --frozen-lockfile
pnpm --filter @niro/web --filter @niro/realtime build

for app in web realtime; do
  pnpm deploy --legacy --prod --config.node-linker=hoisted --filter "@niro/$app" "$out/$app"
  rm -rf "$out/$app/node_modules/.bin"
done
cp -r apps/web/build "$out/web/build"
cp -r apps/realtime/dist "$out/realtime/dist"

(cd "$out/web" && zip -qr ../web.zip .)
(cd "$out/realtime" && zip -qr ../realtime.zip .)
rm -rf "$out/web" "$out/realtime"
ls -lh "$out"
