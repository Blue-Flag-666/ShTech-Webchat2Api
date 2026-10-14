FROM node:26.11.1-alpine AS node-runtime

FROM node-runtime AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm install --global npm@12.2.0 --ignore-scripts && npm ci --ignore-scripts
COPY src ./src
COPY scripts/build-server.mjs scripts/bundle.mjs ./scripts/
RUN npm run build:server
RUN apk add --no-cache binutils \
  && strip --strip-unneeded /usr/local/bin/node

FROM alpine:3.24.2

RUN apk add --no-cache ca-certificates libstdc++ libatomic \
  && addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /sbin/nologin -D node \
  && mkdir -p /data \
  && chown node:node /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
COPY licenses/Node.js.txt /usr/share/licenses/nodejs/LICENSE
COPY licenses/unpdf.txt /usr/share/licenses/unpdf/LICENSE
COPY licenses/fflate.txt /usr/share/licenses/fflate/LICENSE

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    GENAI_DATA_DIR=/data
WORKDIR /app
VOLUME ["/data"]

# Runtime-only image: npm, Corepack, headers and tests stay in the build stage.
COPY --chown=node:node package.json .env.example ./
COPY --from=build --chown=node:node /build/dist/server.cjs ./server.cjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "server.cjs"]
