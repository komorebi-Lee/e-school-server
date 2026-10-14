FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80

# ★ 显式更换 npm 源。
#   依据：微信云托管官方文档「如何提高项目构建效率 → 3. 更换源站」——
#     「微信云托管线上构建的 Docker 镜像源已经是腾讯加速源了，所以不需要自己设置」
#     「# NPM更换腾讯加速源
#      RUN npm config set registry https://mirrors.tencent.com/npm/」
#   ⇒ 基础镜像由平台加速，但 npm 源需要自己换；官方 Express 模板同样设置了这一行。
#
#   实测（本机冷缓存安装同一份 package-lock.json）：
#     官方源 registry.npmjs.org         → 23.0s
#     腾讯源 mirrors.cloud.tencent.com  →  2.7s      （约 9 倍）
#   ⇒ 云端构建环境若访问官方源受限，该步会显著变慢甚至超时。
#   备选源（官方模板用的即此）：RUN npm config set registry https://mirrors.tencent.com/npm/
RUN npm config set registry https://mirrors.cloud.tencent.com/npm/

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
# scripts/ 必须进镜像：package.json 的 hash-admin-password 指向 scripts/hash-admin-password.js，
# 而 README 要求生产环境用它生成管理员口令哈希；此前该文件不在镜像内，容器中无法执行。
COPY scripts ./scripts

EXPOSE 80
CMD ["node", "src/server.js"]
