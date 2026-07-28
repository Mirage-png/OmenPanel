# A prior version of this file installed a full Eclipse Temurin JDK + Node
# via NodeSource on the assumption Minecraft (Purpur) needs a system JVM.
# That's wrong: MCSManager's own daemon (JavaManager, mcsmanager/daemon/app.js)
# downloads and manages its own JDKs from Azul's public Zulu API in pure JS —
# confirmed live on Render's plain Node runtime, no system Java, no Docker,
# no apt-get involved at all. A plain Node base image is enough.
#
# That same prior version also broke the build outright: its install RUN
# chained `npm install --prefix minecraft-server/middleware`, but that
# directory has no package.json (its code requires from minecraft-server's
# own node_modules instead) — reproduced locally, npm exits non-zero on a
# missing package.json, which failed the whole `&&`-chained RUN step. Reusing
# the root `npm run build` script here instead of duplicating the install
# list keeps this from silently drifting out of sync with that script again.
FROM node:20-slim

WORKDIR /app
COPY . .

# Same registry pin as the "build" script itself needs (see its own comment
# in package.json): makes the install immune to any inherited npm/yarn
# config pointing at an unreachable internal registry, baked in at build
# time here rather than left to whatever environment the container runs in.
RUN npm run build

# Metadata only — the router actually binds to $PORT if the platform injects
# one (Render, Northflank, etc. all differ on this), falling back to 3000 via
# web/index.js if unset.
EXPOSE 3000

CMD ["bash", "minecraft-server/deploy-start.sh"]
