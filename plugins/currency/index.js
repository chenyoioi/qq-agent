import { createStorage, defaultDataDirectory } from './lib/storage.js';
import { createService } from './lib/service.js';
import { registerTools } from './lib/tools.js';
import { fail, settings } from './lib/validation.js';

export function createCurrencyPlugin({ directory, io, now = Date.now } = {}) {
  let hostApi, running = false, epoch = 0, activationError = '';
  const storage = createStorage({ directory: directory ?? (() => defaultDataDirectory(import.meta.url)), io, now });
  const readSettings = () => settings(hostApi?.config?.() ?? {});
  const guard = expectedEpoch => {
    if (!running || !storage.state || expectedEpoch !== epoch) fail('UNAVAILABLE', '货币服务已停用或重新加载，请重新获取 currency.v1。');
    // 能力对象可能被消费方缓存；每次调用仍遵守宿主的唯一启用状态。
    if (hostApi?.isSkillActive?.('currency') === false) fail('UNAVAILABLE', '货币系统当前未生效，请检查插件开关与设置。');
  };
  const service = createService({ storage, readSettings, guard });

  return {
    setup(api) {
      hostApi = api;
      registerTools(api, { service, readSettings, epoch: () => epoch, now });
    },
    activate() {
      if (running) return;
      epoch += 1;
      // 配置自检由 available / 每次调用负责。宿主保存设置不会再次 activate，
      // 因此错误配置不能阻止存储初始化，否则修正配置后仍会永远不可用。
      try { storage.open(); running = true; activationError = ''; }
      catch (error) { running = false; activationError = error.message; throw error; }
    },
    deactivate() { running = false; epoch += 1; storage.close(); },
    dispose() { running = false; epoch += 1; storage.close(); },
    available() {
      try { readSettings(); } catch (error) { return { ok: false, reason: error.message }; }
      return activationError ? { ok: false, reason: activationError } : true;
    },
    providers: {
      'currency.v1': ({ consumer } = {}) => {
        if (!running || hostApi?.isSkillActive?.('currency') === false) return undefined;
        return service.client(consumer, epoch);
      }
    },

    /**
     * 控制台面板（只读）：按群列出每个人的余额。
     * 传 userIds（群成员列表）时连"还没开过户"的人也会返回 0，方便看全群。
     */
    ui({ action = '', payload = {} } = {}) {
      if (action !== 'members') return { ok: false, error: `未知动作：${action}` };
      const scope = String(payload?.scope || payload?.chatKey || '');
      if (!/^group:\d+$|^private:\d+$/.test(scope)) return { ok: false, error: 'scope 形如 group:123456' };
      if (!running) return { ok: false, error: '货币系统未启用' };
      const read = (kind, args) => {
        try { return service.read(kind, 'currency', args, true); } catch (error) { return { ok: false, message: String(error?.message ?? error) }; }
      };
      const ranked = read('rank', { scope, limit: 100 });
      const byId = new Map();
      for (const a of (ranked?.accounts || [])) byId.set(String(a.userId), { ...a, inLedger: true });
      const want = Array.isArray(payload?.userIds) ? payload.userIds.map(String) : [];
      for (const uid of want.slice(0, 2000)) {
        if (byId.has(uid)) continue;
        if (!/^[1-9]\d{4,11}$/.test(uid)) continue;
        const b = read('balance', { scope, userId: uid });
        byId.set(uid, {
          userId: uid,
          balance: b?.ok ? b.balance : 0,
          held: b?.ok ? b.held : 0,
          available: b?.ok ? b.available : 0,
          inLedger: !!b?.ok
        });
      }
      const rows = [...byId.values()].sort((x, y) => (y.balance || 0) - (x.balance || 0) || String(x.userId).localeCompare(String(y.userId)));
      return {
        ok: true,
        scope,
        currencyName: ranked?.currencyName || '金币',
        rows,
        total: rows.reduce((sum, r) => sum + (Number(r.balance) || 0), 0),
        holders: rows.filter((r) => Number(r.balance) > 0).length
      };
    }
  };
}

const plugin = createCurrencyPlugin();
export const { setup, activate, deactivate, dispose, available, providers } = plugin;

/** 控制台面板入口（宿主读模块导出的 handleUiRequest）。 */
export async function handleUiRequest(req = {}) {
  return plugin.ui(req);
}
