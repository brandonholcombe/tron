# syntax=docker/dockerfile:1

FROM --platform=linux/amd64 node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM --platform=linux/amd64 node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY public ./public
COPY src ./src
RUN npm run build

FROM --platform=linux/amd64 node:20-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/server/index.js"]
