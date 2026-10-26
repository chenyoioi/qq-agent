// 群通知插件：主人发「通知 内容」→ @全员 说一遍（不走模型）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-notice-'));
process.env.QQ_AGENT_DATA_DIR = DATA_DIR;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const MASTER = '1535743858';

fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify({
  persona: { botName: '大肥鱼', masterQQ: MASTER },
  allow: { groups: ['1062533151', '571522597'], private: [] },
  skills: { notice: { enabled: true, header: '📢 群通知', atAll: true, allowTargetGroup: true } }
}, null, 2));

// 假的发送队列：只记录调用，不真发
const sent = [];
const fakeSender = {
  calls: [],
  allowRateBypass() {},
  async sendTextBatch(chatKey, text, options = {}) {
    sent.push({ chatKey, text, options });
    return { sent: [{ text, messageId: 900 + sent.length }] };
  }
};

const { loadPlugins } = await import(path.join(ROOT, 'src/plugin-loader.js'));
const { skillManager } = await import(path.join(ROOT, 'src/skills/manager.js'));
await loadPlugins({ log: () => {}, deps: { getSender: () => fakeSender } });
skillManager.activate('notice', {});

const skill = skillManager.registry.get('notice');
assert.ok(skill?.hooks?.onMessage, 'notice 应该有 onMessage 钩子');

let pass = 0;
const ok = (m) => { pass++; console.log('  ✓ ' + m); };

function ctxOf(userId, text, chatKey = 'group:1062533151') {
  const marked = [];
  return {
    ctx: {
      chatKey, kind: 'group', chatId: chatKey.split(':')[1], text, senderId: userId, senderName: 'x',
      entry: { id: 7 },
      sender: fakeSender,
      store: { markEntryRead(_k, id) { marked.push(id); } }
    },
    marked
  };
}

// ① 主人发通知 → @全员 发出去
{
  sent.length = 0;
  const { ctx, marked } = ctxOf(MASTER, '通知 今晚 21 点群内开会，没到的踢出');
  await skill.hooks.onMessage(ctx);
  assert.equal(sent.length, 1, '应该发一条');
  assert.equal(sent[0].chatKey, 'group:1062533151', '默认发到当前群');
  assert.equal(sent[0].options.atAll, true, '要 @全员');
  assert.match(sent[0].text, /^📢 群通知\n/);
  assert.match(sent[0].text, /今晚 21 点群内开会/);
  assert.deepEqual(marked, [7], '要标记已读，模型不再重复回');
  ok('主人「通知 内容」→ @全员 发一条（带📢群通知开头），并标记已读');
}

// ② 别人发通知 → 不理会
{
  sent.length = 0;
  const { ctx, marked } = ctxOf('20002', '通知 我是群友我也想发');
  await skill.hooks.onMessage(ctx);
  assert.equal(sent.length, 0, '非主人不能发通知');
  assert.deepEqual(marked, [], '非主人不标记已读（交还给模型正常处理）');
  ok('非主人发「通知 …」不生效');
}

// ③ 指定别的群（白名单内）
{
  sent.length = 0;
  const { ctx } = ctxOf(MASTER, '通知 571522597 明天停服维护');
  await skill.hooks.onMessage(ctx);
  assert.equal(sent[0].chatKey, 'group:571522597', '应发到指定群');
  assert.match(sent[0].text, /明天停服维护/);
  assert.ok(!/571522597/.test(sent[0].text), '群号不该出现在正文里');
  ok('「通知 <群号> 内容」发到指定群（白名单内）');
}

// ④ 正文为空 → 提醒怎么发（而不是 @全员 发空通知）
{
  sent.length = 0;
  const { ctx } = ctxOf(MASTER, '通知');
  await skill.hooks.onMessage(ctx);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /要通知什么/);
  assert.notEqual(sent[0].options.atAll, true, '提醒不要 @全员');
  ok('只发「通知」两个字 → 反问内容，不 @全员');
}

// ⑤ 面板：手动发送 + 记录
{
  sent.length = 0;
  const r = await skill.handleUiRequest({ action: 'send', payload: { chatKey: 'group:1062533151', text: '第一行\n第二行', atAll: true } });
  assert.equal(r.ok, true, '面板发送应成功');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].options.atAll, true);
  assert.match(sent[0].text, /第一行\n第二行/);

  const list = await skill.handleUiRequest({ action: 'list', payload: { chatKey: 'group:1062533151' } });
  assert.equal(list.ok, true);
  assert.ok(list.rows.length >= 2, '记录里应有群里那条 + 面板这条');
  assert.ok(list.rows.some((x) => x.from === 'console'));
  assert.ok(list.rows.some((x) => x.from === 'chat'));
  ok(`面板：可手动发（保留换行、可 @全员），记录 ${list.rows.length} 条（群里+控制台）`);
}

// ⑥ @全员 的消息段真的拼出来了（不真的发：拦掉 fetch 看请求体）
{
  const { OneBotClient } = await import(path.join(ROOT, 'src/onebot.js'));
  const client = new OneBotClient({ wsUrl: 'ws://127.0.0.1:1', httpUrl: 'http://127.0.0.1:1', onEvent: () => {} });
  let captured = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
  };
  try {
    await client.sendText('group', '1062533151', '测试', { atAll: true });
  } finally { globalThis.fetch = realFetch; }
  const segs = captured.message;
  assert.ok(segs.some((s) => s.type === 'at' && s.data.qq === 'all'), `要有 at:all 段，实际：${JSON.stringify(segs)}`);
  assert.ok(segs.some((s) => s.type === 'text' && s.data.text === '测试'));
  ok('OneBot 消息段：at(qq=all) + text 正确拼装');
}

fs.rmSync(DATA_DIR, { recursive: true, force: true });
console.log(`\n群通知插件 ${pass} 项检查通过 ✅`);
