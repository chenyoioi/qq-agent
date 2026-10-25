// 金币商店（合并进经济系统后的模块）
// 金币商店（消费 currency.v1）
//
// 三件事：
//   1. 商品清单存在本插件自己的 storage 里（key = `items`），控制台面板直接改这份数据；
//   2. 群友兑换时走「预扣 → 交付 → 结算」：余额不足就不发，交付失败退回预扣，
//      中途崩了还能按订单号恢复（订单里有 reservationId）。
//   3. 面板另开一条「手动发币/扣币/转账」给主人用（consumer 仍是 shop，权限走货币插件设置）。
//
// 幂等：一个订单三个幂等键（预扣/结算），都用订单号派生；重复点「确认兑换」不会重复扣钱。
import { randomInt } from 'node:crypto';
import { requester } from './context.js';

const DEFAULTS = { maxStock: 9999, allowNegativeStock: false, deliverNotice: '兑换成功，凭这条记录找管理员领取' };
const ITEMS_KEY = 'shop:items';
const ORDERS_KEY = 'shop:orders';
const SEQ_KEY = 'shop:seq';
/** 取本轮操作人（宿主 ctx 里没有 sender.userId，必须从 triggerEntries 解析）。 */
function actorOf(ctx) {
  const r = requester(ctx);
  return String(r.userId);
}


const num = (v, fb, min, max) => {
  const n = Math.floor(Number(v ?? fb));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

/** 默认商品：装上就能用，面板里可以随时改/删。 */
const DEFAULT_ITEMS = [
  { id: 'song', name: '点歌券', price: 50, stock: null, enabled: true, desc: '点一首歌让她唱（念唱）', deliver: '找她私聊说歌名即可，或者直接在群里点' },
  { id: 'meme', name: '表情包券', price: 20, stock: null, enabled: true, desc: '点一张梗鲸表情包', deliver: '在群里说「来张表情包」并报券号' },
  { id: 'mute-pass', name: '免禁言券', price: 200, stock: 10, enabled: true, desc: '被管理禁言时可以出示一次', deliver: '出示给管理员即可' },
  { id: 'custom-title', name: '自定义称号', price: 500, stock: 5, enabled: true, desc: '让管理员给你挂一个群称号', deliver: '把想要的称号发给管理员' }
];

let hostApi = null;
let storage = null;

function readSettings() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    maxStock: num(c.shopMaxStock ?? c.maxStock, DEFAULTS.maxStock, 0, 1e9),
    allowNegativeStock: (c.shopAllowNegativeStock ?? c.allowNegativeStock) === true,
    deliverNotice: String(c.shopDeliverNotice || c.deliverNotice || DEFAULTS.deliverNotice).slice(0, 200)
  };
}

/** 货币单位名：跟货币插件的 info() 走，拿不到就「金币」。 */
function currencyUnit() {
  try {
    const info = money()?.info?.();
    return (info && info.currencyName) ? String(info.currencyName) : '金币';
  } catch { return '金币'; }
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'shop' });
  return api && api.apiVersion === 1 ? api : null;
}

function loadItems() {
  const raw = storage?.get(ITEMS_KEY, null);
  if (Array.isArray(raw)) return raw;
  storage?.set(ITEMS_KEY, DEFAULT_ITEMS);
  return [...DEFAULT_ITEMS];
}

function saveItems(items) {
  storage?.set(ITEMS_KEY, items);
}

