# 分发与部署给别人

这份仓库现在包含：原版 qq-agent + 扩展系统（Skill/Plugin）+ 控制台「技能」页 + 一键部署脚本 + Docker 方案。
给别人时有三种粒度，按对方的技术水平选。

---

## 方案 A：源码分发（推荐，最通用）

```bash
# 你这边（已在本机提交到一个分支）
git switch -c feat/extensions        # 如果还没建
git add <改动的文件>                  # 见下面的「不要提交的东西」
git commit -m "feat: 扩展系统（skills/plugins）+ 技能页 + 工具清单"

# 推到自己的 fork
git push -u origin feat/extensions
```

对方：

```bash
git clone https://github.com/<你的账号>/qq-agent.git
cd qq-agent
git switch feat/extensions
npm install --omit=dev
node src/server.js        # 或 bash scripts/install.sh --systemd 连 NapCat 一起装
```

- 优点：体积小、易 review、能持续合并上游更新；
- 缺点：对方要自己装 NapCat（`scripts/install.sh` 已经把这步包了）。

**离线交付**（没有 GitHub 权限时）：

```bash
git bundle create qq-agent.bundle --all       # 一个文件带走全部历史
# 对方：git clone qq-agent.bundle qq-agent
```

或者只给一个补丁：

```bash
git format-patch origin/main --stdout > extensions.patch
# 对方：git am extensions.patch
```

---

## 方案 B：一键脚本（适合“给我台 Linux，你装好”）

`scripts/install.sh` 会：

1. `apt` 装 xvfb + QQ 需要的 GUI 库 + 中文字体；
2. 下载 LinuxQQ deb 解压到 `~/napcat/opt/QQ`；
3. 下载 NapCat Shell 解压并注入（GitHub 直连失败自动走 `gh-proxy.com`）；
4. 写 OneBot 配置（本机 WS 3001 / HTTP 3000）；
5. `npm ci --omit=dev`，生成 `data/config.json`；
6. `--systemd` 时注册并启动两个服务，否则 `nohup` 后台起。

对方只需要：

```bash
git clone <仓库> qq-agent && cd qq-agent
bash scripts/install.sh --systemd
```

然后扫码（`~/napcat/opt/QQ/resources/app/app_launcher/napcat/cache/qrcode.png`）、
控制台 `http://127.0.0.1:3210`、填模型 Key。

> 脚本是幂等的：LinuxQQ/NapCat 已存在会跳过下载；`data/config.json` 存在则不覆盖。

---

## 方案 C：Docker（最干净，适合长期跑）

仓库带了 `Dockerfile` + `docker-compose.yml`：

```bash
docker compose up -d --build
```

- `qq-agent`：Node 22 镜像，只跑控制台，端口 3210；
- `napcat`：官方 `mlikiowa/napcat-docker`，端口 6099（WebUI），扫码登录；
- `data/`、`skills/`、`plugins/` 挂载在宿主机，升级容器不丢配置。

⚠️ 容器内 OneBot 端口不映射到宿主机，`data/config.json` 里要写服务名：

```json
"snowluma": { "wsUrl": "ws://napcat:3001", "httpUrl": "http://napcat:3000" }
```

（代码已支持 `QQ_AGENT_HOST=0.0.0.0`，镜像里默认开了；本机直接跑仍然只监听 127.0.0.1。）

---

## 方案 D：Electron 桌面版（给 Windows 小白用户）

这是原项目的形态，需要额外的打包工作（本仓库目前没有 electron-builder 配置）：

```bash
npm i -D electron-builder
npx electron-builder --win --x64
```

注意三点：

- 打包时要把 `skills/`、`plugins/` 一起带上（`extraResources`）；
- NapCat/QQ 仍然要单独装（Windows 用官方一键包）；
- 桌面版才有托盘/开机自启，headless 版没有。

---

## 提交前清理清单（重要）

**绝对不要提交：**

| 路径 | 原因 |
|---|---|
| `data/config.json` | 含模型 API Key |
| `data/messages/`、`data/sessions/`、`data/memory/` | 聊天记录与记忆，隐私 |
| `data/napcat-qrcode.png` | 登录二维码（含账号信息） |
| `data/account.json` | 市场账号 token |
| `data/whale-memes/` 等扩展缓存 | 运行期数据 |
| `node_modules/` | 依赖 |
| `~/napcat/` | 700MB 的 QQ，不进仓库 |

`.gitignore` 已经覆盖上面这些；`data/config.example.json` 是唯一可以提交的配置（无密钥）。

**关于第三方扩展：** `skills/reply-meme`、`skills/whale-memes`、`plugins/group-cost-report`、`plugins/repeat-echo` 是别人写的（作者见各自清单）。随仓库分发前先确认作者许可；不确定就只发机制、不发具体扩展——对方自己放目录即可。

---

## 版本与更新

- 你的改动建议单独一个分支（如 `feat/extensions`），上游更新照常 `git fetch upstream && git merge upstream/main`；
- 在 `package.json` 里升版本号，并维护一个 `CHANGELOG.md`；
- 对外说明「基于 K0nd1us/QQ-agent 与 Derpyu520/qq-bridge 改造（MIT）」，两个 LICENSE 都保留。

---

## 对方拿到后的最短路径

1. `bash scripts/install.sh --systemd`
2. 打开 `http://127.0.0.1:3210`（远端 `ssh -L 3210:127.0.0.1:3210`）
3. 扫码登录 QQ
4. 设置页填模型 API（baseUrl/key/model），点「测试一下」
5. 白名单勾群 → 存档页发测试消息
6. 想装扩展：把目录丢进 `skills/` 或 `plugins/`，或在「技能」页上传 zip

---

## 之后怎么保持最新

代码改动 → 本地提交 → `git push origin main` → 各部署机执行：

```bash
bash scripts/update.sh
```

`update.sh` 做四件事：`git fetch` + `reset --hard origin/main`（只覆盖跟踪文件，`data/`、`skills/`、`plugins/` 里的内容原样保留）→ `npm ci --omit=dev` → 重启服务 → `/api/status` 健康检查并打印扩展加载情况。

版本用 `git tag` 标记（当前 `v1.1.0`），需要回滚时：

```bash
git reset --hard v1.1.0 && npm ci --omit=dev && systemctl restart qq-agent
```
