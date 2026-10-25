// 经济三件套（签到 / 商店 / 红包）确定性钩子测试。
// 这三个插件现在**不走模型**：命中触发词就地记账 + 回复 + 标记已读。
// 这里直接调它们的 onMessage 钩子，断言"回复了什么"和"余额变了多少"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-econ-'));
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
process.env.TZ = 'Asia/Shanghai';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
  skills: {
    currency: {
      enabled: true, currencyName: '金币', ownerQq: '10001', transfersEnabled: true,
      integrationPermissions: JSON.stringify({
        checkin: ['credit'],
        shop: ['reserve', 'capture', 'release', 'credit', 'debit', 'transfer'],
        'red-packet': ['transfer'],
        test: ['credit', 'debit', 'transfer']
      })
    },
    checkin: { enabled: true, baseReward: 20, streakBonus: 5, maxBonus: 50, resetHour: 0, showBalance: true },
    shop: { enabled: true, maxStock: 9999, allowNegativeStock: false, deliverNotice: '凭这条记录找管理员领取' },
    'red-packet': { enabled: true, maxTotal: 10000, maxCount: 20, expireSec: 300 }
  },
  extensions: { hotReload: false }
}, null, 2));

const { loadPlugins } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
await loadPlugins({ log: () => {} });
for (const id of ['currency', 'checkin', 'shop', 'red-packet']) {
  try { skillManager.activate(id, {}); } catch (e) { console.log('激活失败', id, e?.message ?? e); }
}

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const SCOPE = 'group:123456';
const ALICE = '20001';
const BOB = '20002';
const CAROL = '20003';

/** 造一个"像宿主那样"的 onMessage ctx：sender 捕获回复，store 记录已读。 */
function ctxOf(userId, text) {
  const sent = [];
  const ctx = {
    chatKey: SCOPE, kind: 'group', chatId: '123456',
    text, senderId: userId, senderName: '测试', atSelf: false, replyToSelf: false,
    entry: { id: 1 },
    sender: { sendTextBatch: async (_k, t) => { sent.push(String(t)); return { sent: [{ messageId: 1 }] }; } },
    store: { marked: [], markEntryRead(_k, id) { this.marked.push(id); return true; } },
    onebot: { selfId: '99999', selfNickname: '测试Bot' }
  };
  return { ctx, sent };
}

/** 调某个插件的 onMessage 钩子。 */
async function fire(pluginId, userId, text) {
  const skill = skillManager.registry.get(pluginId);
  assert.ok(skill?.hooks?.onMessage, `${pluginId} 应该有 onMessage 钩子`);
  const { ctx, sent } = ctxOf(userId, text);
  await skill.hooks.onMessage(ctx);
  return { sent, marked: ctx.store.marked };
}

const money = () => {
  const provs = skillManager.getCapabilityProviders('currency.v1', {});
  assert.equal(provs.length, 1, 'currency.v1 应有提供者');
  const client = provs[0].fn({ consumer: 'test' });
  assert.ok(client, 'currency.v1 提供者应返回 client（确认已激活）');
  return client;
};
const balOf = (uid) => money().balance({ scope: SCOPE, userId: uid }).balance;

// ① 签到：直接回复 + 到账
{
  const r = await fire('checkin', ALICE, '签到');
  assert.equal(r.sent.length, 1, '签到应直接回一条');
  assert.match(r.sent[0], /签到成功/);
  assert.match(r.sent[0], /\+20 金币/);
  assert.match(r.sent[0], /余额 20/);
  assert.deepEqual(r.marked, [1], '应把这条消息标已读（避免模型再回一遍）');
  assert.equal(balOf(ALICE), 20);
  ok('签到：不走模型直接回「签到成功 +20 金币，余额 20」，并标记已读');
}

// ② 同一天重复签到：不再发钱
{
  const r = await fire('checkin', ALICE, '签到');
  assert.match(r.sent[0], /已经签过/);
  assert.equal(balOf(ALICE), 20, '重复签到不能发钱');
  ok('重复签到只回复「今天已经签过」，不重复发币');
}

// ③ 商店：一行一个商品，带说明和金币单位
{
  const r = await fire('shop', BOB, '商店');
  assert.equal(r.sent.length, 1);
  const lines = r.sent[0].split('\n');
  assert.ok(lines.length >= 3, `清单应该多行，实际 ${lines.length} 行`);
  assert.match(lines[0], /· \d+ 金币/);
  assert.ok(lines.every((l) => /金币/.test(l)), '每行都要带「金币」单位');
  assert.match(r.sent[0], /——/, '要带说明');
  ok(`商店：一条消息 ${lines.length} 行，每行「商品 · 价格 金币（剩 N） —— 说明」`);
}

// ④ 兑换：扣钱 + 回复余额
{
  money().credit({ scope: SCOPE, userId: BOB, amount: 200, requestId: 'seed:bob', reason: '测试充值' });
  const before = balOf(BOB);
  const r = await fire('shop', BOB, '兑换 点歌券');
  assert.equal(r.sent.length, 1, '兑换应直接回一条');
  assert.match(r.sent[0], /兑换成功/);
  assert.match(r.sent[0], /点歌券/);
  assert.match(r.sent[0], /50 金币/);
  assert.equal(balOf(BOB), before - 50, '应按商品价格扣钱');
  assert.match(r.sent[0], new RegExp(`余额 ${before - 50}`));
  ok(`兑换：扣 50 金币（${before} → ${before - 50}），一条消息回「兑换成功…余额…」`);
}

