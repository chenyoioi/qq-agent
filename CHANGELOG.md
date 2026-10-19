# 更新日志

## 1.1.8（2026-10-19）

### 新增：图库本地镜像

- `scripts/mirror-gallery.mjs`：把梗鲸图库（索引 + 原图/缩略图）镜像到 `data/gallery-mirror/`，
  断点续传、可重复执行，生成改写后的 `gallery-index.json`（本地文件存在才改本地 URL，否则保留远端）；
- 控制台新增 `/gallery/*` 静态路由（图片长缓存、索引 no-cache）；
- `whale-memes` / `reply-meme` 改为**本地索引优先、失败回源**，不再依赖这台机器慢速访问 Cloudflare。

好处：表情包不再受 55KB/s 的跨境带宽影响，索引和图片都是本机读盘。

## 1.1.7（2026-10-19）

### 修复：表情包“连不上图库”

根因是**网络栈**，不是插件：

- 这台机器没有可用 IPv6，而 `aigengtu.com` / `img.aigengtu.com` 在 Cloudflare 上同时返回 A/AAAA；
- Node 22 的 happy-eyeballs 每个地址只等 **250ms**，而这台机器连 Cloudflare 实际要 300~1300ms，
  于是所有地址都被判超时（curl 没这个机制所以能通）；
- 表现就是图库索引/图片 `fetch failed` 或 `aborted due to timeout`，机器人只能说“图库连不上”。

修复：

- 全局 fetch 的 undici Agent 固定 `family: 4`（`src/app.js`）；
- systemd 额外加 `NODE_OPTIONS=--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000`；
- 图库索引超时 15s→60s、单图下载超时 8s→20s（索引约 880KB，这台机器下行只有 ~55KB/s）；
- 图库索引刷新周期 12h→168h，减少无谓重试（本地已有 2100+ 张缓存）。

## 1.1.6（2026-10-19）

### 调整

- **后续消息间隔缩短**：8~15 秒（首条仍是即时），一条两句的回复不再等半分钟；
- **设置页新增「回复策略」表单**：开关、必回关键词、普通消息放行概率都可在控制台改，不用再手改 JSON；
- **人设换成「有爱版」**：温柔、记得人、先接住再说话，保留鲸鱼设定与短句风格，减少怼人和炸毛。
  旧版保留在 `docs/personas/compact-v1.md`，原始角色卡在 `docs/personas/original-2026-10-19.json`。

## 1.1.5（2026-10-19）

### 体验

- **修复首条回复延迟**：发送间隔原本算给了第一条（先等 25~45 秒，然后两条连着蹦出来），
  现在改成“第一条立刻发、后续每条按间隔停顿”；
- 会话详情显示**本轮拦截原因**（`已拦截 · quota-exhausted / rate-limited` + 文案），
  以前只能猜“为什么没回”；
- 技能页给自带 `ui/` 的扩展加「打开面板」按钮（quota-guard 的额度管理页可直接进）；
- 新增**每日自动备份**：`scripts/backup.sh` + `qq-agent-backup.timer`（04:30，保留 7 份）；
- journald 容量上限、2G swap（见 1.1.4）之外，补充了运维说明。

## 1.1.4（2026-10-19）

### 优化

- **停用空转的课程播报**：`scheduleNotify` 默认启用但课表文件不存在、目标 QQ 是占位号，
  每天产生 116 次读表失败 + 107 次推送失败 + 9 次发送限流（失败也会占用发送额度，
  直接挤占正常回复）。现在默认 `enabled:false`，要用时再配。
- **上下文裁剪**：`pastStateLimit` 80→40、`pastStateMaxChars` 6000→3000、`maxRounds` 12→8、
  `keepSessionFiles` 300→100。配合精简后的角色卡（12.3k→4.2k 字符），单次请求的静态开销明显下降。
- **日志容量**：journald 增加 `SystemMaxUse=200M` / `RuntimeMaxUse=100M`，防止无限增长。
- **内存兜底**：新增 2GB swapfile（`/swapfile`，写入 fstab）。

### 修复

- 引用机器人的消息现在也算“叫我”（`replyToSelf`），
  以前只认 `@` 段和关键词，别人引用它说的话时不会唤醒；
- quota-guard 的拦截日志只列**本轮**被剔除的人，不再把今天所有被拦过的人拼进去。

## 1.1.3（2026-10-18）

### 新增

- **主人不受额度限制**：`quota-guard` 的额度判定对 `config.persona.masterQQ` 直接返回“不限”（limit=0），
  主人不会被剔除、不会被静默、也不会让整轮被拦；
- **主人指令「重置 QQ号」**：主人发一条 `重置 123456` 即可把对方的今日额度清零（`used=0`，
  保留 `spent` 真实用量），机器人回一句确认，该轮**不请求模型**（零消耗）。
  非主人发同样的话不生效。

