FROM node:26.8.2-alpine AS node-runtime

FROM node-runtime AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts/build-server.mjs ./scripts/build-server.mjs
RUN npm run build:server

FROM alpine:3.24.1

RUN apk add --no-cache ca-certificates libstdc++ \
  && addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /sbin/nologin -D node
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY THIRD_PARTY_LICENSES/Node.js.txt /usr/share/licenses/nodejs/LICENSE
COPY THIRD_PARTY_LICENSES/unpdf.txt /usr/share/licenses/unpdf/LICENSE
COPY THIRD_PARTY_LICENSES/fflate.txt /usr/share/licenses/fflate/LICENSE

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app

# Runtime-only image: npm, Corepack, headers and tests stay in the build stage.
COPY --chown=node:node package.json .env.example ./
COPY --from=build --chown=node:node /build/dist/server.cjs ./server.cjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "server.cjs"]
