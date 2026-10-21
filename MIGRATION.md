# 迁移到另一台机器

一句话：**代码和扩展在 GitHub，配置与运行期数据不在**，用 `scripts/migrate.mjs` 打成一个包搬过去，就能做到无损。

## 先搞清楚哪些东西在 git 里

| 内容 | 在 git 里？ | 说明 |
|---|---|---|
| 核心代码 `src/`、界面 `ui/`、脚本 `scripts/`、测试 `test/` | ✅ | 正常 clone 就有 |
| 内置扩展 `plugins/master-absolute` 之类、`skills/README.md` | ✅ | 仓库自带的示例 |
| 插件 / 技能（`plugins/*`、`skills/*`） | ✅ | 1.1.30 起随仓库提交（12 个扩展）；若旧机器上还更新过版本，用导出包同步最稳 |
| **`data/config.json`** | ❌ | 模型 Key、白名单、人设、主人 QQ、协议端地址 —— 丢了等于重配 |
| `data/` 下的运行期数据 | ❌ | 额度账本、定时任务、扩展键值存储、表情库索引、插件存档…… |
| 历史（`sessions/` `messages/` `memory/`） | ❌ | 想要"聊天记忆也搬走"时用 `--with-history` |
| NapCat（协议端）、systemd 单元、node_modules | ❌ | 新机器用 `scripts/install.sh --systemd` 重建 |

## 迁移三步

### 1. 旧机器：导出

```bash
cd ~/qq-agent
node scripts/migrate.mjs export                # → qq-agent-migrate-<时间>.tgz（约 1~2MB）
# 想连聊天历史一起搬（体积会大不少）：
node scripts/migrate.mjs export --with-history
# 只想搬代码+扩展、不把模型 Key 放包里：
node scripts/migrate.mjs export --no-secrets
```

包里有什么：`data/config.json`、`plugins/` + `skills/`（2MB 级）、`data/` 运行期状态、
systemd 单元副本、`manifest.json`（版本/路径对照）。
默认**不含** `gallery-mirror`（GB 级图库缓存）、`whale-memes` 索引、日志、二维码 —— 都能重新拉。

### 2. 新机器：拿代码

```bash
git clone git@github.com:<你>/qq-agent.git ~/qq-agent    # 或者先 git push 再 clone
cd ~/qq-agent && npm install
bash scripts/install.sh --systemd                        # 装/配 NapCat + 注册 qq-agent.service
```

### 3. 新机器：导入

```bash
node scripts/migrate.mjs import qq-agent-migrate-<时间>.tgz          # 先看一眼计划：
node scripts/migrate.mjs import qq-agent-migrate-<时间>.tgz --dry-run # 不写盘，只打印要做的事
```

导入会：

- 把扩展解到 `plugins/` `skills/`（**已存在的目录默认跳过**，要覆盖加 `--force`）；
- 把 `data/` 写回去，`data/config.json` 里指向旧机器项目目录的绝对路径
  （如 `skills/voxcpm-voice/assets/reference.wav`）**自动改写成新目录**；
- 协议端目录：自动探测本机 NapCat 路径并改写 `config.snowluma.dir`；
- 覆盖前把旧配置备份成 `config.json.pre-import-<时间>`；
- 把 `voxcpm-voice_1` 这类安装器留下的 `_N` 目录名归一回清单 id；
- 最后检查配置里的绝对路径，列出在新机器上**不存在**的那些（要你手工改）。

## 迁移后检查清单

1. 打开 `http://127.0.0.1:3210` → 顶栏 OneBot 已连接；
2. **设置 → 模型 API / QQ 协议端**：确认 Key、Base URL、WS/HTTP 地址；
3. **设置 → 聊天白名单**：群号/好友号还在；
4. **技能页**：卡片数与旧机器一致、0 异常（异常会直接显示原因）；
5. 发一条消息试试（群里 @ 一下）。

## 常见坑

- **扩展版本对不上**：仓库里带的是提交时的版本；如果你在旧机器上又用「安装（zip）」覆盖更新过某个扩展，
  记得 `export` 一次再 `import`（导入时 `--force` 才会覆盖仓库里的版本）。
- **绝对路径**：模型目录、音乐目录、参考音频这类配置项在新机器上可能不存在，导入末尾会列出来。
- **协议端**：NapCat 是另一个程序（`napcat.service`），`scripts/install.sh` 会装；登录态需要重新扫码。
  二维码在控制台「协议端」页签。
- **systemd**：`qq-agent.service` 里的工作目录/路径是写死的，换机器请用 `install.sh --systemd` 重新生成，
  别直接拷旧的单元文件。包里留了一份 `reference/*.service` 仅供对照。
- **别把 `data/` 直接提交到 git**：里面有模型 Key、聊天记录、额度账本，`.gitignore` 已经挡住。
- **推送代码**：`git status` 显示 `ahead N` 说明本地提交还没上 GitHub，
  新机器 clone 到的是旧代码 —— 迁移前先 `git push`。
