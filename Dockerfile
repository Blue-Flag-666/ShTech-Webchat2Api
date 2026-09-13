FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app

# Runtime-only image: the proxy has no npm dependencies.
COPY --chown=node:node package.json server.mjs transport.mjs models.mjs auth.mjs tools.mjs protocols.mjs lifecycle.mjs .env.example ./
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "--env-file-if-exists=.env", "server.mjs"]
