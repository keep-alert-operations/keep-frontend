# syntax=docker/dockerfile:1
# Build from the appchi-frontend repository root. Supply a reviewed, mirrored
# Keycloak image digest compatible with this repository's theme contract.
ARG KEYCLOAK_BASE_IMAGE
FROM ${KEYCLOAK_BASE_IMAGE} AS build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
COPY --chown=1000:0 keycloak/themes/appchi /opt/keycloak/themes/appchi
RUN /opt/keycloak/bin/kc.sh build

FROM ${KEYCLOAK_BASE_IMAGE} AS runtime
COPY --from=build --chown=1000:0 /opt/keycloak/ /opt/keycloak/
ENV KC_DB=postgres KC_HEALTH_ENABLED=true KC_METRICS_ENABLED=true
# Use writable emptyDir mounts for /tmp and /opt/keycloak/data. Configure the
# database, hostname, TLS/proxy trust, bootstrap identity and realm at runtime.
USER 1000:0
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized"]