核心侧配套：`before-context` 钩子的上下文补了 `sender` / `onebot`，插件才能在钩子里发确认消息。

> 前提：`config.persona.masterQQ` 必须填成你的 QQ 号，否则“主人”判定为空，两条功能都不生效。

## 1.1.2（2026-10-18）

### 新增

- 扩展自带控制面板：`GET /plugin-ui/<id>/*` 静态页面 + `POST /api/plugin-ui/<id>/action` 转发到插件的 `handleUiRequest`
  （quota-guard 的额度管理页现在能打开了；此前 404）；
- 能力 `chat.blocked-users`：核心在提示词里声明【静默成员】，并在 `send_message` 里兜底拒绝 @/引用被拦者，
  **额度用尽的人一条都不回**（包括他单独触发的整轮零消耗）。

### 修复

- 发现并清理“游离实例”：早先 update.sh 走过非 systemd 分支，留下一个占着 3210 的孤儿进程，
  systemd 新实例退到 3211，两个进程同时连 OneBot —— 表现为“配额守卫时灵时不灵”。
  update.sh 现在先停 unit、清扫 `node src/server.js` 游离进程、启动后校验实例数。
- 启动日志误用 `summary.enabled`（应为 `active`）。

## 1.1.1（2026-10-18）

### 修复：Token 配额守卫（quota-guard）装了不生效

根因是**核心缺两个接线点**，插件只提供能力却没人调用，表现为“额度用超了照样聊”：

- `SendQueue.canSend(chatKey)`：只读的发送限流状态（不占用额度、不写记录）；
- `orchestrator.#runAgent`：在 `before-context` 之后、组装提示词之前调用能力 `chat.quota-gate`，
  返回 `{skip:true, code, reason}` 时**一条 LLM 请求都不发**就收尾；`#wake` 按 `noreply` 结束会话并记录拦截原因。

效果：超额用户的消息被插件从触发批剔除；整批都超额（或发送限流已满）时整轮零消耗。
插件判错时按“放行”处理，避免消息静默丢失。

新增 `test/quota-gate.test.mjs`（7 项）：能力解析、全员超额拦截、部分超额放行、额度 0 不限、`canSend` 只读、限流前置拦截。

## 1.1.0（2026-10-18）

本版把原仓库（K0nd1us/QQ-agent）的扩展运行时完整移植进来，并补了一套部署/分发方案。

### 新增：扩展系统（Skill / Plugin）

- `src/tool-registry.js`：工具注册表 + `getToolAvailability()` 统一可用性口径；
- `src/skills/*`：清单校验、能力注册、开关、状态机、钩子调度；
- `src/plugin-loader.js`：扫描 `skills/`（LLM 型）与 `plugins/`（确定性型），热重载；
- `src/zip-install.js`：zip 安装的结构校验（路径穿越 / 可执行文件 / 体积上限）；
- 钩子：`before-context`、`before-llm-messages`、`before-tool`（可否决）、`after-tool`、`after-response`；
- 能力：`llm.request-params` / `llm.response` / `llm.usage` / `tool.guard` / `media.download` 等；
- 内置 31 个工具改为注册进 registry，与扩展工具统一过滤。

### 新增：控制台

- 「技能」页：扩展列表、开关、设置、卸载、zip 安装、重新扫描、热重载提示；
- 「技能」页 → 工具清单：搜索、只看不可用、逐项开关、来源/分类/状态/不可用原因；
- 「设置 → 能力总览」：工具状态徽章（不可用 / 仅主人 / 仅学习模式），计数区分注册数与常规可用数；
- 新增 `/api/skills*`、`/api/tools`、`/api/tools/toggle` 接口。

### 修复

- zip 安装不识别插件类型 → 按包内 `plugin.json` 自动落 `plugins/`；
- 嵌套根目录（`x/x/skill.json`）导致加载失败 → 连续剥离统一根目录；
- 卸载只匹配 `skill.json`，插件删不掉 → 两种清单都匹配；
- 插件依赖原仓库的内部模块：补 `src/model-prices.js`；`llm.js` 补转换链，插件可裁剪本轮工具；
- 控制台只监听 127.0.0.1 → 支持 `QQ_AGENT_HOST` 覆盖（容器里用 0.0.0.0）。

### 部署与分发

- `scripts/install.sh`：一键装系统依赖 + LinuxQQ + NapCat + qq-agent，可选 systemd；
- `scripts/update.sh`：一条命令跟到 `origin/main` 并重启、健康检查；
- `Dockerfile` + `docker-compose.yml`（qq-agent + napcat）；
- `DEPLOY.md`、`EXTENSIONS.md`、`DISTRIBUTE.md` 三份文档；
- 测试：新增 `test/skills.test.mjs`（扩展 10 项 + 插件专项 5 项）。

### 安全提示

Skill 是 Node ESM，`import` 即执行任意本地代码；`permissions: ["web_fetch"]` 只限制 `api.fetch`。
只安装自己审过的扩展。
