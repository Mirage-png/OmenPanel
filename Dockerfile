# Render's native "Node" environment has no JVM at all — Minecraft (via
# Purpur) needs Java, so this app needs a real container image, not a plain
# Node buildpack. Based on Eclipse Temurin (the standard OpenJDK
# distribution) rather than a bare Debian/Ubuntu image + apt-installed JDK,
# since Temurin's own images are what most Minecraft hosts already test
# against. Node is layered on top via NodeSource, since Temurin's own images
# don't ship it.
#
# Java 21: the current baseline modern Minecraft (Purpur) actually requires;
# older server jars still run fine on a newer JRE than they were built for.
FROM eclipse-temurin:21-jdk-jammy

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# Every dependency install and the PTY/zip-tool binary download happen here,
# at build time, baked into the image — not at container start. That's the
# actual fix for "the panel takes forever to load": deploy-start.sh's own
# install_if_needed() calls become no-ops at runtime since node_modules
# already exists everywhere, so start goes straight to booting the 4
# processes instead of installing anything first.
RUN npm install --no-package-lock --omit=dev \
    && npm install --no-package-lock --omit=dev --prefix minecraft-server \
    && npm install --no-package-lock --omit=dev --prefix minecraft-server/mcsmanager/daemon \
    && npm install --no-package-lock --omit=dev --prefix minecraft-server/mcsmanager/web \
    && npm install --no-package-lock --omit=dev --prefix minecraft-server/middleware \
    && node minecraft-server/middleware/install-libs.js

# Metadata only — the router actually binds to $PORT (Render sets this at
# runtime regardless of what's declared here) via web/index.js, falling back
# to 3000 if unset.
EXPOSE 3000

CMD ["bash", "minecraft-server/deploy-start.sh"]
