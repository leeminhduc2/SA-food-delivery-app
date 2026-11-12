#!/usr/bin/env bash
# Runs the same steps as .github/workflows/ci.yml on a developer machine.
#
# Usage:
#   bash scripts/ci-local.sh              # full pipeline, throwaway Postgres in Docker
#   TEST_REPEAT=10 bash scripts/ci-local.sh   # run `npm test` 10 times to catch flaky tests
#   CI_DATABASE_URL=postgresql://user:pass@host:5432/db bash scripts/ci-local.sh
#                                         # reuse an existing database instead of Docker
#   SKIP_INSTALL=1 bash scripts/ci-local.sh   # skip `npm ci` when node_modules is current
set -euo pipefail

cd "$(dirname "$0")/.."

CONTAINER="food-delivery-ci-local-$$"
REDIS_CONTAINER="food-delivery-ci-redis-$$"
PG_PORT=${CI_PG_PORT:-5434}
REDIS_PORT=${CI_REDIS_PORT:-6380}
TEST_REPEAT=${TEST_REPEAT:-1}
started_container=0
started_redis=0

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31mCI FAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$started_redis" = 1 ]; then docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true; fi
  if [ "$started_container" = 1 ]; then
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [ -z "${CI_DATABASE_URL:-}" ]; then
  docker info >/dev/null 2>&1 ||
    fail 'Docker daemon is not running. Start Docker Desktop or set CI_DATABASE_URL.'

  step "Start throwaway PostgreSQL 17 on port $PG_PORT"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_USER=ci \
    -e POSTGRES_PASSWORD=ci_local_only \
    -e POSTGRES_DB=food_delivery_test \
    -p "127.0.0.1:$PG_PORT:5432" \
    postgres:17-alpine >/dev/null
  started_container=1

  for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U ci -d food_delivery_test >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U ci -d food_delivery_test >/dev/null ||
    fail 'PostgreSQL did not become ready.'
  CI_DATABASE_URL="postgresql://ci:ci_local_only@127.0.0.1:$PG_PORT/food_delivery_test"
fi

if [ -z "${CI_REDIS_URL:-}" ]; then
  docker info >/dev/null 2>&1 || fail 'Docker daemon is not running. Start Docker Desktop or set CI_REDIS_URL.'
  docker run -d --name "$REDIS_CONTAINER" -p "127.0.0.1:$REDIS_PORT:6379" redis:7-alpine >/dev/null
  started_redis=1
  for _ in $(seq 1 30); do
    if docker exec "$REDIS_CONTAINER" redis-cli ping 2>/dev/null | grep -q PONG; then break; fi
    sleep 1
  done
  docker exec "$REDIS_CONTAINER" redis-cli ping | grep -q PONG || fail 'Redis did not become ready.'
  CI_REDIS_URL="redis://127.0.0.1:$REDIS_PORT"
fi

# Same variables as the workflow. DOTENV_CONFIG_PATH points at a missing file so
# `import 'dotenv/config'` does not pick up a developer's local .env, exactly as on CI.
export DATABASE_URL="$CI_DATABASE_URL?schema=public"
export TEST_DATABASE_URL="$CI_DATABASE_URL"
export REDIS_URL="$CI_REDIS_URL"
export PRISMA_HIDE_UPDATE_MESSAGE=1
export DOTENV_CONFIG_PATH=.env.ci-local-none
export CI=true

if [ -z "${SKIP_INSTALL:-}" ]; then
  step 'Install dependencies'
  npm ci
fi

step 'Generate Prisma Client'
npx prisma generate

step 'Validate Prisma schema'
npx prisma validate

step 'Type-check'
npx tsc --noEmit

step 'Build production bundle'
npm run build

step 'Check OpenAPI coverage'
npm run check:openapi

step 'Check formatting'
npm run format:check

for i in $(seq 1 "$TEST_REPEAT"); do
  step "Run integration and smoke tests ($i/$TEST_REPEAT)"
  npm test || fail "npm test failed on run $i/$TEST_REPEAT"
done

step 'Validate Compose configuration'
if docker info >/dev/null 2>&1; then
  docker compose --env-file .env.example config --quiet
else
  echo 'Skipped: Docker daemon is not running.'
fi

printf '\n\033[1;32mCI PASSED\033[0m\n'
