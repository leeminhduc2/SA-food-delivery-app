# syntax=docker/dockerfile:1
# Build stage: install every dependency (including the TypeScript/Vite toolchain)
# and compile the browser bundle. `npm run build` also type-checks the server.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: the API is executed from TypeScript sources by tsx, so the
# server tree, the compiled browser bundle and dev dependencies are required.
FROM node:22-alpine AS runtime
ENV NODE_ENV=development \
    HOST=0.0.0.0 \
    PORT=3001
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
# `prisma migrate deploy` (entrypoint) needs the schema and migrations.
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.yaml ./openapi.yaml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
