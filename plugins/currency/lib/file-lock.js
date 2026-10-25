// 随扩展独立分发，不依赖宿主源码。四个副本由测试校验一致。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// 只保留已停止实例的清理记录，不保留业务回调。静态子模块在热重载时复用，
// 因此新实例也能重试旧实例失败的清理；仍持有锁的实例绝不进入此队列。
const pendingReleases = new WeakMap();

function cleanup({ io, file, claim, token, claimCreated }) {
  let mainDone = false, claimDone = !claimCreated;
  try {
    if (io.readFileSync(file, 'utf8') === token) io.unlinkSync(file);
    mainDone = true; // 内容已变化时只放弃归属，不能删除后来者的主锁。
  } catch (error) { mainDone = error.code === 'ENOENT'; }
  if (claimCreated) {
    // 本实例独有的 UUID 路径；创建成功但写到一半失败也能清理。
    try { io.unlinkSync(claim); claimDone = true; }
    catch (error) { claimDone = error.code === 'ENOENT'; }
  }
  return mainDone && claimDone;
}

function retryReleases(runtime) {
  const pending = pendingReleases.get(runtime);
  if (!pending) return [];
  for (const record of pending.records) {
    if (cleanup(record)) pending.records.delete(record);
  }
  if (!pending.records.size) {
    runtime.removeListener('exit', pending.onExit);
    pendingReleases.delete(runtime);
  }
  return pending.records;
}

function deferRelease(runtime, record) {
  let pending = pendingReleases.get(runtime);
  if (!pending) {
    pending = { records: new Set(), onExit: () => { retryReleases(runtime); } };
    pendingReleases.set(runtime, pending);
    runtime.on('exit', pending.onExit);
  }
  pending.records.add(record);
}

export function createFileLock({ io = fs, runtime = process, label = '数据', beforeExit } = {}) {
  let file, claim, token, claimCreated = false;
  const blocked = message => { throw Object.assign(new Error(`${label}：${message}`), { code: 'STORAGE_LOCKED' }); };
  function dead(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
    try { runtime.kill(pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; } // EPERM 和未知错误都不能证明进程已退出。
  }
  function release() {
    runtime.removeListener('exit', onExit);
    retryReleases(runtime);
    if (token) {
      const record = { io, file, claim, token, claimCreated };
      if (!cleanup(record)) deferRelease(runtime, record);
    }
    // 失败记录已转交清理队列；当前实例立即失去写权限。
    claimCreated = false;
    file = claim = token = undefined;
  }
  function onExit() {
    // 不监听或接管 SIGINT/SIGTERM；只在进程真正退出时清理，避免提前放开写锁。
    try { beforeExit?.(); } catch {} finally {
      release();
      // exit 事件进行中新增的监听不会在本轮触发，立即再尝试一次暂时失败。
      retryReleases(runtime);
    }
  }
  function acquire(target) {
    if (token) { assertOwned(); return; }
    for (const record of retryReleases(runtime)) {
      if (path.resolve(record.file) === path.resolve(target)) {
        blocked(`${path.basename(target)} 上次停用的锁尚未清理，请稍后重试并检查目录权限。`);
      }
    }
    file = target;
    const nonce = randomUUID();
    token = JSON.stringify({ pid: runtime.pid, token: nonce });
    const prefix = `${path.basename(file)}.owner-`;
    claim = path.join(path.dirname(file), `${prefix}${runtime.pid}-${nonce}`);
    try {
      // 先声明再扫描。持有者始终保留声明；两个同时启动的进程不能都通过扫描。
      // 死进程的声明名称永不复用，清除它不会误删后来者的声明。
      const fd = io.openSync(claim, 'wx');
      claimCreated = true;
      try { io.writeFileSync(fd, token, 'utf8'); } finally { io.closeSync(fd); }
      for (const name of io.readdirSync(path.dirname(file))) {
        if (!name.startsWith(prefix) || name === path.basename(claim)) continue;
        const match = /^([1-9]\d*)-([0-9a-f-]{36})$/.exec(name.slice(prefix.length));
        if (!match || !dead(Number(match[1]))) blocked(`${path.basename(file)} 被其他实例占用，或无法确认其进程状态。`);
        try { io.unlinkSync(path.join(path.dirname(file), name)); }
        catch (error) {
          if (error.code === 'ENOENT') continue;
          // Windows 上另一个启动进程同时删除该声明时可能先返回 EPERM。
          // 仅在文件确已消失时继续；仍存在或无法读取则退让，不冒险抢占。
          try { io.lstatSync(path.join(path.dirname(file), name)); }
          catch (check) { if (check.code === 'ENOENT') continue; }
          blocked(`暂时无法回收 ${path.basename(file)} 的遗留归属文件（${error.code ?? '未知错误'}），请稍后重试并检查目录权限。`);
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // 在同一目录原子发布完整锁内容；目标存在时 link 失败，不覆盖。
          // 即使进程在声明写入期间被强杀，也不会留下半个 JSON 的主锁。
          io.linkSync(claim, file);
          runtime.on('exit', onExit);
          return;
        } catch (error) {
          if (error.code !== 'EEXIST') {
            throw Object.assign(new Error(`${label}：无法创建独占锁（${error.code ?? '未知错误'}）。请确认数据目录可写且支持同目录硬链接（如本机 NTFS），检查磁盘空间与权限。`, { cause: error }), { code: error.code });
          }
        }
        let observed, owner;
        try { observed = io.readFileSync(file, 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        try { owner = JSON.parse(observed); } catch { /* 不猜测损坏文件的归属。 */ }
        if (!owner || typeof owner.token !== 'string' || !owner.token || !dead(owner.pid)) {
          blocked(`${path.basename(file)} 被占用或归属无法确认；不会移除仍在运行的进程或损坏锁。`);
        }
        // 同时启动的新实例已被上面的声明隔离；旧版只创建 wx 锁，不会抢占旧锁。
        // 保留复读检查，遇到外部维护修改就停止，不清除新的内容。
        if (io.readFileSync(file, 'utf8') !== observed) blocked('启动期间锁内容已改变，请稍后重试。');
        io.unlinkSync(file);
      }
      blocked('启动期间锁反复变化，请稍后重试。');
    } catch (error) { release(); throw error; }
  }
  function assertOwned() {
    let actual, ownClaim;
    try { actual = io.readFileSync(file, 'utf8'); ownClaim = io.readFileSync(claim, 'utf8'); } catch {}
    if (!token || actual !== token || ownClaim !== token) blocked('数据锁已变化或不可读取，停止写入。');
  }
  return { acquire, release, assertOwned };
}
