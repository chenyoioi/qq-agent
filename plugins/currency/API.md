# 货币系统开发接口 · currency.v1

面向接入奖励、商店和游戏的插件／技能开发者。安装与群聊用法见 [README](README.md)。

## 开发者：取得 API

在业务扩展清单中加入：

```json
{ "requires": ["currency.v1"] }
```

只需可选增强时可以省略 `requires`，在运行时处理未安装或未启用的情况。消费方通过能力名接入，不导入本插件代码、不直接访问账户数据文件。

```js
let hostApi;
export function setup(api) { hostApi = api; /* 在此注册自己的业务工具 */ }

// 在工具执行或业务任务运行时获取，不在 setup 时缓存。
async function completeQuest(ctx, savedEvent) {
  const money = hostApi.capability('currency.v1', { consumer: 'quest-reward' });
  if (!money || money.apiVersion !== 1) return { ok: false, code: 'UNAVAILABLE' };
  return await money.credit({
    scope: ctx.chatKey,
    userId: savedEvent.userId,
    amount: savedEvent.reward,
    requestId: `quest:${savedEvent.id}`,
    reason: '任务奖励'
  });
}
```

**宿主的 `api.capability(name, args)` 会直接调用提供者并返回 API 对象，不是返回一个待调用的函数。** 每次业务操作重新获取；缓存的旧 API 在停用、卸载、热重载或停用后重新启用时返回 `UNAVAILABLE`。每次调用仍检查宿主的生效状态。方法同步完成交易并返回对象，也兼容 `await`，不会让后台写入落后于成功结果。

TypeScript 类型见 [api.d.ts](api.d.ts)。可复制类型到消费方供编译使用，不需运行时依赖；[奖励示例](examples/reward.js)和[可恢复商店订单示例](examples/shop.js)随安装包分发，不会自动运行。

## API v1 契约

### 通用规则

- `scope`：`group:群号`。私聊可使用独立的 `private:QQ号` 分区，和所有群不互通。一次交易只涉及一个 scope，不提供跨群转账。
- `userId`：QQ 号文本，5~12 位正数字；为了兼容宿主内联工具解析，也接受可无损转换的安全整数。不要使用昵称。
- `amount`：最小货币单位的**正整数**，范围 `1~1000000000000`，账户总余额同样不能超过该上限。拒绝小数、负数、零、字符串金额、NaN、Infinity；不截断、不四舍五入、不自动部分扣款。
- `requestId`：业务事件唯一编号，1~160 字；`reason`：固定的业务原因，1~200 字；均不含首尾空白和控制字符。
- `consumer`：消费扩展 ID，1~64 位；`currency` 为内部保留值。
- `balance`：总余额；`held`：预扣冻结金额；`available = balance - held`：可以支付或转出的金额。
- 所有返回对象是副本；修改返回值不会修改账户数据。
- 成功：`{ ok: true, ...数据 }`；失败：`{ ok: false, code, message }`。必须检查 `ok`，不能把有返回值当成功。

### 查询（不需要写权限）

| 方法 | 参数 | 成功数据 |
| --- | --- | --- |
| `info()` | 无 | `apiVersion, currencyName, unit, maxBalance, permissions` |
| `balance()` | `scope, userId` | `scope, userId, balance, held, available, currencyName` |
| `history()` | `scope, userId, limit?, before?` | `receipts, nextBefore`，倒序；before 使用上页 nextBefore |
| `rank()` | `scope, limit?` | `accounts, currencyName`，总余额降序，同分按 QQ 文本排序 |
| `receipt()` | `scope, requestId` | 本 consumer 的 `receipt`，以及当前 `reservation` / `refundId`（无则 null） |
| `reservations()` | `scope, userId?, limit?, after?` | 本 consumer 的未结预扣 `reservations, nextAfter`，升序；after 使用上页 nextAfter |

`limit` 默认 20，上限 100。历史与排行包含该 scope 内其他消费方产生的数据；业务扩展负责仅向合适的聊天对象显示。账单中保存 QQ 与交易原因，不保存完整聊天正文。`receipt.entries` 是该笔交易当时的余额快照，重试返回快照不会变；要查最新余额再调用 `balance()`。`receipt()` 返回的预扣状态与退款编号则是查询时的当前状态。

### 写入（需要同名权限）

下表每个方法都要求 `scope, requestId, reason`：

| 方法 | 额外参数 | 行为 |
| --- | --- | --- |
| `credit` | `userId, amount` | 增发奖励 |
| `debit` | `userId, amount` | 直接扣款并销毁相应货币 |
| `transfer` | `fromUserId, toUserId, amount` | 双方原子记账，不增发、不收手续费 |
| `reserve` | `userId, amount` | 冻结可用余额；返回 receipt.id 作为 reservationId |
| `capture` | `reservationId` | 全额结算预扣，扣总余额并解除冻结 |
| `release` | `reservationId` | 全额取消预扣，只解除冻结 |
| `refund` | `transactionId` | 对成功 debit 或 capture 全额退款一次 |

