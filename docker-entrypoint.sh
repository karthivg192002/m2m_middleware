#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
# Not `npm run migration:run` — that uses typeorm-ts-node-commonjs, a
# devDependency stripped from this production image (which only ships
# dist/, not src/). Run the compiled data source directly with the plain
# typeorm CLI (a regular dependency) instead.
npx typeorm migration:run -d dist/database/data-source.js

echo "[entrypoint] Starting server..."
exec node dist/main
