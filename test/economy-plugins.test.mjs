// 经济三件套（签到 / 红包 / 商店）与货币系统的接线测试。
// 用临时 data 目录 + 真实插件（currency + checkin + shop + red-packet），不碰线上数据。
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
      enabled: true,
      currencyName: '金币',
      ownerQq: '10001',
      transfersEnabled: true,
      integrationPermissions: JSON.stringify({
        checkin: ['credit'],
        shop: ['reserve', 'capture', 'release', 'credit', 'debit', 'transfer'],
        'red-packet': ['transfer'],
        // 测试自己也要一个消费方来充值（权限名必须是货币插件认识的写方法）
        test: ['credit', 'debit', 'transfer']
      })
    },
    checkin: { enabled: true, baseReward: 20, streakBonus: 5, maxBonus: 50, resetHour: 0 },
    shop: { enabled: true },
    'red-packet': { enabled: true, maxTotal: 10000, maxCount: 20, expireSec: 300 }
  },
  extensions: { hotReload: false }
}, null, 2));

const { loadPlugins } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
const { getTool } = await import(path.join(ROOT, 'src/tool-registry.js'));

await loadPlugins({ log: () => {} });
// 宿主在 app.js 里对启用的扩展调 activate（能力才真正可用）；测试里手动补上
for (const id of ['currency', 'checkin', 'shop', 'red-packet']) {
  try { skillManager.activate(id, {}); } catch (error) { console.log('激活失败', id, error?.message ?? error); }
}

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };
const SCOPE = 'group:123456';
const ALICE = '20001';
const BOB = '20002';
const ctxFor = (userId) => ({
  chatKey: SCOPE, kind: 'group', chatId: '123456',
  sender: { userId }, senderId: userId, selfId: '99999'
});
const run = async (toolId, userId, args = {}) => {
  const tool = getTool(toolId);
  assert.ok(tool, `工具 ${toolId} 应已注册`);
  const r = await tool.execute(ctxFor(userId), args);
  let data = {};
  try { data = JSON.parse(String(r.content).replace(/\n[^\n]*$/, '')); } catch { data = { raw: String(r.content) }; }
  return { ...r, data };
};
const money = () => {
  const provs = skillManager.getCapabilityProviders('currency.v1', {});
  if (!provs.length) throw new Error('没有 currency.v1 提供者（插件未注册能力？）');
  const client = provs[0].fn({ consumer: 'test' });
  if (!client) throw new Error(`currency.v1 提供者返回 undefined（激活状态：${JSON.stringify(skillManager.isActive('currency', {}))}）`);
  return client;
};

// 货币系统可用（否则后面全白测）
assert.ok(money(), 'currency.v1 应可用');
ok('货币系统 currency.v1 已就绪');

// ① 签到：发钱 + 重试不多发
const c1 = await run('checkin__checkin', ALICE);
assert.equal(c1.data.ok, true);
assert.equal(c1.data.reward, 20, '首签应得基础奖励 20');
assert.equal(c1.data.streak, 1);
const bal1 = money().balance({ scope: SCOPE, userId: ALICE });
assert.equal(bal1.balance, 20);
ok('签到发金币 20，余额到账');

const c2 = await run('checkin__checkin', ALICE);
assert.equal(c2.data.ok, true);
assert.equal(c2.data.alreadyChecked, true, '同一天再签应提示已签');
assert.equal(money().balance({ scope: SCOPE, userId: ALICE }).balance, 20, '不能重复发钱');
ok('同一天重复签到不会重复发币（幂等）');

// ② 商店：兑换扣币、库存减少、余额正确
// 先给 ALICE 充点钱，不然签到那 20 买不起点歌券（真人也是先攒币）
money().credit({ scope: SCOPE, userId: ALICE, amount: 500, requestId: 'test:seed:alice-shop', reason: '测试充值' });
const shopList = await run('shop__shop_list', ALICE);
assert.equal(shopList.data.ok, true);
const song = (shopList.data.items || []).find((x) => x.id === 'song');
assert.ok(song, '默认应有「点歌券」');
const before = money().balance({ scope: SCOPE, userId: ALICE }).balance;
const buy = await run('shop__shop_buy', ALICE, { item: '点歌券', count: 1 });
assert.equal(buy.data.ok, true, `兑换应成功，实际：${JSON.stringify(buy.data)}`);
assert.equal(buy.data.amount, song.price);
const after = money().balance({ scope: SCOPE, userId: ALICE }).balance;
assert.equal(after, before - song.price, '兑换后余额应正好扣掉商品价格');
ok(`兑换「点歌券」扣 ${song.price} 金币（${before} → ${after}）`);

// ③ 商店：余额不足要失败且不扣钱
const poor = await run('shop__shop_buy', BOB, { item: '自定义称号', count: 1 });
assert.equal(poor.data.ok, false);
assert.match(String(poor.data.reason || ''), /余额|不足/);
assert.equal(money().balance({ scope: SCOPE, userId: BOB }).balance, 0, '失败不应扣钱');
ok('余额不足时兑换失败且不动余额');

