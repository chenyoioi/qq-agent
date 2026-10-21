# 扩展系统（Skill / Plugin）

移植自 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) 的扩展运行时，与本仓库的内置工具、会话架构对接。

## 两种扩展，按“什么时候该运行”选

| 类型 | 放哪 | 入口 | 谁决定执行 |
|---|---|---|---|
| **Skill（LLM 型）** | `skills/<id>/` | `skill.json` + `index.js` 的 `setup(api)` → `api.registerTool(...)` | 模型自己判断 |
| **Plugin（确定性型）** | `plugins/<id>/` | `plugin.json` + `index.js` 导出 `providers` / `hooks` | 核心命中即执行，不经过模型 |

判据：**规则能写死 → 插件；要理解人话 → 技能**。放错目录不会报错，但功能会静默失效（加载器会给告警）。

## 目录结构

```
skills/example-dice/
  skill.json     清单（id/name/version/apiVersion/enabledByDefault/settings/configSchema/prompt）
  index.js       export function setup(api) { api.registerTool({...}) }

plugins/example-hook/
  plugin.json    清单（可声明 capabilities 与 requires）
  index.js       export const providers = {...}; export const hooks = {...}
```

## api（setup 收到的对象）

| 方法 | 说明 |
|---|---|
| `registerTool(def)` | 注册工具，自动加 `<skillId>__` 前缀；返回实际 id |
| `config()` | 读本扩展配置（manifest.settings 已合并）；**每次 execute 时读** |
| `isSkillActive(id)` | 查询其他扩展是否生效 |
| `capability(name, args)` | 软依赖：有提供者就调用，没有返回 `undefined` |
| `hasCapability(name)` | 能力是否有真实提供者 |
| `log/warn/error` | 带 `[skill:<id>]` 前缀 |
| `fetch` | 仅当清单声明 `permissions: ["web_fetch"]` 时可用 |
| `utils.sleep` / `utils.safeJsonParse` | 小工具 |

工具定义字段：`id`（会成为 OpenAI function name，字符集 `[a-zA-Z0-9_-]`）、`name`、`description`、`category`、`parameters`、`execute(ctx, args) → { content, isError }`。

## ctx（execute 拿到的东西）

`chatKey` / `kind` / `chatId` / `selfId` / `selfNickname` / `botName` / `persona` / `mode` / `onebot`（含 `call(action, params)` 透传 73 个 OneBot 接口）/ `store` / `memory` / `stickers` / `sender` / `session` / `emit` / `isMaster`。

发消息优先用 `ctx.sender`（带限频/分条/去重），别直接 `onebot.call('send_group_msg')`。

## 钩子（plugins/ 用）

| 钩子 | 时机 | 能做什么 |
|---|---|---|
| `before-context` | 组装提示词前 | 观察/记录，上下文对象可改 |
| `before-llm-messages` | messages 数组已建好 | 原地修改 messages（补知识片段、改系统提示尾部） |
| `before-tool` | 每次工具调用前 | 返回 `{ block: true, reason }` 可**否决**该次调用 |
| `after-tool` | 工具执行后 | 记录结果、做副作用 |
| `after-response` | 会话结束 | 统计、清理 |

钩子有 5 秒超时，失败只记日志，不影响主流程。

## 开关与配置

- 唯一开关：`config.skills[<id>].enabled`（控制台「技能」页或 `POST /api/skills/toggle`）
- 每扩展设置：`config.skills[<id>]` 下其他键，由 `settings` / `configSchema` 声明。
  控制台「⚙ 设置」抽屉就按 `configSchema` 渲染控件，可用的键：

  | 键 | 作用 |
  |---|---|
  | `label` / `title` | 字段名（两种写法都认） |
  | `description` / `hint` | 字段说明，显示在控件下方 |
  | `type` | `boolean`（开关）/ `number`（数字）/ `string` / `enum`（下拉）/ `array`（JSON 文本域） |
  | `values` / `options` | 枚举可选项（`select` + `options` 是早期写法，等价于 `enum` + `values`） |
  | `default` | 该字段默认值；没写时用 `settings` 里的同名值（「↺ 恢复默认」取它） |
  | `group` | 分组名（未写归「常规」），抽屉里按它折叠 |
  | `multiline` | 强制多行文本域（长文本/多值列表会自动变文本域） |
  | `secret` | 按密钥处理：密码框 + 显示/隐藏，回前端时掩码成 `******`（名字命中 key/token/cookie/secret/password 也会自动按密钥处理） |
  | `required` | 必填，空值会拦下保存 |
  | `min` / `max` / `step` | 数字范围与步长 |

  `settings` 里有、`configSchema` 里没声明的键（如配额守卫的 `perUser`）在抽屉的
  「其它（JSON）」高级区按 JSON 编辑，保存前会做 `JSON.parse` 校验。
