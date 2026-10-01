# 字幕校订台镜像
# sql.js 为纯 WebAssembly 的 SQLite，无原生编译依赖
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/subtitles.db

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# 再拷业务代码
COPY src ./src
COPY public ./public

# 存储目录由卷挂载；应用启动时自动建库建表（初始化存储）
# chown 给 node 用户，保证挂载命名卷时可写
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

EXPOSE 3000

# 容器内以非 root 用户 node 运行
USER node

CMD ["node", "src/server.js"]
