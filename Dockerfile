# This is a reproducible development image selection, not a qualified company
# runtime binding. Release CI must record actual image digests and scan results.
FROM node:22.17.1-bookworm-slim AS dependencies
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

FROM dependencies AS build
ARG APPCHI_BACKEND_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV APPCHI_BACKEND_URL=${APPCHI_BACKEND_URL}
COPY frontend/next.config.ts frontend/next-env.d.ts frontend/tsconfig.json ./
COPY frontend/src ./src
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
