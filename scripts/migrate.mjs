#!/usr/bin/env node
// 迁移工具：把"GitHub 仓库里没有、但换个机器就回不去"的东西打成一个包，另一边解开。
//
// 为什么需要它：仓库里只有代码。下面这些**都不在 git 里**（见 .gitignore）：
//   · data/config.json        模型 Key、白名单、人设、协议端地址 —— 最要命的一份
//   · 扩展目录 plugins/ skills/ 官网装的插件/技能（2MB 上下，但不随仓库走）
//   · data/ 下的运行期状态     额度账本、定时任务、扩展键值存储、表情库索引……
//   · 会话/消息/记忆（可选）   想要"历史也搬走"时加 --with-history
//
// 用法：
//   node scripts/migrate.mjs export [--out 文件.tgz] [--with-history] [--no-secrets]
//   node scripts/migrate.mjs import 文件.tgz [--target 目录] [--force] [--dry-run]
//
// 导出默认**不含**：gallery-mirror（2GB 级缓存）、whale-memes 图库索引、日志、二维码。
// 这些都是能从网上重新拉的，带上只会让包变巨大。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(APP_DIR, 'data');
const BUNDLE_VERSION = 1;

// data/ 里永远不进包（可重建/太大/含登录态）
const ALWAYS_EXCLUDE = new Set([
  'gallery-mirror', 'whale-memes', 'logs', 'tmp', 'napcat-qrcode.png', 'config.example.json'
]);
// 历史数据：默认不打包（体积大、隐私重），--with-history 才带上
const HISTORY_DIRS = new Set(['sessions', 'messages', 'memory', 'inbox']);

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn('⚠', ...a);
const die = (msg) => { console.error('✗', msg); process.exit(1); };

function parseArgs(argv) {
  const args = { cmd: argv[0] || '', bundle: '', out: '', target: '', force: false, dryRun: false, withHistory: false, noSecrets: false };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out') args.out = rest[++i] || '';
    else if (a === '--target') args.target = rest[++i] || '';
    else if (a === '--force') args.force = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--with-history') args.withHistory = true;
    else if (a === '--no-secrets') args.noSecrets = true;
    else if (!args.bundle) args.bundle = a;
  }
  return args;
}

