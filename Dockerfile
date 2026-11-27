# build identity (src/version.js): from the build args when given (scripts/release, hostd's rebuild-image.sh), else read from the
# .git directory in the build context, so a plain `git clone` + `docker build .` / `docker compose up --build` knows its commit too
FROM node:22-bookworm-slim AS buildinfo
WORKDIR /src
COPY . .
ARG BONFIRE_BUILD_COMMIT=""
ARG BONFIRE_BUILD_COMMIT_DATE=""
ARG BONFIRE_BUILD_AT=""
ARG BONFIRE_BUILD_DIRTY="0"
ARG BONFIRE_BUILD_ID=""
RUN node scripts/build-info.js > /build-info.json && cat /build-info.json

FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY --from=buildinfo /build-info.json ./build-info.json
# the same args as env too (they win over build-info.json; hostd reads them back from the image)
ARG BONFIRE_BUILD_COMMIT=""
ARG BONFIRE_BUILD_COMMIT_DATE=""
ARG BONFIRE_BUILD_AT=""
ARG BONFIRE_BUILD_DIRTY="0"
ARG BONFIRE_BUILD_ID=""
# set only for the published image (ghcr.io/ikelene/ember-server): Server info then says "docker compose pull" instead of "rebuild"
ARG BONFIRE_IMAGE=""
ENV BONFIRE_IMAGE=$BONFIRE_IMAGE BONFIRE_BUILD_COMMIT=$BONFIRE_BUILD_COMMIT BONFIRE_BUILD_COMMIT_DATE=$BONFIRE_BUILD_COMMIT_DATE BONFIRE_BUILD_AT=$BONFIRE_BUILD_AT BONFIRE_BUILD_DIRTY=$BONFIRE_BUILD_DIRTY BONFIRE_BUILD_ID=$BONFIRE_BUILD_ID
LABEL org.opencontainers.image.revision=$BONFIRE_BUILD_COMMIT org.opencontainers.image.created=$BONFIRE_BUILD_AT
ENV NODE_ENV=production BONFIRE_DATA=/data PORT=4100
VOLUME /data
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# exit code 75 = "restart me" (settings changed in the admin UI); docker's restart policy brings it back
CMD ["node", "src/index.js"]
