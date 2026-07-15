#!/bin/sh
# 修复数据目录权限（Docker 卷可能由 root 创建）
if [ -d "/data" ]; then
  # A Railway/Docker volume is mounted at /data. Repair ownership once when the
  # container starts as root, then run the process as the unprivileged app user.
  if [ "$(id -u)" = "0" ]; then
    chown -R app:app /data
    exec su-exec app "$@"
  fi
fi

exec "$@"
