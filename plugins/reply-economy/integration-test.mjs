/**
 * 集成验收（不是插件的一部分，可随时删）
 *
 * 用宿主真实加载器 + 真实工具注册表 + 真实思考方言表，把 reply-economy
 * 走一遍完整流程。本插件最怕的不是报错，是**静默失效**：判定没发生、
 * 工具没裁掉、思考参数没剥干净，界面上全都看不出来。
 *
 * 覆盖：
 *   ① 真实加载器认到（kind=plugin，providers/hooks 齐全）
 *   ② 闲聊判定：短句 → economy；复杂词/长句/带图 → 全功率
 *   ③ 请求体三件套：思考关闭（真实方言表）+ 重工具被裁 + max_tokens 压上限
 *   ④ 发消息工具必须保留（裁狠了机器人就说不了话）
 *   ⑤ 轻量引导：追加一次、重复触发不叠加、非闲聊轮不追加
 *   ⑥ 附加统计 replyEconomy 进 llm.usage
 *   ⑦ 关掉开关后一律不动
 *
 * 用法（在 QQ Agent 的 resources/app 目录下）：
 *   node plugins/reply-economy/integration-test.mjs
 * 状态写进系统临时目录，不碰真实 data/。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const PLUGIN_ID = 'reply-economy';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'econ-itest-'));
process.env.QQ_AGENT_DATA_DIR = TMP;   // 必须在 import 任何核心模块之前设好

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

async function main() {
  const { loadPlugins } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'plugin-loader.js')).href);
  const { skillManager } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'skills', 'manager.js')).href);
  const { setSkillConfig } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'skills', 'config.js')).href);
  const { buildToolDefs, toOpenAiTools } = await import(pathToFileURL(path.join(APP_ROOT, 'src', 'tools.js')).href);

  console.log(`集成验收开始｜临时数据目录：${TMP}\n`);

  // ── ① 真实加载器（只装本插件）──
  // ⚠️ solo 根必须放在 resources/app **里面**，不能放系统临时目录：
  //    插件对核心模块（thinking.js / tool-registry.js）用的是 '../../src/…'
  //    相对软依赖 —— 复制到临时目录里这些路径就断了，测出来的"软依赖拿不到"
  //    是测试环境的假故障，不是插件的（第一次就这么踩的）。
  const solo = path.join(APP_ROOT, '.itest-solo-re');
  fs.rmSync(solo, { recursive: true, force: true });
  fs.mkdirSync(solo, { recursive: true });
  fs.cpSync(HERE, path.join(solo, PLUGIN_ID), { recursive: true });
  await loadPlugins({ log: () => {}, roots: { skills: path.join(solo, 'no-skills'), plugins: solo } });
  const st = skillManager.status(PLUGIN_ID);
  check('加载成功且无 loadError', st.loaded && !st.loadError, st.loadError);
  // 注：kind 由**根目录名**推导（manifest.js 的 kindOfDir）。solo 根不叫 plugins/，
  // 所以这里 kind=null 是测试环境的已知形态；真实目录下的 kind=plugin 由
  // 运行中的 QQ Agent 热加载后经 /api/skills 单独验证。
  check('能力齐全（request-params / usage）',
    st.implementedCapabilities.includes('llm.request-params') && st.implementedCapabilities.includes('llm.usage'),
    st.implementedCapabilities.join(','));
  check('钩子齐全（before-context / before-llm-messages）',
    st.hooks.includes('before-context') && st.hooks.includes('before-llm-messages'), st.hooks.join(','));

  // 真实工具集（含真实 category）
  const defs = buildToolDefs();
  const openaiTools = toOpenAiTools(defs);
  const toolName = (t) => String(t?.function?.name || '');
  const namesOf = (arr) => arr.map(toolName).sort();

  const api = { baseUrl: 'https://integrate.api.nvidia.com/v1', apiKey: 'test-key', model: 'z-ai/glm-5.3-flash' };
  const baseBody = () => ({ model: api.model, messages: [{ role: 'user', content: 'hi' }], stream: false, tools: openaiTools, max_tokens: 0 });
  const ctxOf = (sid) => ({ sessionId: sid, chatKey: 'group:1', kind: 'group', chatId: '1', model: api.model, provider: 'p' });

  const requestTransform = () => skillManager.getCapabilityProviders('llm.request-params')[0]?.fn;
  const usageTransform = () => skillManager.getCapabilityProviders('llm.usage')[0]?.fn;

  // ── ② 闲聊判定 ──
  console.log('\n② 判定：什么算闲聊');
  const chat = (text, extra = {}) => ({ id: 1, ts: Date.now(), senderId: '100', senderName: 'x', self: false, text, media: [], ...extra });
  await skillManager.runHook('before-context', { ...ctxOf('s-chat'), triggerEntries: [chat('哈哈哈'), chat('在吗')] });
  await skillManager.runHook('before-context', { ...ctxOf('s-hard'), triggerEntries: [chat('帮我看看这个报错是怎么回事')] });
  await skillManager.runHook('before-context', { ...ctxOf('s-img'), triggerEntries: [chat('看图', { media: ['x.png'] })] });
  await skillManager.runHook('before-context', { ...ctxOf('s-long'), triggerEntries: [chat('今天天气真不错啊我们出去走走吧顺便去吃个饭看电影然后回家'.repeat(2))] });
  await skillManager.runHook('before-context', { ...ctxOf('s-proactive'), triggerEntries: [chat('哈哈哈')], proactive: true });

  const intern = skillManager.registry.get(PLUGIN_ID);
  check('providers 挂载完整（setup 走完了）',
    typeof intern?.providers?.['llm.request-params'] === 'function' && typeof intern?.providers?.['llm.usage'] === 'function');
  // （判定结果通过下面的行为间接验证 —— 静默失效测的就是行为）

  // ── ③④ 闲聊轮的请求体三件套 ──
  console.log('\n③ 闲聊轮请求体：关思考 / 裁重工具 / 压输出');
  const fnT = requestTransform();
  const rChat = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-chat') });
  check('闲聊轮请求被改写', Boolean(rChat?.body), JSON.stringify(rChat).slice(0, 80));
  const before = namesOf(openaiTools);
  const after = namesOf(rChat.body.tools || []);
  const removed = before.filter((n) => !after.includes(n));
  const keptHeavy = after.filter((n) => {
    const cat = defs.find((d) => d.id === n)?.category;
    return ['web', 'knowledge', 'media'].includes(String(cat));
  });
  check('重工具被裁掉（有删除动作）', removed.length > 0, `删除前 ${before.length} 个 → 删除后 ${after.length} 个`);
  check('web/knowledge/media 一个不剩', keptHeavy.length === 0, keptHeavy.join(','));
  check('联网搜索真的没了', !after.includes('web_search') && !after.includes('web_fetch') && !after.includes('search_images') && !after.includes('send_image'),
    after.filter((n) => /search|web|image/.test(n)).join(','));
  check('send_message 保留（还能说话）', after.includes('send_message'));
  check('send_sticker 保留（还能发表情包）', after.includes('send_sticker'));
  check('finish 保留（能正常收尾）', after.includes('finish'));
  check('max_tokens 压到 600', Number(rChat.body.max_tokens) === 600, String(rChat.body.max_tokens));
  const thinkingKeys = ['thinking', 'enable_thinking', 'thinking_budget', 'reasoning_effort', 'reasoning', 'think', 'extra_body'];
  const onKeys = thinkingKeys.filter((k) => k in rChat.body);
  check('body 里留下的是「关思考」参数（enable_thinking=false 一类）',
    rChat.body.enable_thinking === false || rChat.body.reasoning_effort === 'minimal' || JSON.stringify(rChat.body.thinking || '').includes('disabled'),
    JSON.stringify(onKeys.reduce((o, k) => ({ ...o, [k]: rChat.body[k] }), {})));
  const ctxChat = ctxOf('s-chat');
  await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxChat });
  check('context 上带 _replyEconomyApplied（供 usage 统计）', Number(ctxChat._replyEconomyApplied) === 1, String(ctxChat._replyEconomyApplied));

  console.log('\n④ 非闲聊轮：一个字段都不能动');
  const bodyHard = baseBody();
  bodyHard.enable_thinking = true;   // 假设别的插件已加上的思考参数
  const rHard = await fnT({ body: bodyHard, api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-hard') });
  check('复杂词轮：不改写（undefined）', rHard === undefined, String(rHard).slice(0, 60));
  const rImg = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-img') });
  check('带图轮：不改写', rImg === undefined);
  const rLong = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-long') });
  check('超长轮：不改写', rLong === undefined);
  const rPro = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-proactive') });
  check('主动开口轮：不改写', rPro === undefined);
  const rJudge = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: { ...ctxOf('s-chat'), thinkingMode: 'off' } });
  check('裁判调用（thinkingMode=off）：不掺和', rJudge === undefined);

  // ── ⑤ 轻量引导 ──
  console.log('\n⑤ 轻量引导');
  const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: '【未读信息】x：哈哈哈' }];
  const sysBefore = msgs[0].content;
  await skillManager.runHook('before-llm-messages', { ...ctxOf('s-chat'), messages: msgs });
  check('闲聊轮：追加引导', msgs[1].content.includes('【本轮轻量化】'), msgs[1].content.slice(-40));
  check('引导里没有"不要调用工具"这类一刀切', !msgs[1].content.includes('不要调用工具'));
  check('系统提示词没被动', msgs[0].content === sysBefore);
  const len1 = msgs[1].content.length;
  await skillManager.runHook('before-llm-messages', { ...ctxOf('s-chat'), messages: msgs });
  check('重复触发不叠加', msgs[1].content.length === len1);
  const msgsHard = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
  await skillManager.runHook('before-llm-messages', { ...ctxOf('s-hard'), messages: msgsHard });
  check('非闲聊轮：不追加', msgsHard[1].content === 'U');

  // ── ⑥ 附加统计 ──
  console.log('\n⑥ llm.usage 附加统计');
  const fnU = usageTransform();
  const u = await fnU({ result: {}, usage: {}, ...ctxChat });
  check('闲聊轮返回 replyEconomy=1', Number(u?.replyEconomy) === 1, JSON.stringify(u));
  const u2 = await fnU({ result: {}, usage: {}, ...ctxOf('s-hard') });
  check('非闲聊轮不返回', u2 === undefined, JSON.stringify(u2));

  // ── ⑦ 开关 ──
  console.log('\n⑦ 开关（config.skills[id].enabled = false）');
  setSkillConfig(PLUGIN_ID, { enabled: false });
  check('判定为未启用', skillManager.isActive(PLUGIN_ID).active === false);
  const rOff = await fnT({ body: baseBody(), api, model: api.model, messages: [], tools: openaiTools, temperature: 0.8, context: ctxOf('s-chat') });
  check('关掉后请求体原样（undefined）', rOff === undefined);
  const msgsOff = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
  await skillManager.runHook('before-llm-messages', { ...ctxOf('s-chat'), messages: msgsOff });
  check('关掉后不追加引导', msgsOff[1].content === 'U');
  setSkillConfig(PLUGIN_ID, { enabled: true });
  check('重新启用生效', skillManager.isActive(PLUGIN_ID).active === true);

  console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
  try {
    fs.rmSync(solo, { recursive: true, force: true });   // solo 根在 resources/app 里，必须清干净
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch { /* 无所谓 */ }
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error('验收脚本自身崩了：', error);
  process.exit(2);
});