- 工具总开关：`config.tools.enabled`；分类开关 `config.tools.categories.<category>`；单工具覆盖 `config.tools.overrides.<toolId>`
- 热重载：`config.extensions.hotReload`（默认 true），改动目录内文件自动重扫

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/skills` | 扩展列表 + 汇总 + 能力 + 已删除残留 |
| POST | `/api/skills/toggle` | `{ id, enabled }` |
| POST | `/api/skills/config` | `{ id, settings }`（只接受清单声明过的键） |
| POST | `/api/skills/reload` | 重扫磁盘（fs.watch 丢事件时用） |
| POST | `/api/skills/install` | `{ filename, dataBase64, type }`，zip 结构校验后解压 |
| POST | `/api/skills/uninstall` | `{ id, deleteFiles?: true }` |
| GET | `/api/tools` | 全部工具 + 每个工具的可用性与不可用原因 |

## 与原仓库的差异

| 项 | 状态 |
|---|---|
| tool-registry / skills / plugins / hooks / capabilities / 热重载 | ✅ 已移植 |
| 管理 API + 控制台「技能」页（列表/开关/设置/卸载/zip 安装） | ✅ 已移植 |
| `ctx.reminders` / `ctx.videoReader` | ⚠️ 本分支没有这两个模块，依赖它们的扩展需改写 |
| Skill 市场（kondius.cn 在线目录、账号登录、口令安装） | ⚠️ `src/market.js` 已随源码拷入，但未接 UI/路由 |

## 安全边界（变了）

Skill 是 Node ESM，**`import` 即执行任意本地代码**。原项目“无本地工具、不碰路径/凭据”的承诺在装了第三方扩展后不再成立：

- 只安装自己审过的扩展；
- `permissions: ["web_fetch"]` 只控制 `api.fetch`，不限制 `fs`/`child_process`（Node 里没有沙箱）；
- zip 安装只做结构校验（禁绝对路径/`..`/可执行文件/体积上限），不做代码审计。

## 扩展自带控制面板

插件可以在自己的 `ui/` 目录放页面，核心会把它们挂到：

```
/plugin-ui/<id>/index.html        → plugins/<id>/ui/index.html（或 skills/<id>/ui/）
POST /api/plugin-ui/<id>/action   → 调用插件的 handleUiRequest({ action, payload })
```

`handleUiRequest` 由插件入口导出即可，参数与返回值完全由插件定义；核心只负责静态文件与转发，
并做路径穿越校验。

## 能力：`chat.blocked-users`（本轮禁止回复的成员）

`chat.quota-gate` 决定"整轮要不要中止"；`chat.blocked-users` 回答"中止不了时该忽略谁"：

```js
'chat.blocked-users': (context) => ['123456']   // 本轮额度用尽、不许回复的 QQ 号
```

核心拿到名单后会：

1. 在用户提示词末尾追加【静默成员】，要求模型不回复、不引用、不 @ 他们；
2. 在 `send_message` 工具里兜底：`atUserId` 命中名单、或 `replyToMessageId` 指向他们的消息 → 直接报错拒绝；
3. 名单同时放在 `ctx.blockedUserIds`，供其它工具复用。

`quota-guard` 的实现（plugins/quota-guard/index.js）：
`before-context` 里把 `blockedIds: [...overQuota]` 写进 runInfo，并导出
`'chat.blocked-users': (ctx) => runStateFor(ctx)?.blockedIds || []`。

## 主人特权（quota-guard）

- `config.persona.masterQQ` 的人在额度判定里等同“不限”；
- 主人发 `重置 <QQ号>` 可把对方今日额度清零（保留真实用量 spent），机器人回确认且该轮零消耗；
- 钩子里要发消息用 `context.sender`（核心自 1.1.3 起在 `before-context` 里提供 `sender` / `onebot`）。

## 发送任意消息段（语音/视频等）

扩展里除了 `sendTextBatch` / `sendImage` / `sendSticker`，还可以用：

```js
await ctx.sender.sendMedia(ctx.chatKey, [{ type: 'record', data: { file: '/tmp/x.mp3' } }], { label: '[语音]' });
```

- 走同一条发送队列：串行、限频、留档；
- 本地绝对路径会自动补 `file://`（NapCat 对裸路径也认，但显式更稳）；
- 工具 id 带命名空间（`插件名__工具名`），模型用**裸名**调用时，核心会在唯一匹配时自动纠正。

## 兼容层与常用符号

扩展请统一从 `src/plugin-compat.js` 取小工具，避免核心重构后“装上了加载失败”：

```js
import { toFileUri, sleep, randInt, getConfig, DATA_DIR } from '../../src/plugin-compat.js';
```
