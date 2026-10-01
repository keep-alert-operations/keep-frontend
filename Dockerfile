# syntax=docker/dockerfile:1
# This is a reproducible development image selection, not a qualified company
# runtime binding. Release CI must record actual image digests and scan results.
FROM node:22.17.1-bookworm-slim AS dependencies
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/git-askpass.sh /tmp/git-askpass.sh
RUN chmod 700 /tmp/git-askpass.sh
COPY package.json package-lock.json ./
RUN git config --global url."https://github.com/".insteadOf ssh://git@github.com/
RUN --mount=type=secret,id=github_token GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 npm ci

FROM dependencies AS build
ARG APPCHI_BACKEND_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV APPCHI_BACKEND_URL=${APPCHI_BACKEND_URL}
COPY next.config.ts next-env.d.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.17.1-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN chgrp -R 0 /app && chmod -R g=rX /app
USER 1001
EXPOSE 3000
CMD ["node", "server.js"]
