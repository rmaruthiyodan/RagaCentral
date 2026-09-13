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

# The slim base ships no CA bundle, and workerd verifies TLS against the
# system trust store rather than Node's built-in one. Without this, every
# outbound HTTPS call the Worker makes dies with
#
#   TLS peer's certificate is not trusted; reason = unable to get local
#   issuer certificate
#
# which is how "speak a lesson note" failed the first time it tried to
# reach a real host. Nothing in the app noticed until then, because until
# then the Worker never called out to anything.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && update-ca-certificates \
 && rm -rf /var/lib/apt/lists/*

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
