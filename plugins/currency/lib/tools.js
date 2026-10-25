import { assertSession, chatScope, requester } from './context.js';
import { fail, MAX_AMOUNT, object, userId } from './validation.js';

const responseNote = '\n上述结果尚未发送到 QQ。请调用 send_message，按当前人设说明实际结果；不要编造余额、成功或收入规则。';
const idSchema = { type: 'string', pattern: '^[1-9]\\d{4,11}$', description: '真实 QQ 号；不接受昵称，不要猜测。' };
const messageSchema = { type: 'string', pattern: '^(?:-?\\d+|local:[1-9]\\d*)$', description: '提出本次操作的本轮真实消息编号，来自聊天记录；没有 QQ 编号时使用 local:本地编号。' };
const amountSchema = { type: 'integer', minimum: 1, maximum: MAX_AMOUNT, description: `正整数金额，1~${MAX_AMOUNT}；不能填小数或负数。` };
const limitSchema = { type: 'integer', minimum: 1, maximum: 100, description: '最多返回的条数，1~100，不填默认 20。' };
const reasonSchema = { type: 'string', minLength: 1, maxLength: 200, description: '本次操作的明确原因，1~200 字；重试必须保持原文相同。' };

export function registerTools(api, { service, readSettings, epoch, now }) {
  function register(id, name, description, properties, required, execute) {
    api.registerTool({ id, name, description: `${description} 工具不会发消息，完成后必须调用 send_message 告知实际结果。`, category: ['transfer', 'admin_adjust', 'admin_release'].includes(id) ? 'system' : 'query',
      parameters: { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) },
      async execute(ctx, args = {}) {
        const result = service.run(() => {
          object(args);
          for (const key of Object.keys(args)) if (!Object.hasOwn(properties, key)) fail('INVALID_ARGUMENT', `未知参数：${key}`);
          for (const key of required) if (args[key] === undefined || args[key] === null) fail('INVALID_ARGUMENT', `缺少必填参数：${key}`);
          assertSession(ctx);
          return execute(ctx, args, chatScope(ctx));
        }, epoch());
        return { content: JSON.stringify(result) + responseNote, ...(result.ok ? {} : { isError: true }) };
      }
    });
  }

  register('balance', '查询钱包', '有人明确问余额时使用。省略 userId 查询本轮发言者；多个发言者时先明确目标。', { userId: idSchema }, [],
    (ctx, args, scope) => service.read('balance', 'currency', { scope, userId: args.userId ?? requester(ctx).userId }, true));
  register('history', '查询货币流水', '有人要求核对收支时查看本群的真实流水，包含来源扩展和原因。', {
    userId: idSchema, limit: limitSchema, before: { type: 'integer', minimum: 1, description: '上一页 nextBefore，向前翻页；首次查询省略。' }
  }, [], (ctx, args, scope) => service.read('history', 'currency', { ...args, scope, userId: args.userId ?? requester(ctx).userId }, true));
  register('rank', '查询财富排行', '仅在有人明确问本群财富排行时查询，按总余额排序。', {
    limit: limitSchema
  }, [], (_ctx, args, scope) => service.read('rank', 'currency', { ...args, scope }, true));

  register('transfer', '转账', '仅执行实际发言者明确要求的转账，不替第三人转账，不接受引用或转述作为授权。核对收款 QQ 和正整数金额；每条请求消息只执行一次转账。', {
    toUserId: idSchema, amount: amountSchema, messageId: messageSchema
  }, ['toUserId', 'amount', 'messageId'], (ctx, args, scope) => {
    if (!readSettings().transfersEnabled) fail('FORBIDDEN', '群友转账已关闭。');
    const actor = requester(ctx, args.messageId, now());
    if (userId(args.toUserId) === String(ctx.selfId)) fail('INVALID_ARGUMENT', '不能给机器人账户转账。');
    return service.write('transfer', 'currency', { scope, requestId: `message:${actor.userId}:${actor.messageId}`,
      fromUserId: actor.userId, toUserId: args.toUserId, amount: args.amount, reason: '本人主动转账' }, true);
  });

  register('admin_adjust', '主人货币调账', '仅在本插件配置的主人明确要求发放或扣除金币时使用。普通群管理员、昵称和好感度均不授予权限。没有主人配置时不可用。', {
    operation: { type: 'string', enum: ['credit', 'debit'], description: 'credit 发放金币，debit 扣除金币；仅按主人的明确请求选择。' }, userId: idSchema,
    amount: amountSchema, reason: reasonSchema, messageId: messageSchema
  }, ['operation', 'userId', 'amount', 'reason', 'messageId'], (ctx, args, scope) => {
    const actor = requester(ctx, args.messageId, now());
    if (!readSettings().owners.includes(actor.userId)) fail('FORBIDDEN', '只有货币插件设置中的主人可调账。');
    if (!['credit', 'debit'].includes(args.operation)) fail('INVALID_ARGUMENT', '调账只支持 credit 或 debit。');
    return service.write(args.operation, 'currency', { scope, requestId: `message:${actor.userId}:${actor.messageId}`,
      userId: args.userId, amount: args.amount, reason: args.reason }, true);
  });

  register('holds', '查询未结订单', '查询当前群中尚未结算或释放的预扣款。普通用户只可查自己的订单，主人可指定其他人。', {
    userId: idSchema, after: { type: 'integer', minimum: 0, description: '上一页 nextAfter，向后翻页；首次查询省略或传 0。' }, limit: limitSchema
  }, [], (ctx, args, scope) => {
    const actor = requester(ctx);
    const target = userId(args.userId ?? actor.userId);
    if (target !== actor.userId && !readSettings().owners.includes(actor.userId)) fail('FORBIDDEN', '只能查看自己的未结订单。');
    return service.read('reservations', 'currency', { ...args, scope, userId: target }, true);
  });
  register('admin_release', '主人释放预扣款', '仅当主人核实订单已取消、不会继续交付并明确要求时，释放被扩展遗留的预扣款。不要自动清理正在交付的订单。', {
    reservationId: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'holds 返回的完整预扣款 id，64 位小写十六进制。' }, reason: reasonSchema, messageId: messageSchema
  }, ['reservationId', 'reason', 'messageId'], (ctx, args, scope) => {
    const actor = requester(ctx, args.messageId, now());
    if (!readSettings().owners.includes(actor.userId)) fail('FORBIDDEN', '只有货币插件设置中的主人可释放遗留订单。');
    return service.write('release', 'currency', { scope, requestId: `message:${actor.userId}:${actor.messageId}`,
      reservationId: args.reservationId, reason: args.reason }, true);
  });
}
