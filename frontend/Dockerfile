# Production image only — local dev runs `npm run dev` directly on the host.
# Next's rewrites() resolves API_ORIGIN at build time, so it's a build ARG,
# not a runtime ENV: docker-compose.prod.yml passes it as a build arg pointing
# at the `api` service name.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# No public/ directory exists yet in this project — create an empty one so
# the standalone output has somewhere to serve static assets from later.
RUN mkdir -p public
ARG API_ORIGIN=http://api:8000
ENV API_ORIGIN=${API_ORIGIN}
RUN npm run build

FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
CMD ["node", "server.js"]