写入成功返回 `{ ok: true, currencyName, receipt }`。receipt 含 `id, sequence, at, input, amount, entries, replayed`。原始命令含来源 consumer、scope、requestId 和 reason；每条 entries 含用户、余额变动、冻结变动和结果余额。

预扣只能由原 consumer 结算或释放，退款只能针对原 consumer 的扣款；内置主人维护工具可以释放其他扩展的遗留预扣。`capture` 和 `release` 互斥；新的 requestId 不能再次关闭同一预扣。只支持全额退款，不支持对 credit、transfer、reserve 或退款本身退款；转账需要退回时，创建一笔由收款方授权的新转账。退款也受账户余额上限约束，超过上限则失败，原扣款仍保持未退款，可处理余额后用相同请求重试。

### 幂等与重试

唯一键是 **consumer + scope + requestId**，不含方法名。同一键、完全相同参数再次调用，会返回首次成功的交易并置 `replayed: true`。换金额、用户、方法或 reason 都返回 `IDEMPOTENCY_CONFLICT`，不会再执行。

所有成功流水和唯一键永久保存在本地，**不按天过期、不为节省空间自动删旧去重记录**。余额不足、权限不足、保存失败等未成功操作不占用唯一键，修复后可以原参数重试。读回结果丢失时，可用 `receipt({ scope, requestId })` 核对，也可原参数重试。

业务扩展应在第一次写入前持久化事件 ID 和价格，或使用可确定复现的 ID，例如 `签到:用户:日期`、`任务完成:任务记录ID`、`订单:订单ID:步骤`。**不能用每次执行的新随机数、当前毫秒或新工具调用 ID 作为重试键。** 不能在错误后换 key 规避冲突。

### 商店交付与恢复

推荐流程：

1. 商店自己校验真实购买人、库存、价格和权限，持久化订单与固定 ID。
2. `reserve` 预扣；不足则不发货。
3. 商店用订单 ID 做可重复调用的 `grantOnce`，在自己的持久化存储中记录道具已交付。
4. 确认交付后 `capture`；确认永久未交付则 `release`。
5. 断连、超时或未知结果时保留订单和预扣，通过同一订单恢复，不能猜测失败后直接释放。

[shop.js](examples/shop.js)演示这套流程，专项测试覆盖“已发货但调用报错”“结算保存失败”后恢复，以及重复调用不再发货。生产消费方仍须实现持久化订单、库存去重、同单串行和恢复入口。

**货币交易事务只覆盖金币，不覆盖另一个扩展的背包或外部服务。** 货币底座无法自动保证跨扩展交付的原子性。预扣默认不自动到期、不后台退款，以免晚到的交付与自动释放竞争。消费方可用 `reservations` 分页检查自己的未结单。人工释放前必须停止该订单的交付与恢复任务，确认没有已交付结果；释放后不再继续发货。

退款仅恢复金币，商店需先处理道具回收和订单状态，再调用 `refund`；不能因为消息发送失败就退掉已交付道具的费用。

### 权限边界

QQ Agent 当前公开能力 API **不传递由宿主认证的调用扩展身份**。`consumer` 是调用者自己声明的来源标签，接入名单用于约束正常扩展、审计和避免误调用，不能阻止恶意代码冒用 ID、读取文件或绕过 API。只安装可信扩展；这里不声称提供插件沙箱。

货币 API 是受信扩展使用的服务接口，允许业务扩展指定 scope 与用户；它无法知道该业务是否得到群友授权。消费方必须绑定真实 `ctx.chatKey` 和操作人，校验付费意图与价格，**不要把带 credit/debit 权限的 API 原样暴露为任意模型参数工具**。建议只授予用得到的方法。

### 常见错误码

| code | 意义 / 处理 |
| --- | --- |
| `UNAVAILABLE` | 插件停用或旧 API 已失效；重新取得能力，不把 undefined 当成功 |
| `FORBIDDEN` | 未授权写方法或引用其他 consumer 的交易 |
| `INVALID_ARGUMENT` | 参数无效、金额非整数或不支持的操作；核对业务输入 |
| `INSUFFICIENT_FUNDS` | 可用余额不足，不会部分扣款 |
| `BALANCE_LIMIT` | 接收账户达到余额上限，转账双方均不改变 |
| `IDEMPOTENCY_CONFLICT` | 同一请求键的参数不一致；查原订单，不能换键重做 |
| `HOLD_CLOSED` / `ALREADY_REFUNDED` | 已结算/取消的预扣，或已退款的扣款 |
| `NOT_FOUND` | 当前 scope/consumer 下没有相关成功交易 |
| `STORAGE_ERROR` | 保存失败，本次未提交；恢复存储后用原参数重试 |
| `STORAGE_LOCKED` / `CORRUPT_DATA` | 写锁冲突或交易记录校验失败；停止写入。已退出进程的有效遗留锁在启用时自动回收；仍冲突或数据损坏时排查实例和文件 |

