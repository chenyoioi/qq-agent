export const MAX_AMOUNT = 1_000_000_000_000;
export const WRITE_METHODS = ['credit', 'debit', 'transfer', 'reserve', 'capture', 'release', 'refund'];
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function object(value) {
  if (!isObject(value)) fail('INVALID_ARGUMENT', '参数必须是对象。');
  return value;
}

export function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) {
    fail('INVALID_ARGUMENT', `${label}必须是 1~${max} 字的文本，不能有首尾空白或控制字符。`);
  }
  return value;
}

export function userId(value) {
  if (Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{4,11}$/.test(value)) fail('INVALID_ARGUMENT', '用户必须是有效 QQ 号。');
  return value;
}

export function scope(value) {
  if (typeof value !== 'string' || !/^(group|private):[1-9]\d{4,11}$/.test(value)) fail('INVALID_ARGUMENT', 'scope 必须是 group:群号 或 private:QQ号。');
  return value;
}

export function consumerId(value, internal = false) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || (!internal && value === 'currency')) {
    fail('INVALID_ARGUMENT', 'consumer 必须是扩展 ID；currency 为内部保留值。');
  }
  return value;
}

export function amount(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_AMOUNT) fail('INVALID_ARGUMENT', `金额必须是 1~${MAX_AMOUNT} 的整数。`);
  return value;
}

export function limit(value = 20) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail('INVALID_ARGUMENT', 'limit 必须是 1~100 的整数。');
  return value;
}

export function command(operation, consumer, args) {
  object(args);
  if (!WRITE_METHODS.includes(operation)) fail('INVALID_ARGUMENT', '未知操作。');
  const result = { operation, consumer: consumerId(consumer, true), scope: scope(args.scope),
    requestId: text(args.requestId, 'requestId', 160), reason: text(args.reason, 'reason', 200) };
  const fields = ['scope', 'requestId', 'reason'];
  if (['credit', 'debit', 'reserve'].includes(operation)) {
    result.userId = userId(args.userId); result.amount = amount(args.amount);
    fields.push('userId', 'amount');
  } else if (operation === 'transfer') {
    result.fromUserId = userId(args.fromUserId); result.toUserId = userId(args.toUserId); result.amount = amount(args.amount);
    if (result.fromUserId === result.toUserId) fail('INVALID_ARGUMENT', '不能给自己转账。');
    fields.push('fromUserId', 'toUserId', 'amount');
  } else {
    const key = operation === 'refund' ? 'transactionId' : 'reservationId';
    result[key] = text(args[key], key, 64);
    if (!/^[a-f0-9]{64}$/.test(result[key])) fail('INVALID_ARGUMENT', `${key} 格式无效。`);
    fields.push(key);
  }
  for (const key of Object.keys(args)) if (!fields.includes(key)) fail('INVALID_ARGUMENT', `未知参数：${key}`);
  return result;
}

export function settings(raw = {}) {
  object(raw);
  const currencyName = text(raw.currencyName ?? '金币', '货币名称', 20);
  const ownerQq = raw.ownerQq ?? '';
  if (typeof ownerQq !== 'string') fail('INVALID_CONFIG', '主人 QQ 必须是文本。');
  const owners = ownerQq.split(/[\s,，;；]+/).filter(Boolean).map(userId);
  let permissions;
  try { permissions = JSON.parse(raw.integrationPermissions ?? '{}'); }
  catch { fail('INVALID_CONFIG', '接入权限必须是合法 JSON 对象。'); }
  if (!isObject(permissions)) fail('INVALID_CONFIG', '接入权限必须是 JSON 对象。');
  for (const [id, methods] of Object.entries(permissions)) {
    consumerId(id);
    if (!Array.isArray(methods) || methods.some(method => !WRITE_METHODS.includes(method))) fail('INVALID_CONFIG', `扩展 ${id} 的权限名称无效。`);
  }
  const transfersEnabled = raw.transfersEnabled ?? true;
  if (typeof transfersEnabled !== 'boolean') fail('INVALID_CONFIG', '群友转账开关必须为布尔值。');
  return { currencyName, owners, permissions, transfersEnabled };
}
