FROM node:26.8.2-alpine AS node-runtime

FROM alpine:3.24.1

RUN apk add --no-cache ca-certificates libstdc++ \
  && addgroup -g 1000 node \
  && adduser -u 1000 -G node -s /sbin/nologin -D node
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/LICENSE /usr/local/LICENSE

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app

# Runtime-only image: npm, Corepack, headers and tests stay in the build stage.
COPY --chown=node:node package.json server.mjs transport.mjs models.mjs auth.mjs tools.mjs protocols.mjs structured.mjs lifecycle.mjs .env.example ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "--env-file-if-exists=.env", "server.mjs"]
