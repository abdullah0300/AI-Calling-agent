FROM node:20-slim

WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml* ./
COPY shared/ ./shared/

RUN pnpm install --frozen-lockfile --prod

COPY src/ ./src/
COPY tsconfig.json ./

RUN pnpm build

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

CMD ["node", "dist/index.js"]