function loadOrders() {
  const raw = storage?.get(ORDERS_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

function saveOrders(orders) {
  // 只留最近 500 单，避免文件无限长
  storage?.set(ORDERS_KEY, orders.slice(-500));
}

function nextSeq() {
  const n = num(storage?.get(SEQ_KEY, 0), 0, 0, 1e12) + 1;
  storage?.set(SEQ_KEY, n);
  return n;
}

function normalizeItem(raw, fallbackId) {
  const name = String(raw?.name ?? '').trim();
  if (!name) throw new Error('商品名不能为空');
  const price = num(raw?.price, 0, 1, 1e12);
  if (!price) throw new Error(`「${name}」的价格要正整数`);
  const stockRaw = raw?.stock;
  const stock = stockRaw === null || stockRaw === undefined || stockRaw === '' ? null : num(stockRaw, 0, 0, 1e9);
  const id = String(raw?.id || fallbackId || `it${Date.now().toString(36)}${randomInt(100, 999)}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return {
    id: id || `it${Date.now().toString(36)}`,
    name: name.slice(0, 40),
    price,
    stock,
    enabled: raw?.enabled !== false,
    desc: String(raw?.desc || '').slice(0, 200),
    deliver: String(raw?.deliver || '').slice(0, 200)
  };
}

/** 找商品：先按 id，再按名字（允许模糊）。 */
function findItem(items, key) {
  const q = String(key || '').trim();
  if (!q) return null;
  const byId = items.find((it) => it.id === q);
  if (byId) return byId;
  const exact = items.find((it) => it.name === q);
  if (exact) return exact;
  const loose = items.filter((it) => it.name.includes(q) || q.includes(it.name));
  return loose.length === 1 ? loose[0] : null;
}

export function register(api) {
  hostApi = api;
  storage = api.storage;

  api.registerTool({
    id: 'shop_list',
    name: '看商店',
    category: 'economy',
    description: '列出本群金币商店的商品、价格、库存。有人问「有什么可以换/商店里有啥/XX 多少钱」时用。不发消息，结果要用 send_message 转述。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const items = loadItems().filter((it) => it.enabled !== false);
      const s = readSettings();
      const unit = currencyUnit();
      // 直接给一段"可以原样发出去"的清单：一行一个商品，带说明和单位。
      // 以前只回 JSON，模型会自己压缩成「点歌券50 表情包券20」——没单位、没说明，
      // 而且改价后它还会复用上一轮的说法。
      const lines = items.map((it) => {
        const price = `${it.price} ${unit}`;
        const stock = it.stock === null || it.stock === undefined ? '' : (Number(it.stock) > 0 ? `（剩 ${it.stock}）` : '（已售罄）');
        const desc = it.desc ? ` —— ${it.desc}` : '';
        return `${it.name} · ${price}${stock}${desc}`;
      });
      const text = items.length ? lines.join('\n') : '商店现在是空的';
      return {
        content: JSON.stringify({
          ok: true,
          unit,
          items: items.map((it) => ({ id: it.id, name: it.name, price: it.price, unit, stock: it.stock, desc: it.desc })),
          text,
          notice: s.deliverNotice,
          note: '把 text 原样作为一条 send_message 发出去（一行一个商品，保留说明与「金币」单位）。'
            + '不要压缩成一行、不要改成「名字+数字」、不要说「刚发过/往上翻」。'
            + '有人要买就让他说「兑换 XX」。'
        })
      };
    }
  });

  api.registerTool({
    id: 'shop_buy',
    name: '兑换商品',
    category: 'economy',
    description: '有人明确要买/兑换某个商品时调用。会真的扣金币并记录订单；库存不足或余额不足会失败。不发消息，结果要用 send_message 转述。',
    parameters: {
      type: 'object',
      properties: {
        item: { type: 'string', description: '商品名或商品 id' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: '数量，默认 1' }
      },
      required: ['item'],
      additionalProperties: false
    },
    async execute(ctx, args = {}) {
      const scope = String(ctx?.chatKey || '');
      let userId = '';
      try { userId = actorOf(ctx); } catch (error) {
        return { content: JSON.stringify({ ok: false, reason: String(error?.message || error) }), isError: true };
      }
      const currency = money();
      if (!currency) return { content: JSON.stringify({ ok: false, reason: '货币系统未启用或未授权 shop' }), isError: true };

      const s = readSettings();
      const items = loadItems();
      const item = findItem(items, args.item);
      if (!item) return { content: JSON.stringify({ ok: false, reason: `找不到商品「${args.item}」，先用 shop_list 看看有什么` }), isError: true };
      if (item.enabled === false) return { content: JSON.stringify({ ok: false, reason: `「${item.name}」已下架` }), isError: true };

      const count = num(args.count, 1, 1, 10);
      if (item.stock !== null && item.stock !== undefined) {
        const left = Number(item.stock) - count;
        if (left < 0 && !s.allowNegativeStock) {
          return { content: JSON.stringify({ ok: false, reason: `「${item.name}」库存不足（剩 ${item.stock}）` }), isError: true };
        }
      }

      const amount = item.price * count;
      const orderId = `od${Date.now().toString(36)}${randomInt(100, 999)}`;
      const requestBase = `订单:${orderId}`;

      // ① 预扣：余额不足直接失败，不做部分扣款
      const reserved = currency.reserve({
        scope, userId, amount,
        requestId: `${requestBase}:预扣`,
        reason: `购买 ${item.name}×${count}`
      });
      if (!reserved?.ok) {
        return { content: JSON.stringify({ ok: false, reason: reserved?.message || reserved?.code || '扣款失败' }), isError: true };
      }
      const reservationId = reserved.receipt?.id;
      if (!reservationId) {
        return { content: JSON.stringify({ ok: false, reason: '预扣没有返回订单号，已中止（余额未变动）' }), isError: true };
      }

      // ② 交付：扣库存 + 记订单 + 记进背包。先写本地再结算，
      //    这样即便后面结算失败，订单也在，能按订单恢复，不会出现"钱没扣但东西给了"的无记录状态。
      const order = {
        id: orderId,
        seq: nextSeq(),
        scope,
        userId,
        itemId: item.id,
        itemName: item.name,
        count,
        amount,
        status: 'delivered',
        reservationId,
        createdAt: Date.now()
      };
      try {
        const fresh = loadItems();
        const target = fresh.find((it) => it.id === item.id);
        if (target && target.stock !== null && target.stock !== undefined) {
          target.stock = Number(target.stock) - count;
          saveItems(fresh);
        }
        const orders = loadOrders();
        orders.push(order);
        saveOrders(orders);
        const bagKey = `shop:bag:${scope}:${userId}`;
        const bag = storage?.get(bagKey, []);
        const list = Array.isArray(bag) ? bag : [];
        list.push({ itemId: item.id, name: item.name, count, orderId, at: order.createdAt });
        storage?.set(bagKey, list.slice(-200));
      } catch (error) {
        // 交付写盘失败 → 释放预扣，别让钱冻着
        try { currency.release({ scope, reservationId, requestId: `${requestBase}:取消`, reason: '交付失败自动取消' }); } catch { /* 忽略 */ }
        return { content: JSON.stringify({ ok: false, reason: `交付失败，已退回预扣：${error?.message ?? error}` }), isError: true };
      }

      // ③ 结算：把预扣变成真扣款
      const captured = currency.capture({ scope, reservationId, requestId: `${requestBase}:结算`, reason: `购买 ${item.name}×${count}` });
      const orders = loadOrders();
      const mine = orders.find((o) => o.id === orderId);
      if (captured?.ok) {
        if (mine) { mine.status = 'paid'; mine.transactionId = captured.receipt?.id ?? null; saveOrders(orders); }
      } else if (mine) {
        // 结算失败：订单保留为 delivered（东西已交付、钱还冻着），面板上能看到并处理
        mine.status = 'settle-failed';
        mine.settleError = String(captured?.message || captured?.code || '结算失败').slice(0, 200);
        saveOrders(orders);
      }

      const bal = currency.balance({ scope, userId });
      return {
        content: JSON.stringify({
          ok: true,
          orderId,
          item: item.name,
          count,
          amount,
          balance: bal?.ok ? bal.balance : null,
          settled: captured?.ok === true,
          deliver: item.deliver || '',
          notice: s.deliverNotice,
          note: '兑换成功，用 send_message 简短告诉对方买到什么、花了多少、余额还剩多少。'
        })
      };
    }
  });

  api.registerTool({
    id: 'shop_my',
    name: '我的兑换记录',
    category: 'economy',
    description: '有人问「我买过什么/我的券呢」时用，查本人在本群的兑换记录与背包。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const scope = String(ctx?.chatKey || '');
      let userId = '';
      try { userId = actorOf(ctx); } catch (error) {
        return { content: JSON.stringify({ ok: false, reason: String(error?.message || error) }), isError: true };
      }
      const orders = loadOrders().filter((o) => o.scope === scope && o.userId === userId).slice(-20).reverse();
      const bag = storage?.get(`shop:bag:${scope}:${userId}`, []);
      return {
        content: JSON.stringify({
          ok: true,
          orders: orders.map((o) => ({ id: o.id, item: o.itemName, count: o.count, amount: o.amount, status: o.status })),
          bag: Array.isArray(bag) ? bag.slice(-20) : [],
          note: '用 send_message 挑重点说，不要逐条念。'
        })
      };
    }
  });
}

/** 控制台面板：读写商品、看订单、主人手动发币/扣币/转账。 */
export async function ui({ action, payload } = {}) {
  const currency = money();
  const p = payload && typeof payload === 'object' ? payload : {};

  if (action === 'overview') {
    const items = loadItems();
    const orders = loadOrders();
    const income = orders.filter((o) => o.status === 'paid').reduce((sum, o) => sum + o.amount, 0);
    return {
      ok: true,
      items,
      orders: orders.slice(-100).reverse(),
      stats: {
        itemCount: items.length,
        orderCount: orders.length,
        paidCount: orders.filter((o) => o.status === 'paid').length,
        unsettled: orders.filter((o) => o.status !== 'paid').length,
        income,
        currencyAvailable: !!currency
      },
      settings: readSettings()
    };
  }

  if (action === 'save-item') {
    const items = loadItems();
    const incoming = p.item || {};
    let saved;
    try {
      saved = normalizeItem(incoming, incoming.id);
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
    const idx = items.findIndex((it) => it.id === saved.id);
    if (idx >= 0) items[idx] = saved;
    else items.push(saved);
    saveItems(items);
    return { ok: true, item: saved, items };
  }

  if (action === 'delete-item') {
    const id = String(p.id || '');
    const items = loadItems();
    const next = items.filter((it) => it.id !== id);
    if (next.length === items.length) return { ok: false, error: '商品不存在' };
    saveItems(next);
    return { ok: true, items: next };
  }

  if (action === 'reset-items') {
    saveItems(DEFAULT_ITEMS.map((it) => ({ ...it })));
    return { ok: true, items: loadItems() };
  }

  if (action === 'adjust') {
    if (!currency) return { ok: false, error: '货币系统未启用或未授权 shop' };
    const op = String(p.op || '');
    const scope = String(p.scope || '');
    const userId = String(p.userId || '').trim();
    const amount = Number(p.amount);
    const reason = String(p.reason || '面板手动操作').slice(0, 200);
    if (!/^group:\d+$|^private:\d+$/.test(scope)) return { ok: false, error: 'scope 形如 group:123456' };
    if (!/^[1-9]\d{4,11}$/.test(userId)) return { ok: false, error: 'userId 需要真实 QQ 号' };
    // 查余额不需要金额；别的操作才校验
    if (op === 'balance') {
      try { return currency.balance({ scope, userId }); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    }
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: 'amount 需要正整数' };
    const base = `面板:${Date.now().toString(36)}${randomInt(100, 999)}`;
    try {
      if (op === 'credit') return currency.credit({ scope, userId, amount, requestId: `${base}:发`, reason });
      if (op === 'debit') return currency.debit({ scope, userId, amount, requestId: `${base}:扣`, reason });
      if (op === 'transfer') {
        const toUserId = String(p.toUserId || '').trim();
        if (!/^[1-9]\d{4,11}$/.test(toUserId)) return { ok: false, error: 'toUserId 需要真实 QQ 号' };
        return currency.transfer({ scope, fromUserId: userId, toUserId, amount, requestId: `${base}:转`, reason });
      }
      return { ok: false, error: 'op 只能是 credit / debit / transfer / balance' };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  if (action === 'rank') {
    if (!currency) return { ok: false, error: '货币系统未启用或未授权 shop' };
    const scope = String(p.scope || '');
    if (!/^group:\d+$/.test(scope)) return { ok: false, error: 'scope 形如 group:123456' };
    const r = currency.rank({ scope, limit: 20 });
    return r?.ok ? { ok: true, accounts: r.accounts, currencyName: r.currencyName } : { ok: false, error: r?.message || '查询失败' };
  }

  return { ok: false, error: `未知动作：${action}` };
}
