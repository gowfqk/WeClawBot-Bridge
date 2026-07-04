# === WeClawBot Bridge Dockerfile ===

FROM node:22-alpine

WORKDIR /app

# 安装依赖 + 构建
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
RUN npm ci && npm run build

# 生产阶段：清理源码和开发依赖
RUN rm -rf src/ tsconfig.json && npm ci --omit=dev

EXPOSE 3000

CMD ["node", "dist/index.js"]
