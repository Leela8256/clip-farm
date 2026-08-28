# Static site image: Next.js `output: "export"` builds plain files into ./out and
# nginx serves them. No Node process at runtime — the pages talk to the RocketRide
# engine directly. NEXT_PUBLIC_* values are inlined at build time (build ARGs).

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN mkdir -p public
ARG NEXT_PUBLIC_ROCKETRIDE_URI=http://127.0.0.1:5567
ARG NEXT_PUBLIC_ROCKETRIDE_APIKEY=MYAPIKEY
ENV NEXT_PUBLIC_ROCKETRIDE_URI=${NEXT_PUBLIC_ROCKETRIDE_URI}
ENV NEXT_PUBLIC_ROCKETRIDE_APIKEY=${NEXT_PUBLIC_ROCKETRIDE_APIKEY}
RUN npm run build

FROM nginx:alpine AS run
COPY --from=build /app/out /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
