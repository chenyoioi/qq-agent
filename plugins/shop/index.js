// 金币商店（确定性插件：不走模型）
//
// 群里说「商店」→ 直接发商品清单（一行一个，带说明和金币单位）；
// 说「兑换 点歌券」→ 预扣 → 交付 → 结算，当场扣金币；说「我的兑换」→ 查自己的记录。
// 全部在 onMessage 钩子里完成并回复，然后把消息标已读，避免模型再回一遍。
import { randomInt } from 'node:crypto';

const DEFAULTS = { maxStock: 9999, allowNegativeStock: false, deliverNotice: '凭这条记录找管理员领取' };
const ITEMS_KEY = 'items';
const ORDERS_KEY = 'orders';
const SEQ_KEY = 'seq';

/** 默认商品：装上就能用，面板里可随时改/删。 */
const DEFAULT_ITEMS = [
  { id: 'song', name: '点歌券', price: 50, stock: null, enabled: true, desc: '点一首歌让她唱（念唱）', deliver: '在群里说「点歌 歌名」' },
  { id: 'meme', name: '表情包券', price: 20, stock: null, enabled: true, desc: '点一张梗鲸表情包', deliver: '在群里说「来张表情包」' },
  { id: 'mute-pass', name: '免禁言券', price: 200, stock: 10, enabled: true, desc: '被管理禁言时可以出示一次', deliver: '出示给管理员即可' },
  { id: 'custom-title', name: '自定义称号', price: 500, stock: 5, enabled: true, desc: '让管理员给你挂一个群称号', deliver: '把想要的称号发给管理员' }
];

const num = (v, fb, min, max) => {
  const n = Math.floor(Number(v ?? fb));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fb;
};

let hostApi = null;
let storage = null;
let log = () => {};

function conf() {
  const c = (() => { try { return hostApi?.config?.() ?? {}; } catch { return {}; } })();
  return {
    maxStock: num(c.maxStock, DEFAULTS.maxStock, 0, 1e9),
    allowNegativeStock: c.allowNegativeStock === true,
    deliverNotice: String(c.deliverNotice || DEFAULTS.deliverNotice).slice(0, 200)
  };
}

function money() {
  const api = hostApi?.capability?.('currency.v1', { consumer: 'shop' });
  return api && api.apiVersion === 1 ? api : null;
}

function unit() {
  try {
    const info = money()?.info?.();
    return info?.currencyName ? String(info.currencyName) : '金币';
  } catch { return '金币'; }
}

function loadItems() {
  const raw = storage?.get(ITEMS_KEY, null);
  if (Array.isArray(raw)) return raw;
  storage?.set(ITEMS_KEY, DEFAULT_ITEMS);
  return [...DEFAULT_ITEMS];
}
function saveItems(items) { storage?.set(ITEMS_KEY, items); }
function loadOrders() {
  const raw = storage?.get(ORDERS_KEY, []);
  return Array.isArray(raw) ? raw : [];
}
function saveOrders(list) { storage?.set(ORDERS_KEY, list.slice(-500)); }
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

function findItem(items, key) {
  const q = String(key || '').replace(/[券票]$/, '').trim();
  if (!q) return null;
  const byId = items.find((it) => it.id === q);
  if (byId) return byId;
  const exact = items.find((it) => it.name === q || it.name === String(key || '').trim());
  if (exact) return exact;
  const loose = items.filter((it) => it.name.includes(q) || q.includes(it.name));
  return loose.length === 1 ? loose[0] : null;
}

/**
 * 清单文本：每个商品三行 —— 名称 / 价格（金币）/ 介绍，商品之间空一行。
 * 例：
 *   点歌券
 *   50 金币（剩 3）
 *   点一首歌让她唱（念唱）
 */
function listText(items) {
  const u = unit();
  if (!items.length) return '商店现在是空的';
  return items.map((it) => {
    const stock = it.stock === null || it.stock === undefined ? '' : (Number(it.stock) > 0 ? `（剩 ${it.stock}）` : '（已售罄）');
    const lines = [it.name, `${it.price} ${u}${stock}`];
    if (it.desc) lines.push(it.desc);            // 没有介绍就不占行
    return lines.join('\n');
  }).join('\n\n');                              // 商品之间空一行，QQ 里好认
}

function cleanText(text) {
  return String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@\S+/g, ' ')
    .trim();
}

export function setup(api) {
  hostApi = api;
  storage = api.storage;
  log = api.log || (() => {});
}

async function reply(ctx, text) {
  try {
    ctx?.sender?.allowRateBypass?.(ctx.chatKey, 5000);   // 命令类回复不被限流吞掉
    if (typeof ctx?.sender?.sendTextBatch !== 'function') return;
    try {
      await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
    } catch (error) {
      // 发送偶发被 QQ 挡回（风控抖动）：等一秒再试一次；禁言这类硬失败会在第二次照样抛
      await new Promise((r) => setTimeout(r, 1200));
      await ctx.sender.sendTextBatch(ctx.chatKey, text, {});
      log(`重试后仍失败：${error?.message ?? error}`);
    }
  } catch (error) { log(`商店回复失败：${error?.message ?? error}`); }
}
function markHandled(ctx) {
  try { ctx?.store?.markEntryRead?.(ctx.chatKey, ctx?.entry?.id); } catch { /* 忽略 */ }
}

const LIST_TRIGGERS = ['商店', '商店有什么', '有什么可以换', '能换什么', '有啥可以换', '看看商店', '商品', '商店列表', '买什么'];

