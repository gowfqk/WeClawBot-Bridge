# === WeClawBot Bridge Dockerfile ===
# 多阶段构建：前端 + 后端

# ---- 阶段 1：构建前端 ----
FROM node:22-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build
# 产物输出到 /app/public/（vite.config.ts outDir）

# ---- 阶段 2：构建后端 + 最终镜像 ----
FROM node:22-alpine

WORKDIR /app

# 安装后端依赖
COPY package.json package-lock.json tsconfig.json ./
COPY src/ ./src/
COPY config/ ./config/
RUN npm ci && npm run build

# 复制前端产物
COPY --from=frontend-build /app/public/ ./public/

# 清理源码和开发依赖，仅保留运行时
RUN rm -rf src/ tsconfig.json && npm ci --omit=dev

# 创建非 root 用户运行应用，并预创建数据目录
RUN addgroup -S app && adduser -S app -G app && \
    mkdir -p /app/.wechatbot-gateway/gateway && \
    chown -R app:app /app

# 安装 su-exec 用于 entrypoint 降权
RUN apk add --no-cache su-exec

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

VOLUME ["/app/.wechatbot-gateway"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
