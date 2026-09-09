# Sruti in a container.
#
# This app targets Cloudflare Workers, so the container runs the real Cloudflare
# runtime (workerd) locally via Wrangler rather than plain Node. D1 becomes a
# SQLite file and R2 becomes a directory on disk — both under /app/.wrangler,
# which is a volume so your recordings survive a rebuild.
#
# workerd needs glibc, so this is bookworm-slim and not alpine.

FROM node:22-bookworm-slim

WORKDIR /app

ENV WRANGLER_SEND_METRICS=false \
    CI=true \
    NODE_ENV=development

# Dependencies first, so editing the app doesn't re-download node_modules.
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

# D1's SQLite file and R2's objects both live here. Mount a volume or the
# whole library disappears with the container.
VOLUME ["/app/.wrangler"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8787
ENTRYPOINT ["docker-entrypoint.sh"]
