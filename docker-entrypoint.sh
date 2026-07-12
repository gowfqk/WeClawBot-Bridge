#!/bin/sh
# 修复数据目录权限（Docker 卷可能由 root 创建）
if [ -d "/app/.wechatbot-gateway" ]; then
  # 以 root 身份修复权限，再切换到 app 用户
  if [ "$(id -u)" = "0" ]; then
    chown -R app:app /app/.wechatbot-gateway
    exec su-exec app "$@"
  fi
fi

exec node dist/index.js