const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const appVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version; } catch { return ''; }
};
const tar = (args, cwd) => {
  const r = spawnSync('tar', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error(`tar 失败：${String(r.stderr || '').trim() || r.status}`);
};

// ── 导出 ─────────────────────────────────────────────────────────────────────
function doExport(args) {
  if (!exists(path.join(APP_DIR, 'package.json'))) die('当前目录不像 qq-agent 项目根（找不到 package.json）');
  const dataItems = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR).filter((n) => {
      if (ALWAYS_EXCLUDE.has(n)) return false;
      if (!args.withHistory && HISTORY_DIRS.has(n)) return false;
      if (args.noSecrets && n === 'config.json') return false;
      return true;
    })
    : [];

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-export-'));
  const appStage = path.join(stage, 'app');
  fs.mkdirSync(path.join(appStage, 'data'), { recursive: true });

  // 扩展目录（plugins/ + skills/）：排除 node_modules 与 .git
  const extIncluded = [];
  for (const dir of ['plugins', 'skills']) {
    const src = path.join(APP_DIR, dir);
    if (!exists(src)) continue;
    const r = spawnSync('tar', ['-cf', path.join(stage, `${dir}.tar`), '--exclude=node_modules', '--exclude=.git', '.'], { cwd: src });
    if (r.status !== 0) throw new Error(`打包 ${dir}/ 失败`);
    extIncluded.push(dir);
  }

  // data/（逐项拷贝，保持目录结构）
  const dataIncluded = [];
  for (const name of dataItems) {
    const src = path.join(DATA_DIR, name);
    const dest = path.join(appStage, 'data', name);
    try {
      fs.cpSync(src, dest, { recursive: true });
      dataIncluded.push(name);
    } catch (error) {
      warn(`跳过 data/${name}：${error?.message ?? error}`);
    }
  }

  // 配置里的绝对路径：导入时按新机器改写（否则换了机器全是 404）
  let absPaths = [];
  const cfgPath = path.join(DATA_DIR, 'config.json');
  if (exists(cfgPath)) {
    try {
      absPaths = [...collectAbsPaths(JSON.parse(fs.readFileSync(cfgPath, 'utf8')))].slice(0, 100);
    } catch { /* 读不了就算了 */ }
  }

  // systemd 单元留一份参考（新机器要重建，但对比着写最省事）
  const refDir = path.join(stage, 'reference');
  fs.mkdirSync(refDir, { recursive: true });
  for (const unit of ['qq-agent.service', 'napcat.service']) {
    const r = spawnSync('systemctl', ['cat', unit], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout) fs.writeFileSync(path.join(refDir, unit), r.stdout);
  }
  fs.writeFileSync(path.join(refDir, 'versions.txt'), [
    `qq-agent ${appVersion()}`,
    `node ${process.version}`,
    `platform ${process.platform}/${process.arch}`,
    `exportedAt ${new Date().toISOString()}`,
    `sourceAppDir ${APP_DIR}`,
    `sourceDataDir ${DATA_DIR}`
  ].join('\n') + '\n');

  const manifest = {
    tool: 'qq-agent-migrate',
    bundleVersion: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: appVersion(),
    node: process.version,
    sourceAppDir: APP_DIR,
    sourceDataDir: DATA_DIR,
    withHistory: !!args.withHistory,
    withoutSecrets: !!args.noSecrets,
    extensions: extIncluded,
    data: dataIncluded,
    absolutePaths: absPaths,
    notes: [
      '导入后仍需：npm install、安装/启动 NapCat（scripts/install.sh --systemd）、按需重建 systemd 单元',
      '模型 Key / 白名单 / 人设都在 data/config.json 里；用 --no-secrets 导出时该文件不在包内',
      'gallery-mirror / whale-memes 图库索引未打包（可重新拉取）'
    ]
  };
  fs.writeFileSync(path.join(appStage, '..', 'manifest.json'), JSON.stringify(manifest, null, 2));

  // 打 tar.gz
  const out = path.resolve(args.out || path.join(APP_DIR, `qq-agent-migrate-${stamp()}.tgz`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  tar(['-czf', out, '-C', stage, '.'], stage);
  fs.rmSync(stage, { recursive: true, force: true });

  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  log(`✓ 已导出：${out}（${size} MB）`);
  log(`  扩展：${extIncluded.join(' + ') || '（无）'}`);
  log(`  数据：${dataIncluded.length} 项${args.withHistory ? '（含会话/消息/记忆）' : '（不含历史，要带历史加 --with-history）'}`);
  if (args.noSecrets) warn('本次没带 data/config.json —— 新机器需要重新填模型 Key 与白名单');
  log('\n下一步：把包拷到新机器 → git clone 代码 → npm install → node scripts/migrate.mjs import <包>');
}

// ── 导入 ─────────────────────────────────────────────────────────────────────
/** 从配置对象里收集"文件系统绝对路径"（跳过 URL 里的 /xxx）。 */
function collectAbsPaths(value, out = new Set()) {
  if (typeof value === 'string') {
    if (value.startsWith('/') && !value.startsWith('//') && !value.includes('://')) {
      const segs = value.split('/').filter(Boolean);
      if (segs.length >= 2) out.add(value);
    }
    return out;
  }
  if (Array.isArray(value)) { for (const v of value) collectAbsPaths(v, out); return out; }
  if (value && typeof value === 'object') { for (const v of Object.values(value)) collectAbsPaths(v, out); return out; }
  return out;
}

function rewriteJson(value, replacements) {
  if (typeof value === 'string') {
    let out = value;
    for (const [from, to] of replacements) {
      if (from && to && from !== to && out.includes(from)) out = out.split(from).join(to);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteJson(v, replacements));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteJson(v, replacements);
    return out;
  }
  return value;
}

function detectNapcatDir() {
  const cands = [
    process.env.NAPCAT_DIR && path.join(process.env.NAPCAT_DIR, 'opt/QQ/resources/app/app_launcher/napcat'),
    path.join(os.homedir(), 'napcat/opt/QQ/resources/app/app_launcher/napcat'),
    '/root/napcat/opt/QQ/resources/app/app_launcher/napcat'
  ].filter(Boolean);
  return cands.find((p) => exists(p)) || '';
}

function doImport(args) {
  const bundle = path.resolve(args.bundle || '');
  if (!bundle || !exists(bundle)) die('用法：node scripts/migrate.mjs import <包.tgz> [--target 目录]');
  const targetApp = path.resolve(args.target || APP_DIR);
  const targetData = path.join(targetApp, 'data');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-import-'));
  tar(['-xzf', bundle, '-C', stage], stage);

  const manifestPath = path.join(stage, 'manifest.json');
  if (!exists(manifestPath)) die('这个包不是 qq-agent 迁移包（缺 manifest.json）');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.tool !== 'qq-agent-migrate' || manifest.bundleVersion !== BUNDLE_VERSION) {
    die(`包版本不兼容（tool=${manifest.tool} v${manifest.bundleVersion}）`);
  }

  // 路径改写表：旧项目目录 → 新项目目录；旧数据目录 → 新数据目录；旧的协议端目录 → 本机探测到的
  const replacements = [
    [manifest.sourceAppDir, targetApp],
    [manifest.sourceDataDir, targetData]
  ];
  const napcat = detectNapcatDir();
  const oldNapcat = (manifest.absolutePaths || []).find((p) => /app_launcher\/napcat$/.test(p));
  if (oldNapcat && napcat && oldNapcat !== napcat) replacements.push([oldNapcat, napcat]);

  log(`来源：${manifest.sourceAppDir}（qq-agent ${manifest.appVersion}，node ${manifest.node}）`);
  log(`目标：${targetApp}`);
  if (manifest.withHistory) log('包含会话/消息/记忆');
  if (napcat) log(`检测到协议端目录：${napcat}${oldNapcat && oldNapcat !== napcat ? '（配置里的旧路径会被改写）' : ''}`);
  else warn('没找到 Napcat 目录 —— 配置里的协议端路径会保留原值，装好 NapCat 后请在设置页确认');

  const actions = [];

  // 1) 扩展：解到目标 plugins/ skills/（已存在则保留旧目录，--force 才覆盖）
  for (const dir of manifest.extensions || []) {
    const tarPath = path.join(stage, `${dir}.tar`);
    if (!exists(tarPath)) continue;
    const dest = path.join(targetApp, dir);
    fs.mkdirSync(dest, { recursive: true });
    const clean = (n) => String(n).replace(/^\.\//, '').trim();
    const list = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8' }).stdout.split('\n').map(clean).filter(Boolean);
    const topNames = [...new Set(list.map((n) => n.split('/')[0]))];
    const skipped = [];
    for (const name of topNames) {
      const destPath = path.join(dest, name);
      if (exists(destPath) && !args.force) {
        actions.push(`跳过 ${dir}/${name}（已存在；要覆盖加 --force）`);
        skipped.push(name);
        continue;
      }
      if (exists(destPath)) {
        actions.push(`覆盖 ${dir}/${name}`);
        if (!args.dryRun) fs.rmSync(destPath, { recursive: true, force: true });
      } else {
        actions.push(`恢复 ${dir}/${name}`);
      }
    }
    if (!args.dryRun) {
      // 解包时排除被跳过的顶层条目，避免"说跳过了却又解出来"
      const excludes = skipped.flatMap((n) => ['--exclude', `./${n}`, '--exclude', n]);
      const r = spawnSync('tar', ['-xf', tarPath, '-C', dest, ...excludes]);
      if (r.status !== 0) throw new Error(`解包 ${dir}/ 失败：${String(r.stderr || '').trim()}`);
    }
  }

  // 2) data/：配置改写绝对路径；已有配置先备份
  const dataStage = path.join(stage, 'app', 'data');
  if (exists(dataStage)) {
    fs.mkdirSync(targetData, { recursive: true });
    for (const name of fs.readdirSync(dataStage)) {
      const src = path.join(dataStage, name);
      const dest = path.join(targetData, name);
      if (name === 'config.json') {
        const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
        const rewritten = rewriteJson(raw, replacements);
        const changed = JSON.stringify(raw) !== JSON.stringify(rewritten);
        actions.push(`写入 data/config.json${changed ? '（已按新路径改写）' : ''}`);
        if (!args.dryRun) {
          if (exists(dest)) {
            const bak = `${dest}.pre-import-${stamp()}`;
            fs.copyFileSync(dest, bak);
            actions.push(`旧配置备份为 ${path.basename(bak)}`);
          }
          fs.writeFileSync(dest, JSON.stringify(rewritten, null, 2));
        }
        continue;
      }
      actions.push(`恢复 data/${name}`);
      if (!args.dryRun) fs.cpSync(src, dest, { recursive: true });
    }
  }

  // 3) 目录名归一：`id_1`/`id_2` 这种安装器产物改回清单 id，
  //    否则配置里那些绝对路径（skills/xxx/assets/...）会指空
  if (!args.dryRun) {
    for (const type of ['skills', 'plugins']) {
      const root = path.join(targetApp, type);
      let names = [];
      try { names = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
      for (const name of names) {
        const dir = path.join(root, name);
        let id = '';
        for (const mf of ['skill.json', 'plugin.json']) {
          try { id = String(JSON.parse(fs.readFileSync(path.join(dir, mf), 'utf8')).id || ''); if (id) break; } catch { /* 无此清单 */ }
        }
        if (!id || name === id) continue;
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`^${escaped}_\\d+$`).test(name)) continue;
        const target = path.join(root, id);
        if (exists(target)) continue;
        try { fs.renameSync(dir, target); actions.push(`目录改名 ${type}/${name} → ${type}/${id}`); } catch { /* 改不动就算了 */ }
      }
    }
  }

  // 4) 提醒
  const packageJson = path.join(targetApp, 'package.json');
  if (!exists(packageJson)) warn('目标目录没有 package.json —— 确认 --target 指向的是 qq-agent 代码目录');

  log('');
  for (const a of actions) log(`  · ${a}`);
  log('');
  if (args.dryRun) {
    log('（--dry-run：以上只是计划，没有写任何文件）');
  } else {
    log('✓ 导入完成。接下来：');
  }
  log('  1) cd ' + targetApp + ' && npm install');
  log('  2) 装/启协议端：bash scripts/install.sh --systemd（会一并注册 qq-agent.service）');
  log('  3) 打开控制台 → 设置页确认模型 Key、白名单、协议端地址');
  log('  4) 扩展是否齐全：技能页应为 N 个卡片、0 异常（有异常会直接显示原因）');
  const cfgFile = path.join(targetData, 'config.json');
  if (!args.dryRun && exists(cfgFile)) {
    try {
      const paths = [...collectAbsPaths(JSON.parse(fs.readFileSync(cfgFile, 'utf8')))];
      const missing = paths.filter((p) => !exists(p));
      if (missing.length) {
        warn('下面这些绝对路径在新机器上不存在，请到设置页/插件设置里改掉：');
        for (const m of missing.slice(0, 10)) log(`    · ${m}`);
      }
    } catch { /* 读不了就算了 */ }
  }
  fs.rmSync(stage, { recursive: true, force: true });
}

// ── 入口 ─────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
if (args.cmd === 'export') doExport(args);
else if (args.cmd === 'import') doImport(args);
else {
  console.log(`qq-agent 迁移工具

  node scripts/migrate.mjs export [--out 文件.tgz] [--with-history] [--no-secrets]
  node scripts/migrate.mjs import 文件.tgz [--target 目录] [--force] [--dry-run]

导出：data/config.json + 扩展（plugins/skills）+ data/ 运行期状态（+ 可选历史）
导入：写回代码目录、按新机器改写绝对路径、旧配置自动备份
`);
}
