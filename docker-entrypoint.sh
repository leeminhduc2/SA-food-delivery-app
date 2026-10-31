#!/bin/sh
# Apply pending Prisma migrations before the API starts. `prisma migrate deploy`
# never resets the database or generates migrations, and `set -e` aborts startup
# if it fails. Seed data stays a manual step
# (`docker compose run --rm app npm run db:seed`).
set -eu
echo "Applying pending Prisma migrations..."
npm run db:migrate
exec "$@"
