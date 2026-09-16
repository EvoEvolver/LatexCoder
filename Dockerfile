# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bubblewrap \
    ca-certificates \
    curl \
    git \
    ripgrep \
    tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY scripts/install-tectonic.sh ./scripts/install-tectonic.sh
RUN LATEXCODER_STATE_DIR=/opt/latexcoder-compiler ./scripts/install-tectonic.sh \
  && install -m 0755 /opt/latexcoder-compiler/bin/tectonic /usr/local/bin/tectonic \
  && rm -rf /opt/latexcoder-compiler

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json server.ts ./
COPY src ./src

ENV NODE_ENV=production \
  LATEXCODER_HOST=0.0.0.0 \
  LATEXCODER_STATE_DIR=/data

RUN mkdir -p /data

EXPOSE 8090

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "server.ts"]
