# syntax=docker/dockerfile:1
# This is a reproducible development image selection, not a qualified company
# runtime binding. Release CI must record actual image digests and scan results.
ARG NODE_BASE_IMAGE=node:22.17.1-bookworm-slim
FROM ${NODE_BASE_IMAGE} AS dependencies
# build_ca contains public PEM CA certificates only; apt still verifies signatures.
RUN --mount=type=secret,id=apt_sources --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -f /run/secrets/apt_sources ]; then \
        rm -f /etc/apt/sources.list /etc/apt/sources.list.d/*; \
        cp /run/secrets/apt_sources /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /run/secrets/build_ca ]; then \
        if grep -q 'PRIVATE KEY' /run/secrets/build_ca; then exit 1; fi; \
        mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs; \
        cp /run/secrets/build_ca /usr/local/share/ca-certificates/appchi-build-ca.crt; \
        cat /run/secrets/build_ca >> /etc/ssl/certs/ca-certificates.crt; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
    update-ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY scripts/git-askpass.sh /tmp/git-askpass.sh
RUN chmod 700 /tmp/git-askpass.sh
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=github_token --mount=type=secret,id=build_environment --mount=type=secret,id=npmrc,target=/root/.npmrc \
    set -eu; \
    if [ -f /run/secrets/build_environment ]; then \
        set -a; . /run/secrets/build_environment; set +a; \
    fi; \
    export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt; \
    export PIP_CERT="$SSL_CERT_FILE" REQUESTS_CA_BUNDLE="$SSL_CERT_FILE"; \
    export GIT_SSL_CAINFO="$SSL_CERT_FILE" NODE_EXTRA_CA_CERTS="$SSL_CERT_FILE"; \
    export GIT_CONFIG_GLOBAL=/tmp/appchi-build-gitconfig; \
    if [ -n "${APPCHI_GIT_BASE_URL:-}" ]; then \
        case "$APPCHI_GIT_BASE_URL" in https://*/ ) ;; *) exit 1 ;; esac; \
        case "$APPCHI_GIT_BASE_URL" in *'@'*|*'?'*|*'#'*) exit 1 ;; esac; \
        git config --global url."$APPCHI_GIT_BASE_URL".insteadOf https://github.com/appchi-alert-operations/; \
        git config --global --add url."$APPCHI_GIT_BASE_URL".insteadOf ssh://git@github.com/appchi-alert-operations/; \
    else \
        git config --global url."https://github.com/".insteadOf ssh://git@github.com/; \
    fi; \
    GIT_ASKPASS=/tmp/git-askpass.sh GIT_TERMINAL_PROMPT=0 npm ci; \
    rm -f "$GIT_CONFIG_GLOBAL"; rm -rf /root/.npm

FROM dependencies AS build
ARG APPCHI_BACKEND_URL
ENV NEXT_TELEMETRY_DISABLED=1
ENV APPCHI_BACKEND_URL=${APPCHI_BACKEND_URL}
COPY next.config.ts next-env.d.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_BASE_IMAGE} AS runtime
RUN --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -f /run/secrets/build_ca ]; then \
        if grep -q 'PRIVATE KEY' /run/secrets/build_ca; then exit 1; fi; \
        mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs; \
        cp /run/secrets/build_ca /usr/local/share/ca-certificates/appchi-build-ca.crt; \
        cat /run/secrets/build_ca >> /etc/ssl/certs/ca-certificates.crt; \
    fi;

WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
RUN chgrp -R 0 /app && chmod -R g=rX /app
USER 1001:0
RUN node --check server.js
EXPOSE 3000
CMD ["node", "server.js"]