export const hooks = {
  async onMessage(ctx) {
    const raw = cleanText(ctx?.text);
    if (!raw) return;
    if (!/^group:\d+$/.test(String(ctx?.chatKey || ''))) return;
    const userId = String(ctx?.senderId || '').trim();
    if (!/^[1-9]\d{4,11}$/.test(userId)) return;
    const currency = money();
    if (!currency) return;

    const text = raw.replace(/[，。！？、,.!?~～\s]/g, '');

    // ① 看清单
    if (LIST_TRIGGERS.includes(text)) {
      const items = loadItems().filter((it) => it.enabled !== false);
      await reply(ctx, listText(items));
      markHandled(ctx);
      return;
    }

    // ② 我的兑换
    if (/^(我的兑换|我的券|我买过什么|我的订单|我的背包)$/.test(text)) {
      const orders = loadOrders().filter((o) => o.scope === ctx.chatKey && o.userId === userId).slice(-10).reverse();
      const u = unit();
      const body = orders.length
        ? orders.map((o) => `${o.itemName} ×${o.count} · ${o.amount} ${u}（${o.status === 'paid' ? '已扣款' : o.status}）`).join('\n')
        : '你还没兑换过东西';
      await reply(ctx, body);
      markHandled(ctx);
      return;
    }

    // ③ 兑换
    const m = /^(兑换|买|换)(.+)$/.exec(text);
    if (!m) return;
    const wanted = m[2].replace(/^(个|一个|一张|张|一份)/, '').trim();
    if (!wanted) return;

    const s = conf();
    const items = loadItems();
    const item = findItem(items, wanted);
    if (!item) {
      await reply(ctx, `没有「${wanted}」这个商品，先发「商店」看看能换什么`);
      markHandled(ctx);
      return;
    }
    if (item.enabled === false) {
      await reply(ctx, `「${item.name}」已经下架了`);
      markHandled(ctx);
      return;
    }
    if (item.stock !== null && item.stock !== undefined && Number(item.stock) <= 0 && !s.allowNegativeStock) {
      await reply(ctx, `「${item.name}」卖完了`);
      markHandled(ctx);
      return;
    }

    const amount = item.price;
    const orderId = `od${Date.now().toString(36)}${randomInt(100, 999)}`;
    const base = `订单:${orderId}`;
    const reserved = currency.reserve({ scope: ctx.chatKey, userId, amount, requestId: `${base}:预扣`, reason: `购买 ${item.name}` });
    if (!reserved?.ok) {
      const why = reserved?.code === 'INSUFFICIENT_FUNDS'
        ? `余额不够，${item.name}要 ${amount} ${unit()}`
        : (reserved?.message || '扣款失败');
      await reply(ctx, why);
      markHandled(ctx);
      return;
    }
    const reservationId = reserved.receipt?.id;
    if (!reservationId) {
      await reply(ctx, '扣款没有返回订单号，先不卖了');
      return;
    }

    try {
      const fresh = loadItems();
      const target = fresh.find((it) => it.id === item.id);
      if (target && target.stock !== null && target.stock !== undefined) {
        target.stock = Number(target.stock) - 1;
        saveItems(fresh);
      }
      const orders = loadOrders();
      orders.push({ id: orderId, seq: nextSeq(), scope: ctx.chatKey, userId, itemId: item.id, itemName: item.name, count: 1, amount, status: 'delivered', reservationId, createdAt: Date.now() });
      saveOrders(orders);
    } catch (error) {
      try { currency.release({ scope: ctx.chatKey, reservationId, requestId: `${base}:取消`, reason: '交付失败自动取消' }); } catch { /* 忽略 */ }
      await reply(ctx, '兑换没成功，钱已退回');
      log(`交付失败：${error?.message ?? error}`);
      return;
    }

    const captured = currency.capture({ scope: ctx.chatKey, reservationId, requestId: `${base}:结算`, reason: `购买 ${item.name}` });
    const orders = loadOrders();
    const mine = orders.find((o) => o.id === orderId);
    if (mine) {
      mine.status = captured?.ok ? 'paid' : 'settle-failed';
      if (captured?.ok) mine.transactionId = captured.receipt?.id ?? null;
      else mine.settleError = String(captured?.message || captured?.code || '结算失败').slice(0, 200);
      saveOrders(orders);
    }

    const bal = currency.balance({ scope: ctx.chatKey, userId });
    const bits = [`兑换成功：${item.name} · ${amount} ${unit()}`];
    if (bal?.ok) bits.push(`余额 ${bal.balance}`);
    if (item.deliver) bits.push(item.deliver);
    else if (s.deliverNotice) bits.push(s.deliverNotice);
    await reply(ctx, bits.join('，'));
    markHandled(ctx);
  }
};

/** 控制台面板：商品增删改、订单、手动发币/扣币/转账、财富榜。 */
export async function handleUiRequest({ action, payload } = {}) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const currency = money();

  if (action === 'overview') {
    const items = loadItems();
    const orders = loadOrders();
    return {
      ok: true,
      items,
      orders: orders.slice(-100).reverse(),
      stats: {
        itemCount: items.length,
        orderCount: orders.length,
        paidCount: orders.filter((o) => o.status === 'paid').length,
        unsettled: orders.filter((o) => o.status !== 'paid').length,
        income: orders.filter((o) => o.status === 'paid').reduce((sum, o) => sum + o.amount, 0),
        currencyAvailable: !!currency,
        unit: unit()
      },
      settings: conf()
    };
  }

  if (action === 'save-item') {
    const items = loadItems();
    const incoming = p.item || {};
    let saved;
    try { saved = normalizeItem(incoming, incoming.id); } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
    const idx = items.findIndex((it) => it.id === saved.id);
    if (idx >= 0) items[idx] = saved; else items.push(saved);
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
    } catch (error) { return { ok: false, error: String(error?.message ?? error) }; }
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
