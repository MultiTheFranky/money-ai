# ---- Etapa 1: dependencias + build de TypeScript ----
FROM node:22-alpine AS builder

# Aplica los últimos parches de seguridad del SO base antes de instalar nada
RUN apk update && apk upgrade --no-cache

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Etapa 2: imagen final, solo con lo necesario para ejecutar ----
FROM node:22-alpine AS runner

RUN apk update && apk upgrade --no-cache

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node public ./public

# La clave privada (.pem) y el .env se montan como volúmenes en tiempo de ejecución,
# nunca se incluyen dentro de la imagen.
EXPOSE 3000

# Ejecuta como usuario sin privilegios en lugar de root
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1

CMD ["node", "dist/server.js"]
