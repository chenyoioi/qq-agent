# qq-agent 控制台（仅 Node 服务；QQ 协议端用 napcat 容器）
FROM node:22-bookworm-slim

WORKDIR /app
ENV TZ=Asia/Shanghai \
    NODE_ENV=production \
    QQ_AGENT_HOST=0.0.0.0

# 依赖层（利用缓存）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# 代码
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
COPY test ./test
COPY skills ./skills
COPY plugins ./plugins
COPY data/config.example.json ./data/config.example.json

# 首次启动用模板生成配置（data/ 通常挂载为卷，已存在则保留用户配置）
RUN mkdir -p data && [ -f data/config.json ] || cp data/config.example.json data/config.json

EXPOSE 3210
CMD ["node", "src/server.js"]