// ④ 商店：库存卖完就买不到（用面板接口改库存，走的是宿主里那个实例）
const shopSkill = skillManager.registry.get('shop');
assert.ok(shopSkill && typeof shopSkill.handleUiRequest === 'function', 'shop 应导出 handleUiRequest');
{
  const overview0 = await shopSkill.handleUiRequest({ action: 'overview', payload: { scope: SCOPE } });
  const target = overview0.items.find((x) => x.id === 'custom-title');
  const saved = await shopSkill.handleUiRequest({ action: 'save-item', payload: { item: { ...target, stock: 1 } } });
  assert.equal(saved.ok, true);
}
// 给 BOB 充钱，先买走唯一一件，再买第二次应失败
money().credit({ scope: SCOPE, userId: BOB, amount: 2000, requestId: 'test:seed:bob', reason: '测试充值' });
const firstBuy = await run('shop__shop_buy', BOB, { item: '自定义称号', count: 1 });
assert.equal(firstBuy.data.ok, true, '第一次应买到');
const secondBuy = await run('shop__shop_buy', BOB, { item: '自定义称号', count: 1 });
assert.equal(secondBuy.data.ok, false);
assert.match(String(secondBuy.data.reason || ''), /库存/);
ok('库存卖完后第二次兑换被拒');

// ⑤ 红包：发送 + 两人抢 + 不能重复抢
money().credit({ scope: SCOPE, userId: ALICE, amount: 500, requestId: 'test:seed:alice', reason: '测试充值' });
const aliceBefore = money().balance({ scope: SCOPE, userId: ALICE }).balance;
const sent = await run('red-packet__send_red_packet', ALICE, { total: 90, count: 3 });
assert.equal(sent.data.ok, true, `发红包应成功：${JSON.stringify(sent.data)}`);
const packetId = sent.data.id;
const grabBob = await run('red-packet__grab_red_packet', BOB);
assert.equal(grabBob.data.ok, true, `BOB 应抢到：${JSON.stringify(grabBob.data)}`);
assert.ok(grabBob.data.amount >= 1);
const grabAgain = await run('red-packet__grab_red_packet', BOB);
assert.equal(grabAgain.data.ok, false, '同一人不能抢两次');
ok(`红包：BOB 抢到 ${grabBob.data.amount}，重复抢被拒`);

const carol = '20003';
const grabCarol = await run('red-packet__grab_red_packet', carol);
assert.equal(grabCarol.data.ok, true);
const aliceAfter = money().balance({ scope: SCOPE, userId: ALICE }).balance;
assert.equal(aliceAfter, aliceBefore - grabBob.data.amount - grabCarol.data.amount, '抢到多少就从发红包的人扣多少');
ok('红包金额：抢到的总额等于发送者扣掉的总额');

// ⑥ 面板动作：改商品 / 手动发币 / 排行
const shopMod = shopSkill;
const saveRes = await shopMod.handleUiRequest({ action: 'save-item', payload: { item: { id: 'vip', name: 'VIP 券', price: 999, stock: 3, desc: '测试', deliver: '', enabled: true } } });
assert.equal(saveRes.ok, true);
const overview = await shopMod.handleUiRequest({ action: 'overview', payload: { scope: SCOPE } });
assert.ok(overview.items.some((x) => x.id === 'vip'), '面板新增的商品应出现在清单里');
assert.ok(overview.orders.length >= 2, '面板应能看到订单');
assert.ok(overview.stats.paidCount >= 1);
ok('面板：新增商品、查看订单与统计');

const adjust = await shopMod.handleUiRequest({ action: 'adjust', payload: { op: 'credit', scope: SCOPE, userId: BOB, amount: 33, reason: '面板测试' } });
assert.equal(adjust.ok, true, `面板发币应成功：${JSON.stringify(adjust)}`);
ok('面板：手动发币成功');

const del = await shopMod.handleUiRequest({ action: 'delete-item', payload: { id: 'vip' } });
assert.equal(del.ok, true);
assert.ok(!del.items.some((x) => x.id === 'vip'));
ok('面板：删除商品');

// 转账（面板）：A 转给 B，双方余额同时变
{
  const aBefore = money().balance({ scope: SCOPE, userId: ALICE }).balance;
  const bBefore = money().balance({ scope: SCOPE, userId: BOB }).balance;
  const tr = await shopMod.handleUiRequest({
    action: 'adjust',
    payload: { op: 'transfer', scope: SCOPE, userId: ALICE, toUserId: BOB, amount: 40, reason: '面板转账测试' }
  });
  assert.equal(tr.ok, true, `转账应成功：${JSON.stringify(tr)}`);
  assert.equal(money().balance({ scope: SCOPE, userId: ALICE }).balance, aBefore - 40);
  assert.equal(money().balance({ scope: SCOPE, userId: BOB }).balance, bBefore + 40);
  ok('面板：转账 40 金币，双方余额同步变化');
}

const rank = await shopMod.handleUiRequest({ action: 'rank', payload: { scope: SCOPE } });
assert.equal(rank.ok, true);
assert.ok(rank.accounts.length >= 2);
ok('面板：财富榜可用');

// ⑦ 签到榜面板
const checkinMod = skillManager.registry.get('checkin');
const board = await checkinMod.handleUiRequest({ action: 'status', payload: { chatKey: SCOPE } });
assert.equal(board.ok, true);
assert.ok(board.rows.some((r) => r.userId === ALICE && r.streak === 1));
ok('签到榜面板可以读到签到记录');

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n经济插件 ${pass} 项检查通过 ✅`);
