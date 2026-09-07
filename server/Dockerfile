# Agentic PMS — API image.
#
# No build step: the server is plain CommonJS Node, so this is a single
# stage. The only thing worth being careful about is that `npm ci
# --omit=dev` needs package-lock.json to exist and match package.json —
# it does, and it is committed, which is the point of using `ci` over
# `install` here: the image is reproducible, and a transitive dependency
# cannot quietly float to a new version between the build that was tested
# and the build that ships to a customer.
FROM node:22-alpine

# dumb-init reaps zombies and forwards SIGTERM to node. Without it node
# runs as PID 1, where it does NOT get the default signal handlers — so
# `docker stop` waits the full 10s grace period and then SIGKILLs, which
# on this app means killing the process mid-migration on an unlucky
# restart. Cheap insurance.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The base image ships an unprivileged `node` user. Running as root inside
# a container is not a sandbox escape on its own, but it means a bug in a
# dependency writes as root on any mounted path — and this app mounts
# nothing it needs to write to, so there is no reason to allow it.
USER node

EXPOSE 8080

# Container-level liveness. Compose uses this to gate the web container's
# start, so nginx does not come up pointing at an API that is still
# running migrations. index.js serves /api/v1/health before any auth.
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
