# syntax=docker/dockerfile:1
# One Dockerfile, two images: `--target web` and `--target realtime`.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS build
RUN npm install --global pnpm@10.28.0
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @niro/web --filter @niro/realtime build
# Copy each app with only its production dependencies into /out/<app>.
RUN pnpm deploy --legacy --filter @niro/web --prod /out/web \
 && cp -r apps/web/build /out/web/build \
 && pnpm deploy --legacy --filter @niro/realtime --prod /out/realtime \
 && cp -r apps/realtime/dist /out/realtime/dist

FROM node:${NODE_VERSION}-alpine AS web
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/web .
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node_modules/.bin/react-router-serve", "./build/server/index.js"]

FROM node:${NODE_VERSION}-alpine AS realtime
ENV NODE_ENV=production PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /out/realtime .
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]
