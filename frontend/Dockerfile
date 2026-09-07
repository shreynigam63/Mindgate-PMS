# Agentic PMS — web image: builds the React bundle, then serves it with
# nginx and reverse-proxies /api to the API container.
#
# WHY nginx AND NOT A SEPARATE ORIGIN: on Render the frontend is a static
# site on its own domain, so the bundle has to be told the API's hostname
# at build time (VITE_API_URL). On one EC2 box there is exactly one
# origin, and serving both from it is strictly better — no CORS, no
# rebuild when the hostname changes, and no mixed-content trap.
#
# So VITE_API_URL IS DELIBERATELY NOT SET IN THIS BUILD. Leaving it unset
# makes frontend/src/utils/api.jsx fall through to the relative '/api/v1',
# which nginx below proxies. Setting it here would actively break the
# deployment twice over: that file hardcodes an `https://` prefix in front
# of the value, so a plain-HTTP PoC box would emit https:// URLs that do
# not answer, and the value is inlined into the bundle at build time, so
# every hostname change would mean a rebuild rather than an nginx reload.

FROM node:22-alpine AS build
WORKDIR /app
# devDependencies are the build toolchain here (vite, tailwind, postcss),
# so this one is a full install — --omit=dev would leave nothing to build
# with. The API image is the opposite case and does omit them.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1
