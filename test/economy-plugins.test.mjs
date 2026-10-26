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
        tip: ['credit', 'transfer'],
        test: ['credit', 'debit', 'transfer']
      })
    },
    checkin: { enabled: true, baseReward: 20, streakBonus: 5, maxBonus: 50, resetHour: 0, showBalance: true, recallAfterSec: 1 },
    shop: { enabled: true, maxStock: 9999, allowNegativeStock: false, deliverNotice: '凭这条记录找管理员领取' },
    'red-packet': { enabled: true, maxTotal: 10000, maxCount: 20, expireSec: 300 },
    tip: { enabled: true, amount: 10, minGapMinutes: 60, maxPerDay: 8, source: 'mint' }
  },
  extensions: { hotReload: false }
}, null, 2));

const { loadPlugins } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
const { getTool } = await import(path.join(ROOT, 'src/tool-registry.js'));
const recalled = [];     // 记录 delete_msg 调用（签到回复 1 秒后自动撤回）
const fakeOnebot = { call: async (action, params) => { if (action === 'delete_msg') recalled.push(params.message_id); return {}; } };
await loadPlugins({ log: () => {}, deps: { getOnebot: () => fakeOnebot } });
for (const id of ['currency', 'checkin', 'shop', 'red-packet', 'tip']) {
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

// ②b 查余额：群友问一句就报自己的余额（不走模型）
{
  const r1 = await fire('checkin', ALICE, '余额');
  assert.equal(r1.sent.length, 1, '查余额应直接回一条');
  assert.match(r1.sent[0], /你现在有 20 金币/);
  assert.match(r1.sent[0], /连签 1 天/);
  assert.match(r1.sent[0], /今天已签/, '今天签过要说明');
  assert.deepEqual(r1.marked, [1], '查余额也要标已读');

  const r2 = await fire('checkin', BOB, '我的金币');
  assert.match(r2.sent[0], /你现在有 0 金币/, '没签过的人是 0');
  assert.match(r2.sent[0], /还没签到过/);

  for (const text of ['余额宝收益怎么样', '这个金币真难赚']) {
    const r = await fire('checkin', ALICE, text);
    assert.equal(r.sent.length, 0, `「${text}」不该被当成查余额`);
  }
  ok('查余额：「余额 / 我的金币」报自己的金币与连签，别的话不误触发');
}

// ②c 回复发送后按设置自动撤回（默认 10 秒，测试里配成 1 秒）
{
  await new Promise((r) => setTimeout(r, 1400));
  assert.ok(recalled.length >= 1, `应该撤回过消息，实际 ${recalled.length} 次`);
  assert.ok(recalled.every((id) => id === 1), '撤的应该是刚才那条回复的 messageId');
  ok(`回复自动撤回：${recalled.length} 条按设置延迟撤回（delete_msg）`);
}

// ③ 商店：每个商品三行（名称 / 金币 / 介绍），商品之间空一行
{
  const r = await fire('shop', BOB, '商店');
  assert.equal(r.sent.length, 1, '清单应该是一条消息');
  const blocks = r.sent[0].split('\n\n');
  assert.ok(blocks.length >= 3, `应该多个商品块，实际 ${blocks.length} 块`);
  for (const block of blocks) {
    const lines = block.split('\n');
    assert.ok(lines.length >= 2, `每个商品至少两行（名称/金币），实际：${JSON.stringify(lines)}`);
    assert.ok(!/金币/.test(lines[0]), `第一行是商品名，不该带金币：${lines[0]}`);
    assert.match(lines[1], /^\d+ 金币/, `第二行是价格+金币：${lines[1]}`);
    if (lines[2] !== undefined) assert.match(lines[2], /^- /, '第三行是介绍，前面带「-」');
  }
  assert.match(r.sent[0], /点歌券\n50 金币\n- /, '点歌券：名称 / 50 金币 / - 介绍');
  ok(`商店：一条消息 ${blocks.length} 个商品块，每块「名称 / 价格 金币 / 介绍」，块间空行`);
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

// ⑪ 打赏：机器人觉得谁的话有意思，给那条消息的作者发 10 金币（走模型，但硬约束在插件里）
{
  const tipTool = getTool('tip__tip_reward');
  assert.ok(tipTool, 'tip__tip_reward 工具应注册');
  const tipSkill = skillManager.registry.get('tip');
  assert.ok(typeof tipSkill.handleUiRequest === 'function', 'tip 应导出 handleUiRequest');

  // 造一轮真实发言：DAVE 说了句有梗的话
  const DAVE = '20011';
  const ctx = {
    chatKey: SCOPE, kind: 'group', chatId: '123456', selfId: '99999',
    session: { status: 'running', chatKey: SCOPE, trigger: [
      { id: 1, mid: '8800001', senderId: DAVE, senderName: '丁', self: false, ts: Date.now() },
      { id: 2, mid: '8800002', senderId: '99999', senderName: '我', self: true, ts: Date.now() }
    ] },
    sender: {}, store: {}
  };
  const before = balOf(DAVE);
  const r1 = JSON.parse(String((await tipTool.execute(ctx, { messageId: '8800001', reason: '这梗我服' })).content).split('\n')[0]);
  assert.equal(r1.ok, true, '打赏应成功');
  assert.equal(r1.amount, 10, '每笔 10 金币（按设置）');
  assert.equal(balOf(DAVE), before + 10);

  const r2 = JSON.parse(String((await tipTool.execute(ctx, { messageId: '8800001' })).content).split('\n')[0]);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /已经打赏过/);
  assert.equal(balOf(DAVE), before + 10, '同一条消息不能重复打赏');

  const r3 = JSON.parse(String((await tipTool.execute(ctx, { messageId: '8800002' })).content).split('\n')[0]);
  assert.match(r3.reason, /不能打赏自己/);

  // 同一个人一小时内第二次（换条消息）要被冷却拦住
  ctx.session.trigger.push({ id: 3, mid: '8800003', senderId: DAVE, senderName: '丁', self: false, ts: Date.now() });
  const r4 = JSON.parse(String((await tipTool.execute(ctx, { messageId: '8800003' })).content).split('\n')[0]);
  assert.equal(r4.ok, false);
  assert.match(r4.reason, /刚打赏过/);

  // 金额上限：模型想给 999 也只给 10
  const EVE = '20012';
  ctx.session.trigger.push({ id: 4, mid: '8800004', senderId: EVE, senderName: '戊', self: false, ts: Date.now() });
  const r5 = JSON.parse(String((await tipTool.execute(ctx, { messageId: '8800004', amount: 999 })).content).split('\n')[0]);
  assert.equal(r5.amount, 10, '模型加码也会被压回设置上限');

  const panel = await tipSkill.handleUiRequest({ action: 'tips', payload: { chatKey: SCOPE } });
  assert.equal(panel.ok, true);
  assert.equal(panel.today.count, 2, '今天 2 笔');
  assert.equal(panel.rows.length, 2);
  ok('打赏：+10 到账 / 同一条不能重复 / 冷却 60 分钟 / 打赏自己拒绝 / 金额被压回上限 / 面板有记录');
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n经济插件（确定性）${pass} 项检查通过 ✅`);