完整错误码和返回形状见 `api.d.ts`。`currency.v1` 对应 API 主版本；在 v1 中新增能力应保持已有参数、金额语义、幂等规则和错误码兼容，破坏性变更使用新的能力版本。

## 数据与运行边界

- 账户数据文件：宿主数据目录中的 `currency.json`，格式版本 1。优先采用 `QQ_AGENT_DATA_DIR`，其次遵循数字 `QQ_AGENT_PROFILE` 的 `data-N`，默认 `data`。不读取宿主聊天配置，也不依赖宿主 `src/`。
- 每笔交易同步完成：校验 → 计算全部变更 → 写临时文件并 fsync → 原子替换 → 更新内存 → 返回成功。转账接收方余额超限、磁盘写入失败时，双方都不变。停用不补交失败操作。
- 文件仅保存交易流水，启动时重放并校验每一笔，恢复账户、冻结、退款索引与幂等索引。结构或账目不一致则报错，**不自动清空数据**。这不是加密防篡改机制。
- 独占 `currency.json.lock` 防止两个实例同时写同一份账户数据；配套 `.lock.owner-<PID>-<UUID>` 归属文件隔离并发启动和遗留锁回收。正常停用或进程 `exit` 清理自己的锁；强制结束后，下次启用只回收 PID 已确定退出的锁，兼容旧版 `{pid,token}`。活进程、损坏或无法确认归属的锁不会被自动删除；同时启动可能相互退让，稍后重试即可。
- 使用同目录硬链接原子发布完整锁内容，数据目录需在支持硬链接的本机文件系统（如 NTFS）上。不接管宿主退出信号，也不依赖宿主调用扩展停用钩子。无法自动回收时，确认所有使用者已退出再排查锁与归属文件，保留账户数据。
- 清理失败时停止当前实例写入，并仅保留原路径与归属令牌供后续启用、释放或进程退出重试；热重载的新实例可重试已停止实例的清理。待清理记录不保存业务回调，重试始终核对主锁令牌，清理完成后移除清理监听。
- 适用于本机单宿主的中小规模娱乐经济。v1 每次保存完整流水，时间和空间随交易量增长，读取历史和排行也为本地扫描；不承诺高吞吐。大量交易的数据库后端和归档迁移应独立设计，不能直接删旧流水。
- 停用插件后备份整个 `currency.json`。热重载旧实例不能继续写；修改 `lib/` 后应重启宿主，以免 Node.js 的静态子模块缓存继续使用旧代码。
- 不注册发言奖励钩子、定时器或网络请求。交易算法本身不调用模型；自然语言工具调用仍消耗宿主正常主会话用量。

## 宿主规范与验证

使用公开的 providers、registerTool、api.config() 和 api.isSkillActive()；不导入宿主内部模块、不读取全局配置，也不复制宿主的工具开关规则。所有工具参数均有说明与边界，available() 保持同步，配置执行时读取。初始配置错误由 available() 报告；保存修正后即可恢复，无需重新启用。存储损坏或写锁冲突则需排查后重新启用。

真实宿主验证可指定本地 QQ Agent 源码目录；检查在独立临时数据目录运行，不启动 QQ 或网络服务：

```powershell
$env:QQ_CURRENCY_HOST_DIR = "D:\path\to\QQ-agent"
node --test test/plugins/currency/host-integration.test.js
```

未设置该路径时，普通测试会跳过真实宿主检查。测试代码可以导入宿主模块，安装包内的运行代码不依赖这些模块。

1.0.0 的实现在 QQ Agent 0.4.0 的隔离源码副本（提交 `11577baad321d1774caf0765d791c211072bfa83`）中通过真实加载器验证：能力依赖、初始错误配置的修复、开关、重载和交易恢复。该副本只安装 currency 时，宿主 `node test/tools-skill-audit.mjs` 的 31 项检查全部通过。未启动真实 QQ，也未进行群聊自然语言联调。

依据：[宿主插件开发](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/plugin-development.md)、[公共接口](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/skill-reference.md)、[能力调用实现](https://github.com/K0nd1us/QQ-agent/blob/main/src/plugin-loader.js)、[多实例](https://github.com/K0nd1us/QQ-agent/blob/main/doc/extend_development/multi-instance.md)。
