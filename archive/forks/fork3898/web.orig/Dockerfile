# CS Party web relay: serves the browser client and bridges browser WebSockets to the game server's UDP.
# Build web/public first (web/build_web.sh), and mount your packed game data at /app/public/gamedata.zip.
ARG BASE=public.ecr.aws/docker/library/node:22-slim
FROM ${BASE}
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --silent
COPY relay.js ./
COPY public/ ./public/
ENV PORT=8080 GAME=127.0.0.1:27015 ROOT=/app/public
EXPOSE 8080
USER node
CMD ["node", "relay.js"]