// ⑤ 余额不足：不扣钱、说清原因
{
  const before = balOf(CAROL);
  const r = await fire('shop', CAROL, '兑换 自定义称号');
  assert.match(r.sent[0], /余额不够/);
  assert.equal(balOf(CAROL), before);
  ok('余额不足时回复「余额不够」，不扣钱');
}

// ⑥ 不存在的商品 / 不看清单也行
{
  const r = await fire('shop', BOB, '兑换 不存在的券');
  assert.match(r.sent[0], /没有「不存在的券」/);
  ok('兑换不存在的商品会提示先看清单');
}

// ⑦ 发红包 + 抢红包
{
  money().credit({ scope: SCOPE, userId: ALICE, amount: 300, requestId: 'seed:alice', reason: '测试充值' });
  const aliceBefore = balOf(ALICE);
  const send = await fire('red-packet', ALICE, '发红包 100 5份');
  assert.equal(send.sent.length, 1);
  assert.match(send.sent[0], /红包发好了/);
  assert.match(send.sent[0], /100 金币/);
  assert.match(send.sent[0], /5 份/);

  const grab = await fire('red-packet', BOB, '抢红包');
  assert.equal(grab.sent.length, 1);
  assert.match(grab.sent[0], /抢到 \d+ 金币/);

  const again = await fire('red-packet', BOB, '抢红包');
  assert.match(again.sent[0], /已经抢过/);

  // 抢到多少，发红包的人就少多少（这一笔已经发生，所以基线要重新取）
  assert.equal(balOf(ALICE), aliceBefore - Number((grab.sent[0].match(/抢到 (\d+)/) || [])[1]), '抢到的金额由发红包的人出');
  const afterGrab = balOf(ALICE);
  const self = await fire('red-packet', ALICE, '抢红包');
  assert.match(self.sent[0], /自己发的红包抢不了/);
  assert.equal(balOf(ALICE), afterGrab, '自己抢不了，余额不变');
  ok('红包：发 100/5 份 → BOB 抢到 → 重复抢被拒 → 自己抢被拒');
}

// ⑧ 无关消息不该被这三个插件接走
{
  for (const text of ['今天天气不错', '商店里面的东西贵吗', '签到一下再说吧']) {
    const r1 = await fire('checkin', ALICE, text);
    const r2 = await fire('shop', ALICE, text);
    const r3 = await fire('red-packet', ALICE, text);
    assert.equal(r1.sent.length + r2.sent.length + r3.sent.length, 0, `「${text}」不该被确定性插件接走`);
  }
  ok('无关消息不误触发（只认精确触发词）');
}

// ⑨ 面板：商店增删改 + 签到榜 + 红包列表
{
  const shop = skillManager.registry.get('shop');
  const checkin = skillManager.registry.get('checkin');
  const rp = skillManager.registry.get('red-packet');

  const ov = await shop.handleUiRequest({ action: 'overview', payload: { scope: SCOPE } });
  assert.equal(ov.ok, true);
  assert.ok(ov.items.length >= 3);
  assert.ok(ov.orders.length >= 1, '应该有兑换订单');
  assert.ok(ov.stats.paidCount >= 1);

  const saved = await shop.handleUiRequest({ action: 'save-item', payload: { item: { id: 'vip', name: 'VIP 券', price: 999, stock: 2, desc: '测试', deliver: '', enabled: true } } });
  assert.equal(saved.ok, true);
  const ov2 = await shop.handleUiRequest({ action: 'overview', payload: { scope: SCOPE } });
  assert.ok(ov2.items.some((x) => x.id === 'vip'), '面板新增的商品应出现在清单里');

  const board = await checkin.handleUiRequest({ action: 'status', payload: { chatKey: SCOPE } });
  assert.equal(board.ok, true);
  assert.ok(board.rows.some((r) => r.userId === ALICE && r.streak === 1));

  const list = await rp.handleUiRequest({ action: 'list', payload: { chatKey: SCOPE } });
  assert.equal(list.ok, true);
  assert.ok(list.rows.length >= 1);
  ok('三个面板接口可用（商品增删改 / 签到榜 / 红包列表）');
}

// ⑩ 成员余额页（currency 的只读面板）：群成员里没账户的也给 0，按余额降序
{
  const currency = skillManager.registry.get('currency');
  assert.ok(typeof currency.handleUiRequest === 'function', '货币插件应导出 handleUiRequest');
  const d = await currency.handleUiRequest({
    action: 'members',
    payload: { scope: SCOPE, userIds: [ALICE, BOB, CAROL, '20009'] }   // 20009 从没开过户
  });
  assert.equal(d.ok, true);
  const byId = new Map(d.rows.map((r) => [String(r.userId), r]));
  assert.ok(byId.has('20009'), '没开过户的群成员也要出现在列表里（余额 0）');
  assert.equal(byId.get('20009').balance, 0);
  assert.ok(byId.get(ALICE).balance > 0, '有余额的人应显示真实金额');
  const balances = d.rows.map((r) => Number(r.balance) || 0);
  assert.deepEqual(balances, [...balances].sort((a, b) => b - a), '按余额降序');
  assert.equal(d.total, balances.reduce((s, b) => s + b, 0), '合计等于各行之和');
  ok(`成员余额页：${d.rows.length} 行（含未开户的 0），合计 ${d.total} ${d.currencyName}`);
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n经济插件（确定性）${pass} 项检查通过 ✅`);
