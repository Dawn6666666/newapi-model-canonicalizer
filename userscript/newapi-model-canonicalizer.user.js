// ==UserScript==
// @name         New-API Model Canonicalizer (Redirect Toolkit)
// @namespace    https://github.com/Dawn6666666/newapi-model-canonicalizer
// @version      0.6.16
// @description  Canonicalize model names and rebuild New-API channel model_mapping in-browser (dry-run -> apply), preventing alias cycles.
// @author       Dawn
// @homepageURL  https://github.com/Dawn6666666/newapi-model-canonicalizer
// @downloadURL  https://raw.githubusercontent.com/Dawn6666666/newapi-model-canonicalizer/main/userscript/newapi-model-canonicalizer.user.js
// @updateURL    https://raw.githubusercontent.com/Dawn6666666/newapi-model-canonicalizer/main/userscript/newapi-model-canonicalizer.user.js
// @match        http://*/console/channel*
// @match        https://*/console/channel*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // For debugging: if you still see SyntaxError, you're running an older cached userscript.
  // eslint-disable-next-line no-console
  const SCRIPT_VERSION = '0.6.16';
  console.log('[na-mr] userscript loaded, version=' + SCRIPT_VERSION);

  function uniqChannelsById(channels) {
    // 防止 API 分页/排序参数异常导致重复渠道进入快照（会表现为搜索时出现两个相同项）。
    const out = [];
    const seen = new Set();
    for (const ch of channels || []) {
      const id = ch && ch.id != null ? String(ch.id) : '';
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(ch);
    }
    return out;
  }

  const TOOL_ID = 'na-mr-toolkit';
  // 避免“装了两份脚本”导致 UI/状态互相覆盖：给出明确提示（不做强行退出，便于排查）。
  if (window[TOOL_ID] && window[TOOL_ID].SCRIPT_VERSION && window[TOOL_ID].SCRIPT_VERSION !== SCRIPT_VERSION) {
    // eslint-disable-next-line no-console
    console.warn('[na-mr] 检测到重复注入：已有版本=' + window[TOOL_ID].SCRIPT_VERSION + '，当前版本=' + SCRIPT_VERSION + '。请在 Tampermonkey 中只保留一个脚本。');
  }
  const DB_NAME = 'na_mr_toolkit';
  const DB_VERSION = 1;
  const STORE = 'kv';

  const DEFAULT_FAMILIES = [
    'claude',
    'gemini',
    'gpt',
    'qwen',
    'deepseek',
    'grok',
    'glm',
    'kimi',
    'llama',
    'mistral',
  ];

  // Default standards: copied from repo README (acts as stable "standard set").
  const DEFAULT_STANDARDS = {
    claude: [
      'claude-4.5-sonnet',
      'claude-4.5-haiku',
      'claude-4.5-opus',
      'claude-4.1-opus',
      'claude-4-opus',
      'claude-4-sonnet',
      'claude-4.6-opus',
      'claude-3.7-sonnet',
      'claude-3.5-sonnet',
      'claude-3.5-haiku',
      'claude-3-haiku',
    ],
    gemini: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-3-flash-preview',
      'gemini-3-pro-preview',
      'gemini-3-pro-image-preview',
    ],
    gpt: [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4.1',
      'gpt-5',
      'gpt-5-nano',
      'o1',
      'o1-mini',
      'o3',
      'o3-mini',
      'o4-mini',
      'gpt-oss-120b',
    ],
    qwen: ['qwen-3-32b', 'qwen-3-235b-a22b-instruct-2507', 'qwen-image-edit'],
    deepseek: ['deepseek-r1', 'deepseek-r1-0528', 'deepseek-v3', 'deepseek-v3.1', 'deepseek-v3.2'],
    grok: ['grok-3', 'grok-3-mini', 'grok-4', 'grok-4.1', 'grok-4-fast', 'grok-code-fast'],
    glm: ['glm-4.5', 'glm-4.5-air', 'glm-4.5-v', 'glm-4.6', 'glm-4.7', 'glm-5'],
    kimi: ['kimi-k2', 'kimi-k2-instruct', 'kimi-k2-thinking', 'kimi-k2.5'],
    llama: [
      'llama-3.1-8b-instruct',
      'llama-3.3-70b-instruct',
      'llama-4-maverick-17b-128e-instruct',
      'llama-4-scout-17b-16e-instruct',
    ],
    mistral: ['mistral-small', 'mistral-medium', 'mistral-large', 'mistral-small-24b-instruct-2501'],
  };

  // Exact route/tag blacklist: treat as routing labels, never canonicalize into standards.
  const ROUTE_TAG_EXACT_BLACKLIST = new Set([
    'openrouter/free',
    'openrouter/auto',
    'openrouter/bodybuilder',
    'switchpoint/router',
    'switchpoint/auto',
    'switchpoint/free',
  ]);

  // Wrapper prefixes: should be stripped for matching, but SHOULD NOT become standalone canonicals.
  // If a model name starts with one of these wrappers, we generally "skip standardization" and keep it as-is.
  const HARD_WRAPPER_PREFIXES = [
    'image/',
    'images/',
    'video/',
    'videos/',
    'audio/',
    'vision/',
    'embedding/',
    'embeddings/',
    'rerank/',
    'moderation/',
    'stream/',
    'streaming/',
    '流式/',
    '非流式/',
    '假流式/',
    '伪流式/',
    '流式抗截断/',
    '抗截断/',
    '代理/',
    '中转/',
    '加速/',
  ];

  // Mode wrapper prefixes: strip the wrapper, but KEEP the mode token in canonical.
  // Examples:
  // - thinking/grok-4.1-thinking-1129 -> grok-4.1-thinking
  // - high/gpt-5-codex-high -> gpt-5-codex-high
  const MODE_WRAPPER_PREFIXES = [
    'thinking/',
    'reasoning/',
    'high/',
    'medium/',
    'low/',
  ];

  // Common "publisher" prefixes often used as wrappers in model names (dash-joined).
  // We strip these for canonicalization when the remainder clearly belongs to a known family.
  const PUBLISHER_DASH_PREFIXES = [
    'zai-',
    'groq-',
    'routeway-',
    'deepseek-ai-',
    'deepseekai-',
    'openai-',
    'anthropic-',
    'google-',
    'meta-',
    'x-ai-',
    'xai-',
    'openrouter-',
    'switchpoint-',
  ];

  // Org prefixes that are usually "publisher wrappers" and should not affect canonical for known families.
  const ORG_PREFIXES = new Set([
    'anthropic',
    'openai',
    'google',
    'x-ai',
    'xai',
    'deepseek',
    'deepseek-ai',
    'zai',
    'z-ai',
    'zhipuai',
    'groq',
    'routeway',
    'moonshotai',
    'llm-research',
    'meta-llama',
    'llama',
    'qwen',
    'tngtech',
    'pro',
    'org',
    'openrouter',
    'switchpoint',
  ]);

  const POINTER_SUFFIX_RE = /(?:-|:)(latest|default|stable|current)$/i;

  const MODE_TOKENS = new Set(['thinking', 'reasoning', 'high', 'low', 'medium']);

  // Profile 配置：逐家族声明“允许的 canonical 形态”和“特殊处理”，便于后续扩展而不互相误伤。
  // 目标是逐步把 normalizeX 的特例压缩到 profile，通用流程复用一套。
  const FAMILY_PROFILES = {
    // pinnedPolicy:
    // - enabled: 是否允许生成 pinned key（base + buildTag）
    // - accept4/6/8: 接受末尾纯数字 buildTag 的长度
    // 说明：pinned 只做“批次锁定”，不改变 base canonical（base 仍用于负载均衡/通用调用）。
    claude: { family: 'claude', canonicalPrefix: 'claude-', pinnedPolicy: { enabled: true, accept4: false, accept6: false, accept8: true } },
    gemini: { family: 'gemini', canonicalPrefix: 'gemini-', pinnedPolicy: { enabled: true, accept4: false, accept6: false, accept8: true } },
    gpt: { family: 'gpt', canonicalPrefix: 'gpt-', allowPrefixes: ['gpt-', 'o1', 'o3', 'o4'], pinnedPolicy: { enabled: true, accept4: false, accept6: false, accept8: true } },
    qwen: { family: 'qwen', canonicalPrefix: 'qwen-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } }, // e.g. -2507
    deepseek: { family: 'deepseek', canonicalPrefix: 'deepseek-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } }, // e.g. r1-0528
    grok: { family: 'grok', canonicalPrefix: 'grok-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } },
    glm: { family: 'glm', canonicalPrefix: 'glm-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } }, // e.g. -0414
    kimi: { family: 'kimi', canonicalPrefix: 'kimi-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } }, // e.g. -0905
    llama: { family: 'llama', canonicalPrefix: 'llama-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } },
    mistral: { family: 'mistral', canonicalPrefix: 'mistral-', pinnedPolicy: { enabled: true, accept4: true, accept6: false, accept8: false } },
  };

  // 家族 profile：用“分发函数 + 校验函数”的方式组织，避免后续修改某一家族时误伤其它家族。
  // 注意：这里优先做结构化，不改变现有 normalize 的输出行为；具体规则仍在 normalizeX 内部。
  function canonicalOk(family, canonical) {
    const fam = String(family || '').toLowerCase();
    const can = String(canonical || '');
    if (!fam || !can) return false;
    if (can.includes('/')) return false;
    // 统一约束：canonical 只能包含小写字母/数字/点/短横线
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(can)) return false;
    const prof = FAMILY_PROFILES[fam];
    if (prof && Array.isArray(prof.allowPrefixes) && prof.allowPrefixes.length) {
      return prof.allowPrefixes.some((p) => can.startsWith(p));
    }
    return can.startsWith((prof && prof.canonicalPrefix) ? prof.canonicalPrefix : (fam + '-'));
  }

  function normalizeByFamily(family, raw, extraModes) {
    const fam = String(family || '').toLowerCase();
    if (fam === 'claude') return normalizeClaude(raw, extraModes);
    if (fam === 'gemini') return normalizeGemini(raw, extraModes);
    if (fam === 'gpt') return normalizeGpt(raw, extraModes);
    if (fam === 'deepseek') return normalizeDeepseek(raw, extraModes);
    if (fam === 'qwen') return normalizeQwen(raw, extraModes);
    if (fam === 'grok') return normalizeGrok(raw, extraModes);
    if (fam === 'glm') return normalizeGlm(raw, extraModes);
    if (fam === 'kimi') return normalizeKimi(raw, extraModes);
    if (fam === 'llama') return normalizeLlama(raw, extraModes);
    if (fam === 'mistral') return normalizeMistral(raw, extraModes);
    return normalizeGeneric(raw, extraModes);
  }

  const state = {
    open: false,
    loading: false,
    running: false,
    applying: false,
    families: new Set(DEFAULT_FAMILIES),
    pinnedKeys: true, // also generate pinned keys with build/date suffixes
    theme: 'dark', // 'dark' | 'light'（仅影响本脚本 UI，不修改 New-API 全站主题）
    snapshot: null, // { ts, channels[] }
    plan: null, // { ts, families[], perChannel, summary }
    progress: { pct: 0, text: '' },
    lastApply: null, // { ts,total,ok[],failed[],elapsed_s }
  };

  function log(...args) {
    // eslint-disable-next-line no-console
    console.log('[na-mr]', ...args);
  }

  function mustGetUser() {
    const raw = localStorage.getItem('user');
    if (!raw) throw new Error('未登录: localStorage.user 不存在');
    const u = JSON.parse(raw);
    if (!u || typeof u.id !== 'number' || u.id <= 0) throw new Error('未登录或 user.id 无效');
    return u;
  }

  function newApiHeaders() {
    const u = mustGetUser();
    const h = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'New-Api-User': String(u.id),
    };
    if (u.token) h.Authorization = 'Bearer ' + String(u.token);
    return h;
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
  }

  // New-API 管理端可能对短时间内大量请求做限流（429）。
  // 这里做两个动作：
  // 1) 轻量串行队列 + 最小间隔：避免 burst
  // 2) 429/5xx 重试：尊重 Retry-After；否则指数退避 + 抖动
  let _fetchQueue = Promise.resolve();
  let _lastFetchAt = 0;
  const FETCH_MIN_GAP_MS = 140;
  const FETCH_MAX_RETRY = 6;
  const FETCH_BACKOFF_BASE_MS = 550;

  async function fetchJSON(url, opts = {}) {
    // 串行化请求，避免触发限流
    _fetchQueue = _fetchQueue.then(async () => {
      const gap = Date.now() - _lastFetchAt;
      if (gap < FETCH_MIN_GAP_MS) await sleep(FETCH_MIN_GAP_MS - gap);
      _lastFetchAt = Date.now();
    });
    await _fetchQueue;

    let attempt = 0;
    let lastErr = null;
    while (attempt < FETCH_MAX_RETRY) {
      attempt++;
      try {
        const res = await fetch(url, {
          credentials: 'include',
          ...opts,
          headers: { ...(opts.headers || {}), ...newApiHeaders() },
        });

        if (!res.ok) {
          // 429/5xx：做退避重试（PUT 写入是幂等覆盖，允许重试）
          const status = Number(res.status) || 0;
          const canRetry = status === 429 || status >= 500;
          if (!canRetry) throw new Error(`HTTP ${res.status} ${res.statusText}`);

          // Retry-After: seconds or date
          const ra = res.headers && res.headers.get ? res.headers.get('Retry-After') : null;
          let waitMs = 0;
          if (ra) {
            const sec = Number(ra);
            if (!Number.isNaN(sec) && sec > 0) waitMs = sec * 1000;
            else {
              const t = Date.parse(ra);
              if (!Number.isNaN(t)) waitMs = Math.max(0, t - Date.now());
            }
          }
          if (!waitMs) {
            const backoff = FETCH_BACKOFF_BASE_MS * Math.pow(2, Math.min(5, attempt - 1));
            const jitter = Math.floor(Math.random() * 180);
            waitMs = backoff + jitter;
          }
          lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
          await sleep(waitMs);
          continue;
        }

        const data = await res.json();
        if (data && data.success === false) {
          // 业务层失败一般不建议盲目重试（可能是参数/权限问题）
          throw new Error(data.message || '请求失败');
        }
        return data;
      } catch (e) {
        lastErr = e;
        // 网络抖动也尝试重试
        const backoff = FETCH_BACKOFF_BASE_MS * Math.pow(2, Math.min(5, attempt - 1));
        const jitter = Math.floor(Math.random() * 180);
        await sleep(backoff + jitter);
      }
    }
    throw lastErr || new Error('请求失败');
  }

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const st = tx.objectStore(STORE);
      const req = st.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, val) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const st = tx.objectStore(STORE);
      const req = st.put(val, key);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  // =========================
  // Checkpoints（强制写库前存档）
  // =========================
  const CHECKPOINTS_KEY = 'checkpoints_v1';
  const CHECKPOINTS_MAX = 20; // 超出后丢弃最旧的存档点，避免 IndexedDB 过大

  function makeCheckpointId() {
    return 'cp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function deepCloneJSON(x) {
    // 只用于备份 JSON 对象（model_mapping）；避免引用同一对象导致后续被修改。
    try {
      return JSON.parse(JSON.stringify(x || {}));
    } catch {
      return {};
    }
  }

  async function getCheckpoints() {
    const list = await idbGet(CHECKPOINTS_KEY);
    return Array.isArray(list) ? list : [];
  }

  async function putCheckpoints(list) {
    const arr = Array.isArray(list) ? list : [];
    await idbSet(CHECKPOINTS_KEY, arr);
    return arr;
  }

  async function addCheckpoint(cp) {
    const list = await getCheckpoints();
    list.push(cp);
    // newest last; trim oldest
    while (list.length > CHECKPOINTS_MAX) list.shift();
    await putCheckpoints(list);
    return cp;
  }

  async function deleteCheckpointById(id) {
    const cid = String(id || '');
    if (!cid) return false;
    const list = await getCheckpoints();
    const next = list.filter((x) => String(x && x.id) !== cid);
    await putCheckpoints(next);
    return next.length !== list.length;
  }

  function summarizeMappingDiff(before, after) {
    const d = mappingDiff(before || {}, after || {});
    return {
      added: Object.keys(d.added || {}).length,
      removed: Object.keys(d.removed || {}).length,
      changed: Object.keys(d.changed || {}).length,
      total: Object.keys(d.added || {}).length + Object.keys(d.removed || {}).length + Object.keys(d.changed || {}).length,
      diff: d,
    };
  }

  async function fetchChannelDetail(channelId) {
    // New-API 提供单渠道详情接口：GET /api/channel/:id
    const cid = String(channelId || '').trim();
    if (!cid) throw new Error('channel_id_empty');
    const data = await fetchJSON(`/api/channel/${encodeURIComponent(cid)}`);
    // 兼容不同返回结构
    const it = (data && data.data) ? data.data : (data && data.item) ? data.item : data;
    if (!it || it.id == null) throw new Error('channel_detail_missing');
    return it;
  }

  async function buildCheckpointBeforeWrite(kind, channelPlans, note) {
    // channelPlans: [{ id, after, plan_diff }] where after is planned mapping object.
    const id = makeCheckpointId();
    const ts = Date.now();
    const settings = {
      pinnedKeys: !!state.pinnedKeys,
      families: Array.from(state.families || []),
      theme: state.theme || 'dark',
    };
    const meta = {
      id,
      ts,
      kind: String(kind || 'apply'),
      note: note ? String(note) : '',
      script_version: SCRIPT_VERSION,
      snapshot_ts: state.snapshot ? state.snapshot.ts : null,
      plan_ts: state.plan ? state.plan.ts : null,
      settings,
      channels: [],
      stats: { channels: 0, diff_total: 0, added: 0, removed: 0, changed: 0 },
    };

    const total = channelPlans.length || 1;
    for (let i = 0; i < channelPlans.length; i++) {
      const item = channelPlans[i];
      const cid = String(item.id);
      // 进度：备份阶段
      state.progress = { pct: Math.min(99, Math.floor(((i + 1) * 100) / total)), text: `备份 ${i + 1}/${total} | channel ${cid}` };
      render();
      // 备份优先使用“快照里的 DB 值”，避免写库前再对每个渠道做 GET（很容易触发 429）。
      // 如果快照里没有该渠道（极少见），才降级走单渠道详情接口。
      let beforeMap = {};
      let chName = '';
      let chGroup = '';
      let chStatus = null;
      let modelsCount = 0;
      const snapCh = (state.snapshot && state.snapshot.channels) ? state.snapshot.channels.find((x) => String(x.id) === cid) : null;
      if (snapCh) {
        chName = snapCh.name || '';
        chGroup = snapCh.group || '';
        chStatus = snapCh.status;
        modelsCount = Array.isArray(snapCh.models) ? snapCh.models.length : 0;
        beforeMap = snapCh.model_mapping || {};
      } else {
        const d = await fetchChannelDetail(cid);
        chName = d.name || '';
        chGroup = d.group || '';
        chStatus = d.status;
        beforeMap = safeParseJSON(d.model_mapping) || {};
        modelsCount = toModelList(d.models).length;
      }
      const afterMap = item.after || {};
      const s = summarizeMappingDiff(beforeMap, afterMap);
      meta.channels.push({
        id: Number(cid),
        name: String(chName || ''),
        group: String(chGroup || ''),
        status: chStatus,
        models_count: modelsCount,
        before: deepCloneJSON(beforeMap),
        after: deepCloneJSON(afterMap),
        diff: s.diff,
      });
      meta.stats.channels += 1;
      meta.stats.added += s.added;
      meta.stats.removed += s.removed;
      meta.stats.changed += s.changed;
      meta.stats.diff_total += s.total;
    }
    return addCheckpoint(meta);
  }

  function safeParseJSON(str) {
    // New-API 不同版本/不同接口可能返回：
    // - JSON string（常见：数据库里存的是 string）
    // - object（部分接口会直接返回已反序列化的对象）
    // 这里统一兼容，避免仪表盘 DB 视图永远显示空、diff 永远只显示 added。
    if (!str) return null;
    if (typeof str === 'object') return str;
    if (typeof str !== 'string') return null;
    const t = str.trim();
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  }

  function toModelList(models) {
    if (Array.isArray(models)) return models.map((x) => String(x || '').trim()).filter(Boolean);
    if (typeof models === 'string') return models.split(',').map((s) => s.trim()).filter(Boolean);
    return [];
  }

  function isRouteOrTag(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    return ROUTE_TAG_EXACT_BLACKLIST.has(s);
  }

  function startsWithHardWrapper(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    const low = s.toLowerCase();
    return HARD_WRAPPER_PREFIXES.some((p) => low.startsWith(p.toLowerCase()));
  }

  function extractModeWrappers(raw) {
    // Return { name, modes[] }.
    let s = String(raw || '').trim();
    const modes = [];
    while (true) {
      const low = s.toLowerCase();
      const hit = MODE_WRAPPER_PREFIXES.find((p) => low.startsWith(p));
      if (!hit) break;
      const mode = hit.slice(0, hit.length - 1); // drop trailing "/"
      if (mode) modes.push(mode);
      s = s.slice(hit.length);
    }
    return { name: s, modes };
  }

  function stripHardWrapperPrefixes(raw) {
    let s = String(raw || '').trim();
    const low = s.toLowerCase();
    for (const p of HARD_WRAPPER_PREFIXES) {
      if (low.startsWith(p.toLowerCase())) {
        s = s.slice(p.length);
        break;
      }
    }
    return s;
  }

  function isPointerAlias(raw) {
    // Treat *-latest/*-default/*-stable/*-current as pointer aliases and skip them for mapping candidates.
    const s = normalizeSeparators(String(raw || '').trim());
    return POINTER_SUFFIX_RE.test(s);
  }

  function stripPointerSuffix(name) {
    const s = String(name || '').trim();
    if (!s) return s;
    return s.replace(POINTER_SUFFIX_RE, '');
  }

  function sanitizeModelName(name) {
    // 用于 canonical 归一化：移除中括号/小括号里的“用途/限额/备注”文本，避免污染 key。
    // 注意：是否“带备注”的判定由 isAnnotatedModelName 负责；sanitize 只做清洗。
    let s = String(name || '');
    s = s.replace(/\[[^\]]*\]/g, '');
    s = s.replace(/\([^)]*\)/g, '');
    return s.trim();
  }

  function isAnnotatedModelName(name) {
    // 带用途/限额/渠道标记的模型不参与重定向：用户应直接用完整模型名调用。
    // 例：gpt-5-nano [渠道id:33][輸出3k上限]
    const s = String(name || '');
    if (!(s.includes('[') || s.includes('('))) return false;
    const low = s.toLowerCase();
    const keywords = [
      '渠道', 'channel', 'channelid', 'id:',
      '上限', 'limit', 'quota',
      '输出', '輸出', 'output',
      '翻译', 'translate', 'translation',
      '专用', '專用', 'only',
      '限速', 'rate',
      '低延迟', 'latency',
    ];
    return keywords.some((k) => low.includes(String(k).toLowerCase()));
  }

  function normalizeSeparators(s) {
    return sanitizeModelName(String(s || ''))
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[._]/g, '-')
      .replace(/:+/g, '-') // :thinking -> -thinking
      .replace(/\/+/g, '/') // keep a single slash
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function dedupeAdjacentHyphenTokens(s) {
    // 通用后处理：折叠相邻重复 token，避免出现：
    // - mistral-medium-medium
    // - kimi-k2-thinking-thinking
    // 只处理“相邻且完全相同”的重复，不会影响 8x7b 之类结构。
    const str = String(s || '');
    if (!str.includes('-')) return str;
    const parts = str.split('-').filter(Boolean);
    if (parts.length <= 1) return str;
    const out = [];
    for (const p of parts) {
      if (!out.length || out[out.length - 1] !== p) out.push(p);
    }
    return out.join('-');
  }

  function dropWrapperTokens(tokens) {
    // 一些“特殊入口/包装器”不应该进入 canonical key，但允许作为渠道实际模型（value）存在。
    // 典型：cursor2-*（常用于特殊用途、代理、能力增强等）。
    const tks = tokens || [];
    return tks.filter((t) => t !== 'cursor2');
  }

  function isSpecializedModelName(s, familyHint) {
    // “专项/模态/管道”模型不应参与通用重定向（避免把通用 key 误打到专项 value）。
    // 这些模型建议用户直接用完整模型名调用。
    //
    // 注意：
    // - 不要把 thinking/reasoning/high 视为专项（它们属于同款模型的 mode）
    // - 不要把单独的 "image" 视为专项（如 gemini-*-image-preview 是常见标准模型）
    const low = String(s || '').toLowerCase();
    if (!low) return false;
    const fam = String(familyHint || '').toLowerCase();

    // 1) 明确专项域：robotics / computer-use
    if (low.includes('robotics')) return true;
    if (low.includes('computer-use') || low.includes('computeruse')) return true;

    // 2) TTS / ASR / STT / speech / transcription
    if (/(?:^|-)tts(?:$|-)/.test(low)) return true;
    if (/(?:^|-)asr(?:$|-)/.test(low)) return true;
    if (/(?:^|-)stt(?:$|-)/.test(low)) return true;
    if (/(?:^|-)speech(?:$|-)/.test(low)) return true;
    if (low.includes('transcription')) return true;

    // 3) Embedding / rerank / moderation（常见非聊天模态）
    if (/(?:^|-)embeddings?(?:$|-)/.test(low)) return true;
    // 上游常见简写：*-embed / *-embed-2505
    if (/(?:^|-)embed(?:$|-)/.test(low)) return true;
    if (/(?:^|-)rerank(?:$|-)/.test(low) || low.includes('reranker')) return true;
    if (/(?:^|-)moderation(?:$|-)/.test(low)) return true;

    // 4) Image generation / video generation（避免把 text key 映射到生成式多模态入口）
    if (low.includes('image-generation') || low.includes('imagegeneration')) return true;
    if (low.includes('video-generation') || low.includes('videogeneration')) return true;
    if (low.includes('text-to-image') || low.includes('text2image')) return true;
    if (low.includes('text-to-video') || low.includes('text2video')) return true;
    // 有些上游把 image-generation 拆成 image + generation（但不要误伤 image-preview）
    if (/(?:^|-)image(?:$|-)/.test(low) && /(?:^|-)generation(?:$|-)/.test(low)) return true;

    // 5) family 级例外（目前仅预留，不做 hardcode；需要时再加）
    if (fam === 'gemini') {
      // gemini-*-image-preview 允许（不是 image-generation）
    }
    return false;
  }

  function rewriteHighMajorDecimalSizeToHyphen(s) {
    // 有些上游会把 “世代-尺寸” 写成类似 “qwen3.4B / qwen-3.8b”。
    // 对 Qwen 这类模型而言，3.xB 通常不是“3.8B 参数量”，而是“Qwen3 + 8B”。
    //
    // 规则：
    // - 0.xb / 1.xb / 2.xb 这种小数尺寸（如 0.6B、1.5B、2.7B）保留小数点
    // - 3.xb 及以上：把小数点改为 '-'，让后续归一化走 “3-8b” 路径，避免误伤为 “3.8b”
    //
    // 仅做字符级改写，不改变其它结构；后续仍会走 normalizeSeparators。
    const str = String(s || '');
    return str.replace(/(\d+)\.(\d+)([bBmM])\b/g, (m, a, b, u) => {
      const major = parseInt(a, 10);
      if (Number.isNaN(major)) return m;
      if (major <= 2) return m; // 允许 0.6B / 1.5B / 2.7B
      return a + '-' + b + u; // 3.8B -> 3-8B
    });
  }

  function stripPublisherDashPrefix(name, familyHint) {
    // Example: "groq-llama-3.1-8b" -> "llama-3.1-8b"
    // Only strip if remainder contains the target family token.
    let s = String(name || '').trim();
    if (!s) return s;
    const low = s.toLowerCase();
    for (const p of PUBLISHER_DASH_PREFIXES) {
      if (!low.startsWith(p)) continue;
      const rest = s.slice(p.length);
      if (!rest) continue;
      const rl = rest.toLowerCase();
      if (familyHint) {
        if (rl.includes(familyHint)) return rest;
      } else {
        // Best-effort: if rest contains any known family token, allow stripping.
        if (detectFamily(rl)) return rest;
      }
    }
    return s;
  }

  function maybeDropOrgPrefix(name, familyHint) {
    // Drop "org/" prefixes. For known families we recursively drop multiple segments like:
    // - kimi-pro/moonshotai/kimi-k2-thinking -> kimi-k2-thinking
    // - pro/moonshotai/kimi-k2-instruct-0905 -> kimi-k2-instruct-0905
    // - tngtech/deepseek-r1t-chimera -> deepseek-r1t-chimera
    let s = String(name || '').trim();
    if (!s) return s;
    const want = familyHint ? String(familyHint).toLowerCase() : null;
    for (let guard = 0; guard < 4; guard++) {
      if (!s.includes('/')) break;
      const [org, rest] = s.split('/', 2);
      if (!org || !rest) break;
      const orgLow = String(org).toLowerCase();
      const restLow = String(rest).toLowerCase();

      // Wrapper org suffixes (e.g. zai-org/, kimi-pro/, *-vip/).
      const wrap = orgLow.match(/^(.*?)-(pro|vip|org)$/);
      const isWrapper = orgLow === 'pro' || orgLow === 'vip' || orgLow === 'org' || !!wrap;

      // For known families: if remainder still clearly belongs to the family, drop org even if unknown.
      const restHasFamily = want ? restLow.includes(want) : !!detectFamily(restLow);
      const allowDrop = isWrapper || ORG_PREFIXES.has(orgLow) || restHasFamily;

      if (!allowDrop) break;
      s = rest;
    }
    return s;
  }

  function detectFamily(norm) {
    const s = String(norm || '').toLowerCase();
    if (!s) return null;
    if (s.includes('claude')) return 'claude';
    if (s.includes('gemini')) return 'gemini';
    if (s.includes('gpt') || s.includes('chatgpt') || s.startsWith('openai/o') || s.includes('/gpt')) return 'gpt';
    if (s.includes('qwen')) return 'qwen';
    if (s.includes('deepseek')) return 'deepseek';
    if (s.includes('grok')) return 'grok';
    if (s.includes('glm')) return 'glm';
    if (s.includes('kimi')) return 'kimi';
    if (s.includes('llama')) return 'llama';
    if (s.includes('mistral') || s.includes('mixtral') || s.includes('codestral') || s.includes('pixtral')) return 'mistral';
    return null;
  }

  function stripDateAndBuildTokens(tokens) {
    // Drop date tokens:
    // - single token: 20250807 / 20250929 / 20260205
    // - split tokens: 2025-08-07 -> ["2025","08","07"] (after separator normalization)
    const out = [];
    const tks = tokens || [];
    for (let i = 0; i < tks.length; i++) {
      const t = tks[i];
      if (!t) continue;
      const s = String(t);
      if (/^20\d{6,8}$/.test(s)) continue;
      if (/^20\d{2}$/.test(s)) {
        const m = (i + 1 < tks.length) ? String(tks[i + 1] || '') : '';
        const d = (i + 2 < tks.length) ? String(tks[i + 2] || '') : '';
        if (/^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d)) {
          // Skip yyyy mm dd
          i += 2;
          continue;
        }
        // Also drop lone year token (2025)
        continue;
      }
      out.push(s);
    }
    return out;
  }

  function stripCommonNoiseTokens(tokens) {
    // Cross-provider noise: not a model identity.
    const drop = new Set(['free', 'trial', 'promo', 'demo', 'public', 'private', 'vip']);
    return (tokens || []).filter((t) => t && !drop.has(String(t)));
  }

  function uniqTokens(arr) {
    const out = [];
    const seen = new Set();
    for (const x of arr || []) {
      const s = String(x);
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  function mergeMinorVersionTokens(tokens) {
    // Turn ["4","7"] -> ["4.7"] (and similarly 3-3 -> 3.3), so we don't end up with "4.7-4-7".
    const out = [];
    const tks = tokens || [];
    for (let i = 0; i < tks.length; i++) {
      const a = tks[i];
      const b = (i + 1 < tks.length) ? tks[i + 1] : null;
      if (typeof a === 'string' && typeof b === 'string' && /^\d+$/.test(a) && /^\d$/.test(b)) {
        out.push(a + '.' + b);
        i++;
        continue;
      }
      out.push(a);
    }
    return out;
  }

  function mergeDecimalSuffixTokens(tokens) {
    // Turn ["0","6b"] -> ["0.6b"] so sizes like 0.6B don't split into "0" + "6b".
    // 注意：为了避免把 "qwen-3-4b" 误合并成 "3.4b"，这里仅允许 0/1/2 作为小数整数位。
    const out = [];
    const tks = tokens || [];
    for (let i = 0; i < tks.length; i++) {
      const a = String(tks[i] || '');
      const b = (i + 1 < tks.length) ? String(tks[i + 1] || '') : '';
      const m = b.match(/^(\d)([a-z]+)$/i);
      // 仅合并形如 0.6b / 1.5b / 2.7b 的 size token；其它后缀不合并，避免误伤。
      if ((a === '0' || a === '1' || a === '2') && m && (m[2].toLowerCase() === 'b' || m[2].toLowerCase() === 'm')) {
        out.push(a + '.' + m[1] + m[2].toLowerCase());
        i++;
        continue;
      }
      out.push(a);
    }
    return out;
  }

  function looksLikeSuspiciousDecimalSize(canonical) {
    // 形如 "qwen-3.4b" 基本都不合理（世代 3 + size 4b 不该变成 3.4b）。
    // 合法例外：0.6b / 1.5b / 2.7b 这类小数 size（已允许）。
    const s = String(canonical || '');
    const m = s.match(/(?:^|-)((\d+)\.(\d)(?:b|m))(?:$|-)/i);
    if (!m) return false;
    const major = parseInt(m[2], 10);
    if (Number.isNaN(major)) return false;
    return major >= 3;
  }

  function mergeVMinorTokens(tokens) {
    // Turn ["v3","1"] -> ["v3.1"] for DeepSeek-style versions that got split by separator normalization.
    const out = [];
    const tks = tokens || [];
    for (let i = 0; i < tks.length; i++) {
      const a = String(tks[i] || '');
      const b = (i + 1 < tks.length) ? String(tks[i + 1] || '') : '';
      if (/^v\d+$/i.test(a) && /^\d$/.test(b)) {
        out.push(a.toLowerCase() + '.' + b);
        i++;
        continue;
      }
      out.push(a);
    }
    return out;
  }

  function extractYmdBuildTag(tokens) {
    // Extract a pinned build tag (yyyymmdd) from:
    // - ["20250807"]
    // - ["2025","08","07"]
    // Returns { tokens, buildTag } where buildTag is yyyymmdd string (no separators).
    const tks = (tokens || []).map((t) => String(t));
    // 1) single token yyyymmdd
    for (let i = 0; i < tks.length; i++) {
      const s = tks[i];
      if (/^20\d{6,8}$/.test(s)) {
        const rest = tks.slice(0, i).concat(tks.slice(i + 1));
        return { tokens: rest, buildTag: s.slice(0, 8) };
      }
    }
    // 2) yyyy mm dd triple
    for (let i = 0; i < tks.length - 2; i++) {
      const y = tks[i], m = tks[i + 1], d = tks[i + 2];
      if (/^20\d{2}$/.test(y) && /^\d{1,2}$/.test(m) && /^\d{1,2}$/.test(d)) {
        const mm = m.padStart(2, '0');
        const dd = d.padStart(2, '0');
        const buildTag = y + mm + dd;
        const rest = tks.slice(0, i).concat(tks.slice(i + 3));
        return { tokens: rest, buildTag };
      }
    }
    return { tokens: tks, buildTag: null };
  }

  function extractTrailingNumericBuildTag(tokens, policy) {
    // 提取末尾纯数字 buildTag（如 2507/0414/0905/0528/20250807），用于 pinned key。
    // policy 控制接受的长度；只取“最后一个 token”，避免误伤中间数字（如 32b/120b）。
    const tks = (tokens || []).map((t) => String(t)).filter(Boolean);
    if (!tks.length) return { tokens: tks, buildTag: null };
    const pol = policy || {};
    const last = String(tks[tks.length - 1] || '');
    if (!/^\d+$/.test(last)) return { tokens: tks, buildTag: null };
    const n = last.length;
    const ok =
      (n === 4 && !!pol.accept4) ||
      (n === 6 && !!pol.accept6) ||
      (n === 8 && !!pol.accept8);
    if (!ok) return { tokens: tks, buildTag: null };
    return { tokens: tks.slice(0, -1), buildTag: last };
  }

  function stripGeminiBuildTokens(tokens) {
    // Gemini sometimes ends with build revisions like 001/002.
    return (tokens || []).filter((t) => !(typeof t === 'string' && /^\d{3}$/.test(t)));
  }

  function parseGlmVersionFromTokens(tokens) {
    // GLM often appears as: glm-4-6v[-flash] or glm-4-7[-flash] etc.
    // Prefer: 4.6v if present.
    for (let i = 0; i < (tokens || []).length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (/^\d+$/.test(a) && /^(\d+)v$/.test(b)) {
        return a + '.' + b; // 4.6v
      }
    }
    return null;
  }

  function parseQwenVersionFromTokens(tokens) {
    // Qwen "version" is the family generation: 2, 2.5, 3 ... (NOT sizes like 0.6b).
    for (const t of tokens || []) {
      const s = String(t);
      if (!s) continue;
      if (/^0(\.|$)/.test(s)) continue;
      if (/^\d+(\.\d+)?$/.test(s)) {
        const major = parseInt(s.split('.')[0], 10);
        if (major >= 1 && major <= 10) return s;
      }
    }
    return null;
  }

  function parseVersionFromTokens(tokens) {
    // Supports: 4.5 => ["4","5"], 4.1 => ["4","1"], 3.7 => ["3","7"], 2.5 => ["2","5"]
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d+\.\d+$/.test(t)) return t;
    }
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
        // Keep only typical minor versions (1,5,7 etc) to avoid sizes like 120b.
        if (b.length === 1) return a + '.' + b;
      }
    }
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d+$/.test(t) && t.length <= 2) return t;
    }
    return null;
  }

  function normalizeClaude(raw, extraModes = []) {
    // Goal: merge same version+tier, keep mode tokens, drop dates + weird suffixes.
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'claude');
    s = stripPublisherDashPrefix(s, 'claude');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('claude')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const ymd = extractYmdBuildTag(tokens0);
    const tokens1 = mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(ymd.tokens)));
    const tokens = tokens1.filter((t) => t !== 'claude');
    const tier = tokens.find((t) => t === 'haiku' || t === 'sonnet' || t === 'opus');
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    const version = parseVersionFromTokens(tokens);
    if (!tier || !version) return { canonical: 'claude-' + tokens.join('-'), pinnedCanonical: null };
    let can = `claude-${version}-${tier}`;
    if (mode.length) can += '-' + mode.join('-');
    const pinned = ymd.buildTag ? (can + '-' + ymd.buildTag) : null;
    return { canonical: can, pinnedCanonical: pinned };
  }

  function normalizeGemini(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'gemini');
    s = stripPublisherDashPrefix(s, 'gemini');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('gemini')) return null;
    // 专项模型不参与通用重定向（避免误映射）
    if (isSpecializedModelName(s, 'gemini')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const ymd = extractYmdBuildTag(tokens0);
    const tokens1 = mergeDecimalSuffixTokens(
      mergeMinorVersionTokens(
        stripGeminiBuildTokens(
          stripCommonNoiseTokens(stripDateAndBuildTokens(ymd.tokens))
        )
      )
    );
    const tokens = tokens1.filter((t) => t !== 'google' && t !== 'gemini');
    const version = parseVersionFromTokens(tokens);
    // 解析不出版本时直接放弃：不要生成 gemini-unknown-* 这种污染标准集的 key
    if (!version) return null;
    // tier tokens
    const tierParts = [];
    for (const t of tokens) {
      if (t === 'pro' || t === 'flash' || t === 'ultra' || t === 'nano') tierParts.push(t);
      if (t === 'lite') tierParts.push('lite');
      if (t === 'image') tierParts.push('image');
      if (t === 'preview') tierParts.push('preview');
      if (t === 'exp' || t === 'experimental') tierParts.push('experimental');
    }
    const tier = tierParts.length ? tierParts.join('-') : tokens.join('-');
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    let can = `gemini-${version}-${tier}`.replace(/-+/g, '-').replace(/-$/g, '');
    if (mode.length) can += '-' + mode.join('-');
    const pinned = ymd.buildTag ? (can + '-' + ymd.buildTag) : null;
    return { canonical: can.replace(/-+/g, '-').replace(/-$/g, ''), pinnedCanonical: pinned };
  }

  function normalizeGpt(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'gpt');
    s = stripPublisherDashPrefix(s, 'gpt');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    const low = s.toLowerCase();
    if (!(low.includes('gpt') || low.includes('chatgpt') || low.startsWith('o1') || low.startsWith('o3') || low.startsWith('o4') || low.includes('openai/o'))) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const ymd = extractYmdBuildTag(tokens0);
    const tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(ymd.tokens))));
    const tokens = dropWrapperTokens(tokens1.filter((t) => t !== 'openai' && t !== 'chatgpt'));
    // Normalize 4-1 => 4.1, 5-1 => 5.1
    const fixed = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d+$/.test(t) && i + 1 < tokens.length && /^\d+$/.test(tokens[i + 1]) && tokens[i + 1].length === 1) {
        fixed.push(t + '.' + tokens[i + 1]);
        i++;
        continue;
      }
      fixed.push(t);
    }
    // OpenAI "o*" models (o1/o3/o4-*) should NOT be forced under "gpt-" prefix.
    // Some upstreams incorrectly label them as "gpt-o3-..."; normalize those too.
    if (fixed[0] === 'gpt' && fixed.length >= 2) {
      const h2 = fixed[1] || '';
      const isO2 = /^o(?:1|3|4)$/.test(h2) || /^o(?:1|3|4)mini$/.test(h2) || /^o(?:1|3|4)-/.test(h2);
      if (isO2) fixed.shift(); // drop the misleading "gpt" prefix
    }
    const head = fixed[0] || '';
    const isOModel = /^o(?:1|3|4)$/.test(head) || /^o(?:1|3|4)mini$/.test(head) || /^o(?:1|3|4)-/.test(head);
    if (!isOModel) {
      // Prefer canonical as gpt-...
      if (fixed[0] !== 'gpt') fixed.unshift('gpt');
    }
    const mode = uniqTokens(fixed.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    let can = fixed.join('-').replace(/-+/g, '-');
    // Ensure mode tokens are suffix-only to avoid "high/gpt-..." style pollution.
    if (mode.length && !can.includes('-thinking') && mode.includes('thinking')) can += '-thinking';
    can = can.replace(/-+/g, '-');
    const pinned = ymd.buildTag ? (can + '-' + ymd.buildTag) : null;
    return { canonical: can, pinnedCanonical: pinned };
  }

  function normalizeDeepseek(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'deepseek');
    s = stripPublisherDashPrefix(s, 'deepseek');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('deepseek')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const ymd = extractYmdBuildTag(tokens0);
    const tokens1 = mergeVMinorTokens(
      mergeDecimalSuffixTokens(
        mergeMinorVersionTokens(
          stripCommonNoiseTokens(stripDateAndBuildTokens(ymd.tokens))
        )
      )
    );
    const tokens = tokens1.filter((t) => t !== 'deepseek' && t !== 'ai');
    if (!tokens.length) return null;
    // Prefer patterns: r1[-0528], v3[.1/.2]
    const hasR1 = tokens.includes('r1') || tokens.includes('deepseek-r1');
    const vTok = tokens.find((t) => /^v\d+(\.\d+)?$/.test(t)) || tokens.find((t) => /^v\d+$/.test(t));
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    if (hasR1) {
      // Avoid over-merging distill variants into the base r1 canonical.
      const distillIdx = tokens.findIndex((t) => t === 'distill' || t === 'distilled');
      if (distillIdx >= 0) {
        const rest = tokens.slice(distillIdx + 1).filter((t) => t && !MODE_TOKENS.has(t));
        let can = 'deepseek-r1-distill' + (rest.length ? '-' + rest.join('-') : '');
        if (mode.length) can += '-' + mode.join('-');
        return can.replace(/-+/g, '-');
      }
      const variant = tokens.find((t) => /^\d{3,4}$/.test(t)); // e.g. 0528
      let can = 'deepseek-r1';
      if (mode.length) can += '-' + mode.join('-');
      const pinned = variant ? (can + '-' + variant) : null;
      return { canonical: can, pinnedCanonical: pinned };
    }
    if (vTok) {
      let can = 'deepseek-' + vTok; // v3, v3.1
      if (mode.length) can += '-' + mode.join('-');
      const pinned = ymd.buildTag ? (can + '-' + ymd.buildTag) : null;
      return { canonical: can.replace(/-+/g, '-'), pinnedCanonical: pinned };
    }
    return { canonical: 'deepseek-' + tokens.join('-'), pinnedCanonical: null };
  }

  function normalizeQwen(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'qwen');
    s = stripPublisherDashPrefix(s, 'qwen');
    // 优先处理 “qwen3.8B” 这类写法，避免被当作小数参数量或产生奇怪 key。
    s = rewriteHighMajorDecimalSizeToHyphen(s);
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('qwen')) return null;
    // Normalize qwen2.5/qwen3 -> qwen-2.5/qwen-3
    s = s.replace(/^qwen(\d)/, 'qwen-$1');
    const tokens0 = s.split('-').filter(Boolean);
    const ymd = extractYmdBuildTag(tokens0);
    let tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(ymd.tokens))));
    const tokens = dropWrapperTokens(tokens1.filter((t) => t !== 'qwen'));
    const version = parseQwenVersionFromTokens(tokens) || parseVersionFromTokens(tokens);
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    // Keep size + instruct/coder etc as tier
    // Extract trailing build tag like 2507 for pinned keys.
    let buildTag = null;
    if (tokens1.length && /^\d{4}$/.test(tokens1[tokens1.length - 1]) && parseInt(tokens1[tokens1.length - 1], 10) >= 2000) {
      buildTag = tokens1[tokens1.length - 1];
      tokens1 = tokens1.slice(0, -1);
    }
    const tokensNoBuild = tokens1.filter((t) => t !== 'qwen');
    const tierTokens = tokensNoBuild
      .filter((t) => t !== version && !MODE_TOKENS.has(t))
      .map((t) => t.replace(/^(\d+)(b)$/, '$1b'));
    let can = 'qwen';
    if (version) can += '-' + version;
    if (tierTokens.length) can += '-' + tierTokens.join('-');
    if (mode.length) can += '-' + mode.join('-');
    can = can.replace(/-+/g, '-').replace(/-$/g, '');
    const pol = (FAMILY_PROFILES.qwen && FAMILY_PROFILES.qwen.pinnedPolicy) ? FAMILY_PROFILES.qwen.pinnedPolicy : {};
    const pinned = (buildTag && pol.enabled && pol.accept4) ? (can + '-' + buildTag) : (ymd.buildTag ? (can + '-' + ymd.buildTag) : null);
    return { canonical: can, pinnedCanonical: pinned };
  }

  function normalizeGrok(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'grok');
    s = stripPublisherDashPrefix(s, 'grok');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('grok')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(tokens0))));
    const tokens = dropWrapperTokens(tokens1.filter((t) => t !== 'grok'));
    // Tier: imagine, fast, code, etc. Mode: thinking/reasoning/high...
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    // 特例：上游常见 "grok-code-fast-1"，希望统一成稳定 key：grok-code-fast
    // 同时把 "grok-1-code" 这类别名折叠到 grok-code-fast（1 通常对应 fast 代次）。
    if (tokens.includes('code') && (tokens.includes('fast') || tokens.includes('1'))) {
      let can = 'grok-code-fast';
      if (mode.length) can += '-' + mode.join('-');
      return { canonical: can.replace(/-+/g, '-'), pinnedCanonical: null };
    }
    const version = parseVersionFromTokens(tokens);
    const tier = tokens.find((t) => t === 'fast' || t === 'mini' || t === 'code' || t === 'imagine');
    // Drop build tags like 1129/1103 etc if present.
    const kept = tokens.filter((t) => !/^\d{3,4}$/.test(t));
    let can = 'grok';
    if (tier === 'imagine') {
      const v2 = parseVersionFromTokens(kept) || version;
      const hasVideo = kept.includes('video');
      can = 'grok-imagine' + (v2 ? '-' + v2 : '') + (hasVideo ? '-video' : '');
    } else if (version) {
      can = 'grok-' + version + (tier ? '-' + tier : '');
    } else {
      can = 'grok-' + kept.join('-');
    }
    if (mode.length) can += '-' + mode.join('-');
    can = can.replace(/-+/g, '-');
    return { canonical: can, pinnedCanonical: null };
  }

  function normalizeGlm(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'glm');
    s = stripPublisherDashPrefix(s, 'glm');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('glm')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    // 兼容上游把 "glm4.7" 写成 "glm4-7"/"glm4.7"：拆成 glm + 4 + 7，避免版本被解析成 "7"。
    const tokens0b = [];
    for (const t of tokens0) {
      const m = String(t).match(/^glm(\d+)$/i);
      if (m) {
        tokens0b.push('glm', m[1]);
      } else {
        tokens0b.push(t);
      }
    }
    const tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(tokens0b))));
    const tokens = tokens1.filter((t) => t !== 'glm' && t !== 'zai' && t !== 'zhipu' && t !== 'zhipuai');
    const version = parseGlmVersionFromTokens(tokens) || parseVersionFromTokens(tokens);
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    let rest = tokens.filter((t) => t !== version && !MODE_TOKENS.has(t));
    // Drop common GLM build tags like 0414 (often mmdd).
    let buildTag = null;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (/^\d{4}$/.test(String(rest[i]))) {
        buildTag = String(rest[i]);
        rest = rest.slice(0, i).concat(rest.slice(i + 1));
        break;
      }
    }
    let can = 'glm';
    if (version) can += '-' + version;
    if (rest.length) can += '-' + rest.join('-');
    if (mode.length) can += '-' + mode.join('-');
    can = can.replace(/-+/g, '-').replace(/-$/g, '');
    const pol = (FAMILY_PROFILES.glm && FAMILY_PROFILES.glm.pinnedPolicy) ? FAMILY_PROFILES.glm.pinnedPolicy : {};
    const pinned = (buildTag && pol.enabled && pol.accept4) ? (can + '-' + buildTag) : null;
    return { canonical: can, pinnedCanonical: pinned };
  }

  function normalizeKimi(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'kimi');
    s = stripPublisherDashPrefix(s, 'kimi');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('kimi')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(tokens0))));
    const tokens = tokens1.filter((t) => t !== 'kimi');
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));

    // Kimi K2.* special normalization.
    // Examples:
    // - kimi-k2-5 -> kimi-k2.5
    // - kimi-k2.5 -> kimi-k2.5
    // - kimi-5-k2 -> kimi-k2.5
    if (tokens.includes('k2.5') || (tokens.includes('k2') && tokens.includes('5'))) {
      let can = 'kimi-k2.5';
      if (mode.length) can += '-' + mode.join('-');
      // pinned buildTag（如 0905）只在末尾出现时提取
      const pol = (FAMILY_PROFILES.kimi && FAMILY_PROFILES.kimi.pinnedPolicy) ? FAMILY_PROFILES.kimi.pinnedPolicy : {};
      const bt = extractTrailingNumericBuildTag(tokens, pol).buildTag;
      const pinned = bt ? (can + '-' + bt) : null;
      return { canonical: can, pinnedCanonical: pinned };
    }

    // Drop short build tags like 0905 (mmdd) for Kimi releases.
    const pol = (FAMILY_PROFILES.kimi && FAMILY_PROFILES.kimi.pinnedPolicy) ? FAMILY_PROFILES.kimi.pinnedPolicy : {};
    const ext = extractTrailingNumericBuildTag(tokens, pol);
    const tokensNoBuild = ext.tokens;
    const buildTag = ext.buildTag;
    const version = parseVersionFromTokens(tokensNoBuild);
    const rest = tokensNoBuild.filter((t) => t !== version && !MODE_TOKENS.has(t));
    let can = 'kimi';
    if (version) can += '-' + version;
    if (rest.length) can += '-' + rest.join('-');
    if (mode.length) can += '-' + mode.join('-');
    can = can.replace(/-+/g, '-').replace(/-$/g, '');
    const pinned = buildTag ? (can + '-' + buildTag) : null;
    return { canonical: can, pinnedCanonical: pinned };
  }

  function normalizeLlama(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'llama');
    s = stripPublisherDashPrefix(s, 'llama');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!s.includes('llama')) return null;
    const tokens0 = s.split('-').filter(Boolean);
    // 兼容 "llama3.1-8b" / "llama3-1-8b" 这类写法：把 "llama3" 拆成 "llama" + "3"
    // 并且：Llama 不存在 "1.8b" 这类小数 size，禁用 mergeDecimalSuffixTokens，避免把 "1"+"8b" 误合并成 "1.8b"。
    const tokens0b = [];
    for (const t of tokens0) {
      const m = String(t).match(/^llama(\d+)$/i);
      if (m) {
        tokens0b.push('llama', m[1]);
      } else {
        tokens0b.push(t);
      }
    }
    const tokens1 = mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(tokens0b)));
    const tokens = tokens1.filter((t) => t !== 'llama' && t !== 'meta');
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    const core = tokens.filter((t) => !MODE_TOKENS.has(t));

    // Special: prompt-guard / llama-guard should keep the guard version next to the name.
    if (core.includes('prompt') && core.includes('guard')) {
      const v = core.find((t) => /^\d+(\.\d+)?$/.test(t));
      const sz = core.find((t) => /^(?:\d+(?:\.\d+)?)(?:m|b)$/.test(t)) || core.find((t) => /^\d+(?:m|b)$/.test(t));
      let can = 'llama-prompt-guard' + (v ? '-' + v : '') + (sz ? '-' + sz : '');
      if (mode.length) can += '-' + mode.join('-');
      return { canonical: can.replace(/-+/g, '-').replace(/-$/g, ''), pinnedCanonical: null };
    }
    if (core.includes('guard')) {
      const v = core.find((t) => /^\d+(\.\d+)?$/.test(t));
      const sz = core.find((t) => /^(?:\d+(?:\.\d+)?)(?:m|b)$/.test(t)) || core.find((t) => /^\d+(?:m|b)$/.test(t));
      let can = 'llama-guard' + (v ? '-' + v : '') + (sz ? '-' + sz : '');
      // Keep any extra suffix tokens (like "instruct") after size if present.
      const extras = core.filter((t) => t !== 'guard' && t !== v && t !== sz && t !== 'llama' && t !== 'meta');
      if (extras.length) can += '-' + extras.join('-');
      if (mode.length) can += '-' + mode.join('-');
      return { canonical: can.replace(/-+/g, '-').replace(/-$/g, ''), pinnedCanonical: null };
    }

    const version = parseVersionFromTokens(core);
    const rest = core
      .filter((t) => t !== version)
      .map((t) => t.replace(/^(\d+)(b)$/, '$1b'));
    let can = 'llama';
    if (version) can += '-' + version;
    if (rest.length) can += '-' + rest.join('-');
    if (mode.length) can += '-' + mode.join('-');
    return { canonical: can.replace(/-+/g, '-').replace(/-$/g, ''), pinnedCanonical: null };
  }

  function normalizeMistral(raw, extraModes = []) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    s = maybeDropOrgPrefix(s, 'mistral');
    s = stripPublisherDashPrefix(s, 'mistral');
    s = normalizeSeparators(s);
    if (isRouteOrTag(raw) || startsWithHardWrapper(raw) || isPointerAlias(raw)) return null;
    if (!(s.includes('mistral') || s.includes('mixtral') || s.includes('codestral') || s.includes('pixtral'))) return null;
    const tokens0 = s.split('-').filter(Boolean);
    const tokens1 = mergeDecimalSuffixTokens(mergeMinorVersionTokens(stripCommonNoiseTokens(stripDateAndBuildTokens(tokens0))));
    const tokens = tokens1.filter((t) => t !== 'mistral');
    const mode = uniqTokens(tokens.filter((t) => MODE_TOKENS.has(t)).concat(extraModes || []).concat(ex.modes || []));
    let can = tokens1.join('-'); // already normalized
    if (!can.includes('mistral')) can = 'mistral-' + can;
    if (mode.length) can += '-' + mode.join('-');
    return { canonical: can.replace(/-+/g, '-').replace(/-$/g, ''), pinnedCanonical: null };
  }

  function normalizeGeneric(raw) {
    const ex = extractModeWrappers(raw);
    let s = ex.name;
    s = stripPointerSuffix(s);
    // Keep org prefix for unknown families; drop only common wrappers.
    s = normalizeSeparators(s);
    s = s.replace(/:free$/i, '').replace(/-free$/i, '');
    // Strip common publisher prefixes even for generic; safe because it only affects canonical.
    s = stripPublisherDashPrefix(s, null);
    // Apply mode wrappers as suffix tokens (keep semantics).
    if (ex.modes && ex.modes.length) s += '-' + ex.modes.join('-');
    return { canonical: s, pinnedCanonical: null };
  }

  const _normCache = new Map();
  function normalizeModel(raw) {
    const r = String(raw || '').trim();
    if (!r) return null;
    if (_normCache.has(r)) return _normCache.get(r);
    if (isRouteOrTag(r)) return null;
    if (isPointerAlias(r)) return null;
    const annotated = isAnnotatedModelName(r);
    if (startsWithHardWrapper(r)) return null; // user prefers "call full wrapper model directly"
    const ex = extractModeWrappers(r);
    const base = stripHardWrapperPrefixes(ex.name);
    const stripped = normalizeSeparators(stripPublisherDashPrefix(maybeDropOrgPrefix(base, null), null));
    const fam = detectFamily(stripped);
    const res = normalizeByFamily(fam, r, ex.modes);
    if (!res) return null;
    const can = typeof res === 'string' ? res : res.canonical;
    if (!can) return null;
    const can2 = dedupeAdjacentHyphenTokens(String(can));
    // 兜底：canonical 形态不合法则直接丢弃（避免污染 standards / mapping key）
    if (fam && !canonicalOk(fam, can2)) return null;
    const pinned0 = (typeof res === 'object' && res.pinnedCanonical) ? String(res.pinnedCanonical) : null;
    const pinned = pinned0 ? dedupeAdjacentHyphenTokens(pinned0) : null;
    const out = { raw: r, family: fam, canonical: can2, pinnedCanonical: pinned, annotated };
    _normCache.set(r, out);
    return out;
  }

  function mappingDiff(before, after) {
    const b = before || {};
    const a = after || {};
    const added = {};
    const removed = {};
    const changed = {};
    for (const k of Object.keys(b)) {
      if (!(k in a)) removed[k] = b[k];
      else if (String(b[k]) !== String(a[k])) changed[k] = { before: b[k], after: a[k] };
    }
    for (const k of Object.keys(a)) {
      if (!(k in b)) added[k] = a[k];
    }
    return { added, removed, changed };
  }

  function detectCycle(mapping) {
    // mapping is key->value. Cycle exists if values are keys and forms loop length>1.
    const m = mapping || {};
    const keys = new Set(Object.keys(m));
    const seen = new Set();
    for (const start of keys) {
      if (seen.has(start)) continue;
      let cur = start;
      const path = new Set();
      while (keys.has(cur)) {
        if (path.has(cur)) return true;
        path.add(cur);
        seen.add(cur);
        const nxt = String(m[cur] || '');
        if (!nxt) break;
        cur = nxt;
      }
    }
    return false;
  }

  function buildPlanForChannel(channel, standardsByFamily, selectedFamilies, pinnedEnabled) {
    const models = toModelList(channel.models);
    const normalized = [];
    for (const m of models) {
      const n = normalizeModel(m);
      if (n && n.family && selectedFamilies.has(n.family)) normalized.push(n);
    }
    const byCanonical = new Map(); // canonical -> [{raw,pinnedCanonical,annotated}]
    for (const n of normalized) {
      const arr = byCanonical.get(n.canonical) || [];
      arr.push({ raw: n.raw, pinnedCanonical: n.pinnedCanonical || null, annotated: !!n.annotated });
      byCanonical.set(n.canonical, arr);
    }

    const before = channel.model_mapping || {};
    const modelSet = new Set(models.map(String));
    const standardSet = new Set();
    for (const fam of Array.from(selectedFamilies)) {
      for (const s of (standardsByFamily[fam] || [])) standardSet.add(String(s));
    }

    // 先“保留”旧映射里已正确的条目，减少无意义 churn，保护手工配置。
    // 规则同后端脚本：key 必须是标准 canonical，value 必须是本渠道真实模型且不属于标准集，且未被占用。
    const after = {};
    const reasonsByKey = {};
    for (const [k, v] of Object.entries(before)) {
      const nk = normalizeModel(k);
      const nv = normalizeModel(v);
      const fk = nk && nk.family ? nk.family : null;
      const fv = nv && nv.family ? nv.family : null;
      if ((fk && selectedFamilies.has(fk)) || (fv && selectedFamilies.has(fv))) {
        const key = String(k);
        const val = String(v);
        const valNorm = nv;
        const valAnnotated = !!(valNorm && valNorm.annotated);
        if (
          standardSet.has(key) &&
          modelSet.has(val) &&
          !standardSet.has(val) &&
          !valAnnotated
        ) {
          // 仅当不会导致回环/互映才保留
          if (key !== val && !Object.prototype.hasOwnProperty.call(after, val)) {
            after[key] = val;
            reasonsByKey[key] = { value: val, reasons: ['keep_old'] };
            continue;
          }
        }
        continue; // family 范围内其它条目交给后续重建
      }
      after[String(k)] = String(v);
    }

    const usedValues = new Set(Object.values(after).map((x) => String(x)));

    for (const fam of Array.from(selectedFamilies)) {
      const standards = standardsByFamily[fam] || [];
      for (const standardCan of standards) {
        const variants = byCanonical.get(standardCan);
        if (!variants || !variants.length) continue;
        // If channel already has exact same name, skip redirect.
        if (variants.some((v) => String(v.raw) === String(standardCan))) continue;
        // Choose best variant to use as actual value.
        const best = chooseBestActualVariant(standardCan, variants, {
          oldMapping: before,
          standardSet,
          usedValues,
        });
        if (!best) continue;
        const bestRaw = String(best.raw);
        if (bestRaw === standardCan) continue;
        // 不允许把“带用途/限额备注”的模型当作重定向目标
        if (best.annotated) continue;
        // 不允许 value 落到标准集合里（防止别名互映/回环温床）
        if (standardSet.has(bestRaw)) continue;
        // 默认仍保持“actual 不复用”，但 pinned key 允许复用同一个 actual
        if (usedValues.has(bestRaw)) continue;
        // Prevent cycles: don't map to something that is also a key.
        if (Object.prototype.hasOwnProperty.call(after, bestRaw)) continue;
        after[standardCan] = bestRaw;
        usedValues.add(bestRaw);
        reasonsByKey[standardCan] = { value: bestRaw, reasons: Array.isArray(best.reasons) ? best.reasons : [] };

        // Optional: also emit pinned key (canonical+build/date) mapping to the same actual.
        // This is intentionally allowed to reuse the same actual value.
        if (pinnedEnabled && best.pinnedCanonical) {
          const pk = String(best.pinnedCanonical);
          if (pk && !pk.includes('/') && pk !== standardCan && pk !== bestRaw && !Object.prototype.hasOwnProperty.call(after, pk)) {
            after[pk] = bestRaw; // pinned key 允许复用同一个 actual value
            reasonsByKey[pk] = { value: bestRaw, reasons: ['pinned'].concat(Array.isArray(best.reasons) ? best.reasons : []) };
          }
        }
      }
    }

    // Safety: no cycles
    if (detectCycle(after)) {
      return { ok: false, error: 'mapping_contains_cycle', before, after: before };
    }
    // Safety: no mutual reverse pairs (A->B and B->A)
    // (cycle detection covers, but keep explicit check for clearer error)
    for (const [k, v] of Object.entries(after)) {
      if (after[String(v)] === String(k)) {
        return { ok: false, error: 'mapping_contains_mutual_pair', before, after: before };
      }
    }
    const warnings = [];
    // 额外风险提示：value 落在标准集里（即使未构成回环，也很可疑）
    for (const [k, v] of Object.entries(after)) {
      if (standardSet.has(String(v))) warnings.push({ type: 'value_in_standards', key: k, value: v });
    }
    return { ok: true, before, after, diff: mappingDiff(before, after), warnings, reasons: reasonsByKey };
  }

  function chooseBestActualVariant(standardCan, variants, ctx) {
    // 候选选择尽量对齐后端脚本：
    // - 优先保留旧 value（降低 churn）
    // - 优先选择带日期/带 org 的“更像真实模型名”的 candidate
    // - 禁止选到标准集里的名字，避免别名互映/回环温床
    const oldValues = new Set(Object.values((ctx && ctx.oldMapping) || {}).map((x) => String(x)));
    const standardSet = (ctx && ctx.standardSet) ? ctx.standardSet : new Set();
    const scored = (variants || [])
      .map((v) => {
        const raw = String(v && v.raw ? v.raw : v);
        const low = raw.toLowerCase();
        const pinnedCanonical = (v && v.pinnedCanonical) ? String(v.pinnedCanonical) : null;
        const annotated = !!(v && v.annotated);
        const family = (v && v.family) ? String(v.family) : '';
        const reasons = [];
        // 备注用途的模型不参与重定向
        if (annotated) return null;
        // 专项/模态模型不参与通用重定向（用户应直接调用完整名）
        if (isSpecializedModelName(raw, family)) return null;
        // value 不允许落入标准集
        if (standardSet.has(raw)) return null;
        let score = 0;
        if (oldValues.has(raw)) { score += 4; reasons.push('old'); }
        if (low.includes('/')) { score += 2; reasons.push('org'); } // org/model 更像真实模型名
        if (/(?:^|-)20\d{6,8}(?:$|-)/.test(low)) { score += 3; reasons.push('date'); } // 官方日期后缀
        if (/\b\d{4}\b/.test(low)) { score += 1; reasons.push('build'); } // buildTag，如 0528/2507/0414/0905
        if (low.includes(':thinking') || low.includes('-thinking')) { score += 1; reasons.push('mode'); }
        if (low.includes('cursor2')) reasons.push('wrapper');
        if (low.startsWith('假流式/') || low.startsWith('伪流式/') || low.startsWith('流式抗截断/')) score -= 100;
        return { raw, pinnedCanonical, annotated, score, reasons };
      })
      .filter(Boolean)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const la = a.raw.length;
        const lb = b.raw.length;
        if (la !== lb) return la - lb;
        return a.raw.localeCompare(b.raw);
      });
    return scored.length ? scored[0] : null;
  }

  function buildStandards(selectedFamilies, snapshotChannels) {
    // Start from DEFAULT_STANDARDS, then auto-extend from observed canonicals (safe-only).
    const out = {};
    for (const fam of selectedFamilies) {
      out[fam] = Array.from(new Set((DEFAULT_STANDARDS[fam] || []).map((x) => String(x))));
    }

    // Auto extend: only for canonicals that look like "family-...".
    for (const ch of snapshotChannels) {
      const models = toModelList(ch.models);
      for (const m of models) {
        const n = normalizeModel(m);
        if (!n || !n.family || !selectedFamilies.has(n.family)) continue;
        // 带用途/限额备注的模型不加入标准集合（用户应直接调用完整名）
        if (n.annotated) continue;
        // 专项/模态模型不加入标准集合（避免污染标准集）
        if (isSpecializedModelName(m, n.family)) continue;
        const can = String(n.canonical);
        if (!out[n.family]) out[n.family] = [];
        out[n.family].push(can);
      }
    }
    for (const fam of Object.keys(out)) {
      // Normalize standards again to guarantee "canonical keys" are clean (no org wrappers, no slashes).
      const cleaned = [];
      for (const s of out[fam]) {
        const n = normalizeModel(s);
        if (!n || n.family !== fam) continue;
        const can = String(n.canonical || '');
        if (!can) continue;
        if (!canonicalOk(fam, can)) continue;
        cleaned.push(can);
      }
      out[fam] = Array.from(new Set(cleaned)).sort();
    }
    return out;
  }

  function summarizePlan(perChannel) {
    const summary = {};
    for (const fam of DEFAULT_FAMILIES) {
      summary[fam] = { changed_channels: 0, removed: 0, added: 0, changed: 0, warnings: 0 };
    }
    for (const [cid, rec] of Object.entries(perChannel || {})) {
      if (!rec || !rec.ok) continue;
      const d = rec.diff || { added: {}, removed: {}, changed: {} };
      const famSeen = new Set();
      const bump = (fam, field, n) => {
        if (!fam || !summary[fam]) return;
        summary[fam][field] += Number(n || 0);
        famSeen.add(fam);
      };
      for (const k of Object.keys(d.added || {})) {
        const n = normalizeModel(k);
        bump(n && n.family ? n.family : null, 'added', 1);
      }
      for (const k of Object.keys(d.removed || {})) {
        const n = normalizeModel(k);
        bump(n && n.family ? n.family : null, 'removed', 1);
      }
      for (const k of Object.keys(d.changed || {})) {
        const n = normalizeModel(k);
        bump(n && n.family ? n.family : null, 'changed', 1);
      }
      const warns = Array.isArray(rec.warnings) ? rec.warnings : [];
      for (const w of warns) {
        const nk = normalizeModel(w && w.key ? w.key : '');
        bump(nk && nk.family ? nk.family : null, 'warnings', 1);
      }
      for (const fam of Array.from(famSeen)) {
        summary[fam].changed_channels += 1;
      }
    }
    return summary;
  }

  function makeWorker() {
    // Worker is self-contained: embed the normalization + plan logic.
    const workerSrc = `
      const ROUTE_TAG_EXACT_BLACKLIST = new Set(${JSON.stringify(Array.from(ROUTE_TAG_EXACT_BLACKLIST))});
      const HARD_WRAPPER_PREFIXES = ${JSON.stringify(HARD_WRAPPER_PREFIXES)};
      const MODE_WRAPPER_PREFIXES = ${JSON.stringify(MODE_WRAPPER_PREFIXES)};
      const PUBLISHER_DASH_PREFIXES = ${JSON.stringify(PUBLISHER_DASH_PREFIXES)};
      const ORG_PREFIXES = new Set(${JSON.stringify(Array.from(ORG_PREFIXES))});
      const POINTER_SUFFIX_RE = ${POINTER_SUFFIX_RE};
      const MODE_TOKENS = new Set(${JSON.stringify(Array.from(MODE_TOKENS))});
      const DEFAULT_FAMILIES = ${JSON.stringify(DEFAULT_FAMILIES)};
      const _normCache = new Map();

      ${toModelList.toString()}
      ${isRouteOrTag.toString()}
      ${startsWithHardWrapper.toString()}
      ${extractModeWrappers.toString()}
      ${stripHardWrapperPrefixes.toString()}
      ${isPointerAlias.toString()}
      ${stripPointerSuffix.toString()}
	      ${sanitizeModelName.toString()}
	      ${isAnnotatedModelName.toString()}
	      ${normalizeSeparators.toString()}
	      ${dedupeAdjacentHyphenTokens.toString()}
	      ${dropWrapperTokens.toString()}
	      ${isSpecializedModelName.toString()}
	      ${rewriteHighMajorDecimalSizeToHyphen.toString()}
	      ${stripPublisherDashPrefix.toString()}
	      ${maybeDropOrgPrefix.toString()}
	      ${detectFamily.toString()}
      ${stripDateAndBuildTokens.toString()}
      ${stripCommonNoiseTokens.toString()}
      ${uniqTokens.toString()}
      ${mergeMinorVersionTokens.toString()}
      ${mergeDecimalSuffixTokens.toString()}
      ${mergeVMinorTokens.toString()}
      ${extractYmdBuildTag.toString()}
      ${stripGeminiBuildTokens.toString()}
      ${parseVersionFromTokens.toString()}
      ${parseGlmVersionFromTokens.toString()}
      ${parseQwenVersionFromTokens.toString()}
      ${normalizeClaude.toString()}
      ${normalizeGemini.toString()}
      ${normalizeGpt.toString()}
      ${normalizeDeepseek.toString()}
      ${normalizeQwen.toString()}
      ${normalizeGrok.toString()}
      ${normalizeGlm.toString()}
      ${normalizeKimi.toString()}
      ${normalizeLlama.toString()}
      ${normalizeMistral.toString()}
      ${normalizeGeneric.toString()}
      const FAMILY_PROFILES = ${JSON.stringify(FAMILY_PROFILES)};
      ${extractTrailingNumericBuildTag.toString()}
      ${canonicalOk.toString()}
      ${normalizeByFamily.toString()}
      ${normalizeModel.toString()}
      ${mappingDiff.toString()}
      ${detectCycle.toString()}
      ${chooseBestActualVariant.toString()}
      ${buildPlanForChannel.toString()}
      ${summarizePlan.toString()}

      self.onmessage = (ev) => {
        const msg = ev.data || {};
        if (msg.type !== 'run') return;
        const { channels, families, standardsByFamily, pinnedKeys } = msg.payload || {};
        const perChannel = {};
        const total = (channels && channels.length) ? channels.length : 1;
        const t0 = Date.now();
        for (let i = 0; i < (channels || []).length; i++) {
          const ch = channels[i];
          try {
            const rec = buildPlanForChannel(ch, standardsByFamily, new Set(families || []), !!pinnedKeys);
            perChannel[String(ch.id)] = rec;
          } catch (e) {
            perChannel[String(ch.id)] = { ok: false, error: String(e && e.message ? e.message : e) };
          }
          if (i % 3 === 0) {
            self.postMessage({ type: 'progress', pct: Math.floor(((i + 1) * 100) / total), text: 'dry-run ' + (i + 1) + '/' + total });
          }
        }
        const summary = summarizePlan(perChannel);
        self.postMessage({ type: 'done', result: { perChannel, summary, elapsed_s: (Date.now()-t0)/1000 }});
      };
    `;
    const blob = new Blob([workerSrc], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    return new Worker(url);
  }

  async function loadSnapshot(force = false) {
    state.loading = true;
    render();
    try {
      if (!force) {
        const cached = await idbGet('snapshot');
        if (cached && cached.channels && cached.channels.length) {
          // 兜底：缓存快照也做一次去重+正序，避免旧缓存倒序/重复。
          const chans = uniqChannelsById(cached.channels).sort((a, b) => Number(a.id) - Number(b.id));
          state.snapshot = { ...cached, channels: chans };
          state.loading = false;
          render();
          return;
        }
      }
      const pageSize = 100;
      const all = [];
      const seen = new Set();
      let p = 0;
      while (true) {
        const data = await fetchJSON(`/api/channel/?p=${p}&page_size=${pageSize}&id_sort=true&tag_mode=false&status=-1`);
        const items = (data && data.data && data.data.items) ? data.data.items : [];
        for (const it of items) {
          const idKey = it && it.id != null ? String(it.id) : '';
          if (idKey && seen.has(idKey)) continue;
          if (idKey) seen.add(idKey);
          const mm = safeParseJSON(it.model_mapping) || {};
          all.push({
            id: it.id,
            name: it.name,
            group: it.group || '',
            status: it.status,
            models: toModelList(it.models),
            model_mapping: mm,
          });
        }
        if (items.length < pageSize) break;
        p++;
      }
      all.sort((a, b) => Number(a.id) - Number(b.id));
      state.snapshot = { ts: Date.now(), channels: all };
      await idbSet('snapshot', state.snapshot);
    } finally {
      state.loading = false;
      render();
    }
  }

  function normalizeFamiliesInput(families) {
    // 统一 families 输入：去重 + 仅保留已知 family，避免 UI/调用方传入脏数据导致“跨家族混入”
    const out = [];
    const seen = new Set();
    for (const f of (families || [])) {
      const fam = String(f || '').trim().toLowerCase();
      if (!fam) continue;
      if (!DEFAULT_FAMILIES.includes(fam)) continue;
      if (seen.has(fam)) continue;
      seen.add(fam);
      out.push(fam);
    }
    return out;
  }

  async function runDryRun(opts) {
    if (!state.snapshot || !state.snapshot.channels) throw new Error('请先加载全量渠道');
    state.running = true;
    state.plan = null;
    state.progress = { pct: 1, text: '启动 dry-run...' };
    render();
    try {
      // families 默认来自面板里的 Families 多选；但仪表盘也可能传入单 family（例如只跑 gemini）。
      // 关键：计算阶段必须严格按 families 分桶，否则会出现“点了 gemini 却把 kimi/mistral 也算进来”的现象。
      const families = normalizeFamiliesInput((opts && Array.isArray(opts.families)) ? opts.families : Array.from(state.families));
      if (!families.length) throw new Error('families_empty');
      const standardsByFamily = buildStandards(new Set(families), state.snapshot.channels);
      const worker = makeWorker();
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (ev) => {
          const msg = ev.data || {};
          if (msg.type === 'progress') {
            state.progress = { pct: msg.pct || 0, text: msg.text || '' };
            render();
          } else if (msg.type === 'done') {
            resolve(msg.result);
            worker.terminate();
          }
        };
        worker.onerror = (e) => {
          reject(e);
          worker.terminate();
        };
        worker.postMessage({ type: 'run', payload: { channels: state.snapshot.channels, families, standardsByFamily, pinnedKeys: !!state.pinnedKeys } });
      });
      state.plan = { ts: Date.now(), script_version: SCRIPT_VERSION, snapshot_ts: state.snapshot ? state.snapshot.ts : null, families, standardsByFamily, ...result };
      await idbSet('plan', state.plan);
      state.progress = { pct: 100, text: `完成，用时 ${Number(result.elapsed_s || 0).toFixed(2)}s` };
    } finally {
      state.running = false;
      render();
    }
  }

  async function applyPlan() {
    if (!state.plan || !state.plan.perChannel) throw new Error('请先运行 dry-run');
    state.applying = true;
    state.progress = { pct: 1, text: '写入中...' };
    render();
    try {
      // Only write changed channels (diff non-empty).
      const entries = Object.entries(state.plan.perChannel).filter(([, rec]) => {
        if (!rec || !rec.ok) return false;
        const d = rec.diff || {};
        return Object.keys(d.added || {}).length || Object.keys(d.removed || {}).length || Object.keys(d.changed || {}).length;
      });
      // 强制写库前存档：只备份“本次将写入”的渠道，避免整库备份过大。
      if (entries.length) {
        const plans = entries.map(([cid, rec]) => ({ id: cid, after: rec.after || {} }));
        await buildCheckpointBeforeWrite('apply_all', plans, `apply_all:${entries.length}`);
      }
      const total = entries.length || 1;
      let done = 0;
      const okList = [];
      const failList = [];
      const tAll0 = Date.now();
      for (const [cid, rec] of entries) {
        const ch = (state.snapshot && state.snapshot.channels) ? state.snapshot.channels.find((x) => String(x.id) === String(cid)) : null;
        const chName = ch ? String(ch.name || '').trim() : '';
        const title = chName ? (`${cid} ${chName}`) : String(cid);
        done++;
        const t0 = Date.now();
        const pct = Math.floor((done * 100) / total);
        state.progress = { pct, text: `写入 ${done}/${total} | ${title}` };
        render();
        try {
          const payload = { id: Number(cid), model_mapping: JSON.stringify(rec.after || {}) };
          await fetchJSON('/api/channel/', { method: 'PUT', body: JSON.stringify(payload) });
          const dt = (Date.now() - t0) / 1000;
          okList.push({ id: Number(cid), name: chName, seconds: Number(dt.toFixed(2)) });
          const elapsed = (Date.now() - tAll0) / 1000;
          const avg = elapsed / done;
          const remain = avg * Math.max(0, total - done);
          state.progress = { pct, text: `写入 ${done}/${total} | ${title} | 本次 ${dt.toFixed(2)}s | 预计剩余 ${remain.toFixed(0)}s` };
          render();
        } catch (e) {
          const dt = (Date.now() - t0) / 1000;
          failList.push({ id: Number(cid), name: chName, seconds: Number(dt.toFixed(2)), error: String(e && e.message ? e.message : e) });
          state.progress = { pct, text: `写入失败 ${done}/${total} | ${title} | ${dt.toFixed(2)}s` };
          render();
        }
      }
      // Refresh snapshot from server next time.
      await idbSet('snapshot', null);
      const elapsedAll = (Date.now() - tAll0) / 1000;
      state.progress = { pct: 100, text: `写入完成：成功 ${okList.length} / 失败 ${failList.length} | 用时 ${elapsedAll.toFixed(1)}s` };
      // 供仪表盘展示的摘要（不写入 DB，仅本地）
      state.lastApply = { ts: Date.now(), total: entries.length, ok: okList, failed: failList, elapsed_s: Number(elapsedAll.toFixed(2)) };
    } finally {
      state.applying = false;
      render();
    }
  }

  async function applyPlanWithOpts(opts) {
    // 确认弹窗应在“详情页（仪表盘）”完成，这里仅提供兜底确认。
    const o = opts || {};
    if (!o.skipConfirm) {
      const ok = confirm('即将写入数据库：请确认你已在仪表盘详情页审阅 dry-run 结果无误。继续写入？');
      if (!ok) return;
    }
    return applyPlan();
  }

  async function applyOneWithOpts(channelId, opts) {
    if (!state.plan || !state.plan.perChannel) throw new Error('请先运行 dry-run');
    const cid = String(channelId);
    const rec = state.plan.perChannel[cid];
    if (!rec || !rec.ok) throw new Error('该渠道无可用 plan');
    const d = rec.diff || {};
    const changed = Object.keys(d.added || {}).length || Object.keys(d.removed || {}).length || Object.keys(d.changed || {}).length;
    if (!changed) throw new Error('该渠道无变更，无需写入');
    const o = opts || {};
    if (!o.skipConfirm) {
      const ok = confirm(`即将写入 channel ${cid}：请确认你已在仪表盘详情页审阅无误。继续写入？`);
      if (!ok) return;
    }
    // 强制写库前存档（单渠道）。
    await buildCheckpointBeforeWrite('apply_one', [{ id: cid, after: rec.after || {} }], `apply_one:${cid}`);
    const payload = { id: Number(cid), model_mapping: JSON.stringify(rec.after || {}) };
    await fetchJSON('/api/channel/', { method: 'PUT', body: JSON.stringify(payload) });
  }

  async function rollbackCheckpoint(checkpointId) {
    const id = String(checkpointId || '');
    if (!id) throw new Error('checkpoint_id_empty');
    const cps = await getCheckpoints();
    const cp = cps.find((x) => x && String(x.id) === id);
    if (!cp) throw new Error('checkpoint_not_found');
    const channels = Array.isArray(cp.channels) ? cp.channels : [];
    if (!channels.length) throw new Error('checkpoint_empty');

    // 回滚前强制再存一份“回滚前快照”，避免覆盖当前手工修复后的映射且无法找回。
    const targetPlans = channels.map((c) => ({ id: c.id, after: (c && c.before) ? c.before : {} }));
    await buildCheckpointBeforeWrite('rollback_pre', targetPlans, `pre_rollback_of:${id}`);

    state.applying = true;
    state.progress = { pct: 1, text: `回滚中... (${id})` };
    render();
    const okList = [];
    const failList = [];
    const total = channels.length || 1;
    const tAll0 = Date.now();
    try {
      for (let i = 0; i < channels.length; i++) {
        const c = channels[i] || {};
        const cid = String(c.id);
        const title = (c && c.name) ? (`${cid} ${String(c.name)}`) : cid;
        const t0 = Date.now();
        const pct = Math.floor(((i + 1) * 100) / total);
        state.progress = { pct, text: `回滚 ${i + 1}/${total} | ${title}` };
        render();
        try {
          const payload = { id: Number(cid), model_mapping: JSON.stringify(c.before || {}) };
          await fetchJSON('/api/channel/', { method: 'PUT', body: JSON.stringify(payload) });
          const dt = (Date.now() - t0) / 1000;
          okList.push({ id: Number(cid), name: c.name || '', seconds: Number(dt.toFixed(2)) });
        } catch (e) {
          const dt = (Date.now() - t0) / 1000;
          failList.push({ id: Number(cid), name: c.name || '', seconds: Number(dt.toFixed(2)), error: String(e && e.message ? e.message : e) });
        }
      }
      await idbSet('snapshot', null);
      const elapsedAll = (Date.now() - tAll0) / 1000;
      state.progress = { pct: 100, text: `回滚完成：成功 ${okList.length} / 失败 ${failList.length} | 用时 ${elapsedAll.toFixed(1)}s` };
      state.lastApply = { ts: Date.now(), total: channels.length, ok: okList, failed: failList, elapsed_s: Number(elapsedAll.toFixed(2)), kind: 'rollback', checkpoint_id: id };
    } finally {
      state.applying = false;
      render();
    }
  }

  async function rollbackLastCheckpoint() {
    const cps = await getCheckpoints();
    // 默认只回滚最近一次“写入相关”的存档点（apply_one/apply_all）
    const last = cps.slice().reverse().find((x) => x && (String(x.kind) === 'apply_all' || String(x.kind) === 'apply_one'));
    if (!last) throw new Error('no_apply_checkpoint');
    return rollbackCheckpoint(last.id);
  }

  function openDashboard() {
    // Keep `window.opener` for about:blank so dashboard can reuse auth/session + cached plan.
    const w = window.open('', '_blank');
    if (!w) {
      alert('无法打开新窗口：请检查浏览器是否拦截弹窗');
      return;
    }
    const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Model Redirect Toolkit Dashboard</title>
  <style>
    /* Claude-ish tokens: warm dark default + light override. */
    :root{
      --bg-paper:#191918;
      --bg-surface:#242423;
      --bg-subtle:#2C2C2B;
      --bg-code:#222221;
      --text-primary:#ECEBE6;
      --text-secondary:#A1A09A;
      --text-tertiary:#6E6D69;
      --accent:#D97757;
      --accent-faint:rgba(217,119,87,0.16);
      --border:rgba(255,255,255,0.12);
      --border2:rgba(255,255,255,0.08);
      --shadow-sm:0 1px 2px rgba(0,0,0,0.3);
      --shadow-md:0 12px 38px rgba(0,0,0,0.45);

      --bg: var(--bg-paper);
      --panel: rgba(36,36,35,0.78);
      --bd: var(--border);
      --muted: var(--text-secondary);
      --text: var(--text-primary);
      --good: #16a34a;
      --warn: #d97706;
      --bad: #dc2626;
      --brand: var(--accent);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      --serif: ui-serif, Georgia, "Times New Roman", Times, serif;
      --selection-bg: rgba(217,119,87,0.45);
      --selection-text: #FFFFFF;
    }
    :root[data-theme="light"]{
      --bg-paper:#FAF9F6;
      --bg-surface:#FFFFFF;
      --bg-subtle:#F2F0E8;
      --bg-code:#FBFBF9;
      --text-primary:#1C1C16;
      --text-secondary:#5F5E5A;
      --text-tertiary:#8E8C85;
      --accent:#D97757;
      --accent-faint:rgba(217,119,87,0.10);
      --border:#E6E4DC;
      --border2:rgba(0,0,0,0.06);
      --shadow-sm:0 1px 2px rgba(0,0,0,0.05);
      --shadow-md:0 10px 30px rgba(0,0,0,0.12);

      --bg: var(--bg-paper);
      --panel: rgba(255,255,255,0.88);
      --bd: var(--border);
      --muted: var(--text-secondary);
      --text: var(--text-primary);
      --selection-bg: rgba(217,119,87,0.28);
      --selection-text: #1C1C16;
    }

    * { box-sizing: border-box; transition: background-color .25s ease, border-color .25s ease, color .25s ease; }
    ::selection { background: var(--selection-bg); color: var(--selection-text); -webkit-text-fill-color: var(--selection-text); }
    ::-moz-selection { background: var(--selection-bg); color: var(--selection-text); }
	    body {
	      margin: 0;
	      color: var(--text);
	      font: 13px/1.35 var(--sans);
	      background:
          radial-gradient(900px 680px at 18% 12%, var(--accent-faint), transparent 62%),
          radial-gradient(780px 540px at 74% 22%, rgba(0,0,0,0.06), transparent 62%),
          var(--bg);
	    }
	    /* Scrollbar */
	    * {
	      scrollbar-width: thin;
	      scrollbar-color: rgba(217,119,87,0.38) rgba(0,0,0,0.06);
	    }
	    :root:not([data-theme="light"]) * {
	      scrollbar-color: rgba(217,119,87,0.38) rgba(255,255,255,0.06);
	    }
	    ::-webkit-scrollbar { width: 10px; height: 10px; }
	    ::-webkit-scrollbar-track {
	      background: rgba(0,0,0,0.06);
	      border-radius: 999px;
	    }
	    :root:not([data-theme="light"]) ::-webkit-scrollbar-track { background: rgba(255,255,255,0.06); }
	    ::-webkit-scrollbar-thumb {
	      background: linear-gradient(180deg, rgba(217,119,87,0.30), rgba(217,119,87,0.16));
	      border: 1px solid var(--border2);
	      border-radius: 999px;
	    }
	    ::-webkit-scrollbar-thumb:hover {
	      background: linear-gradient(180deg, rgba(217,119,87,0.45), rgba(217,119,87,0.24));
	    }
    .topbar {
	      position: sticky;
	      top: 0;
	      z-index: 10;
	      padding: 10px 12px;
      background: rgba(25, 25, 24, 0.86);
      border-bottom: 1px solid var(--border2);
      backdrop-filter: blur(10px);
    }
    :root[data-theme="light"] .topbar {
      background: rgba(250, 249, 246, 0.86);
      border-bottom-color: var(--border2);
    }
    .themeIcon {
      position: absolute;
      top: 10px;
      right: 12px;
      width: 34px;
      height: 34px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 10px;
      border: 1px solid var(--border2);
      background: rgba(255,255,255,0.42);
      cursor: pointer;
      box-shadow: var(--shadow-sm);
    }
    :root:not([data-theme="light"]) .themeIcon { background: rgba(36,36,35,0.58); }
    .themeIcon:hover { border-color: rgba(217,119,87,0.35); background: rgba(217,119,87,0.10); }
    .themeIcon svg { width: 18px; height: 18px; }
	    .topbar-row {
	      display: flex;
	      align-items: center;
	      gap: 8px;
	      flex-wrap: wrap;
	    }
	    .topbar-spacer { flex: 1 1 auto; min-width: 12px; }
	    .searchWrap { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
	    .toggleWrap { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
	    .toggle {
	      display: inline-flex;
	      align-items: center;
	      gap: 8px;
	      padding: 4px 8px;
	      border-radius: 999px;
	      border: 1px solid var(--border2);
	      background: rgba(255,255,255,0.40);
	      color: var(--muted);
	      user-select: none;
	    }
    :root:not([data-theme="light"]) .toggle {
      background: rgba(36,36,35,0.55);
    }
	    .toggle input { transform: translateY(1px); }
	    .toggle.sm {
	      padding: 2px 6px;
	      border-radius: 10px;
	      background: rgba(255,255,255,0.28);
	    }
    :root:not([data-theme="light"]) .toggle.sm { background: rgba(36,36,35,0.45); }
	    .toggle.prom {
	      padding: 5px 10px;
	      font-weight: 800;
	      letter-spacing: 0.1px;
	    }
	    .toggle.prom input { accent-color: var(--brand); }
	    /* Edge/Chrome 已支持 :has，用来做“开关高亮” */
	    label.toggle.prom:has(input:checked) {
	      border-color: rgba(217,119,87,0.45);
	      background: rgba(217,119,87,0.14);
	      color: var(--text);
	    }
	    .leftToolRow { display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:space-between; }
	    .leftToolRow .grow { flex: 1 1 260px; min-width: 220px; }
	    .leftToolRow .right { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-left:auto; }
	    .leftToolRow .pager { display:flex; gap:6px; align-items:center; }
	    .btnSm { padding: 6px 8px; border-radius: 10px; }
	    .pagerBtn { padding: 4px 8px; border-radius: 10px; font-weight: 900; }
	    .inputSm { padding: 6px 8px; border-radius: 10px; min-width: 180px; }
	    .inputXs { padding: 6px 8px; border-radius: 10px; min-width: 160px; }
    .title {
      font-weight: 800;
      letter-spacing: 0.2px;
      margin-right: 8px;
      font-family: var(--serif);
    }
	    button, select, input {
	      font: inherit;
	      color: inherit;
	      border-radius: 10px;
	      border: 1px solid var(--border2);
	      background: rgba(255,255,255,0.42);
	      padding: 8px 10px;
	      outline: none;
	    }
    :root:not([data-theme="light"]) button,
    :root:not([data-theme="light"]) select,
    :root:not([data-theme="light"]) input {
      background: rgba(36,36,35,0.58);
    }
	    select option { background: var(--bg-surface); color: var(--text-primary); }
	    :root:not([data-theme="light"]) select option { background: rgba(25,25,24,0.98); color: var(--text-primary); }
	    select:focus, input:focus { border-color: rgba(217,119,87,0.55); box-shadow: 0 0 0 3px rgba(217,119,87,0.12); }
    button {
      cursor: pointer;
      font-weight: 700;
    }
    button.primary {
      background: linear-gradient(90deg, rgba(217,119,87,0.34), rgba(217,119,87,0.18));
      border-color: rgba(217,119,87,0.55);
    }
    button.danger {
      background: rgba(220,38,38,0.10);
      border-color: rgba(220,38,38,0.35);
    }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
	    input { min-width: 0; }
    .muted { color: var(--muted); }
    .bar {
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid var(--border2);
      background: rgba(0,0,0,0.06);
      width: 240px;
    }
    :root:not([data-theme="light"]) .bar { background: rgba(255,255,255,0.06); }
    .bar > div {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent), rgba(217,119,87,0.55));
      transition: width 120ms linear;
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1.1fr 420px;
      gap: 12px;
      padding: 12px;
    }
    .card {
      border: 1px solid var(--border2);
      background: var(--panel);
      border-radius: 14px;
      overflow: hidden;
      min-height: 140px;
      box-shadow: var(--shadow-sm);
    }
    .card-h {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border2);
      background: var(--bg-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .card-h strong { font-weight: 800; }
    .card-b { padding: 10px 12px; }
    .col {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-height: calc(100vh - 66px);
    }
    .list {
      overflow: auto;
      max-height: calc(100vh - 200px);
    }
    .ch-item {
      padding: 7px 9px;
      border: 1px solid var(--border2);
      border-radius: 12px;
      background: rgba(255,255,255,0.56);
      cursor: pointer;
      margin-bottom: 6px;
    }
    :root:not([data-theme="light"]) .ch-item { background: rgba(36,36,35,0.48); }
    .ch-item:hover { background: rgba(217,119,87,0.10); border-color: rgba(217,119,87,0.26); }
    .ch-item[data-sel="1"] {
      border-color: rgba(217,119,87,0.55);
      box-shadow: 0 0 0 3px rgba(217,119,87,0.14) inset;
    }
    .row {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }
    .badges { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 4px; }
    .badge {
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid var(--border2);
      background: rgba(255,255,255,0.60);
      font-size: 11px;
      color: var(--muted);
    }
    :root:not([data-theme="light"]) .badge { background: rgba(36,36,35,0.58); color: rgba(236,235,230,0.82); }
    .badge.good { border-color: rgba(22,163,74,0.35); background: rgba(22,163,74,0.10); }
    .badge.warn { border-color: rgba(217,119,6,0.40); background: rgba(217,119,6,0.10); }
    .badge.bad { border-color: rgba(220,38,38,0.42); background: rgba(220,38,38,0.10); }
    .badge.info { border-color: rgba(59,130,246,0.35); background: rgba(59,130,246,0.10); }
    .tabs { display: flex; gap: 6px; flex-wrap: wrap; }
    .tab {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--border2);
      background: rgba(255,255,255,0.58);
      cursor: pointer;
      user-select: none;
      font-weight: 750;
    }
    :root:not([data-theme="light"]) .tab { background: rgba(36,36,35,0.58); }
    .tab[data-on="1"] { border-color: rgba(217,119,87,0.55); background: rgba(217,119,87,0.12); }
    table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-family: var(--mono);
      font-size: 12px;
    }
    thead th {
      position: sticky;
      top: 0;
      background: var(--bg-subtle);
      border-bottom: 1px solid var(--border2);
      text-align: left;
      padding: 8px 10px;
      color: var(--muted);
      z-index: 1;
    }
    :root:not([data-theme="light"]) thead th { background: rgba(25,25,24,0.88); color: rgba(236,235,230,0.82); }
    tbody td {
      border-bottom: 1px solid var(--border2);
      padding: 7px 10px;
      vertical-align: top;
      word-break: break-word;
      white-space: pre-wrap;
    }
    tbody tr:hover td { background: rgba(217,119,87,0.08); }
    tr.anom td { background: rgba(220,38,38,0.10); }
    .op { width: 42px; color: var(--muted); font-weight: 900; }
    .op.add { color: var(--good); }
    .op.rem { color: var(--bad); }
    .op.chg { color: var(--warn); }
    .kvbox {
      overflow: auto;
      max-height: calc(100vh - 260px);
      border: 1px solid var(--border2);
      background: rgba(255,255,255,0.46);
      border-radius: 12px;
    }
    :root:not([data-theme="light"]) .kvbox { background: rgba(36,36,35,0.42); }
    pre {
      margin: 0;
      padding: 10px 12px;
      overflow: auto;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .rtags { display:inline-flex; gap:4px; flex-wrap:wrap; margin-left:6px; vertical-align:middle; }
    .rtag {
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid var(--border2);
      background: rgba(0,0,0,0.03);
      color: var(--muted);
      user-select: none;
      line-height: 1.5;
    }
    :root:not([data-theme="light"]) .rtag { background: rgba(255,255,255,0.06); color: rgba(236,235,230,0.82); }
    /* 标签语义：让 pinned/date/build/mode/org 更直观，但保持克制 */
    .rtag[data-k="pinned"] { border-color: rgba(217,119,87,0.45); background: rgba(217,119,87,0.18); color: var(--text); }
    .rtag[data-k="date"], .rtag[data-k="build"] { border-color: rgba(217,119,87,0.28); background: rgba(217,119,87,0.12); }
    .rtag[data-k="org"], .rtag[data-k="mode"] { border-color: var(--border2); background: rgba(0,0,0,0.025); }
    :root:not([data-theme="light"]) .rtag[data-k="org"],
    :root:not([data-theme="light"]) .rtag[data-k="mode"] { background: rgba(255,255,255,0.05); }
    /* 兼容旧 cls（来自 reasons） */
    .rtag.good { border-color: rgba(22,163,74,0.28); background: rgba(22,163,74,0.10); color: var(--text); }
    .rtag.warn { border-color: rgba(217,119,87,0.32); background: rgba(217,119,87,0.14); color: var(--text); }
    .split {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    /* Modal (checkpoints) */
    .modalMask {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.35);
      backdrop-filter: blur(6px);
      z-index: 50;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 18px;
    }
    :root[data-theme="light"] .modalMask { background: rgba(0,0,0,0.22); }
    .modal {
      width: min(980px, 96vw);
      max-height: min(78vh, 820px);
      overflow: auto;
      border-radius: 14px;
      border: 1px solid var(--border2);
      background: rgba(25,25,24,0.92);
      box-shadow: var(--shadow-md);
      padding: 12px;
    }
    :root[data-theme="light"] .modal { background: rgba(250,249,246,0.96); }
    .modalH {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 6px 6px 10px 6px;
      border-bottom: 1px solid var(--border2);
      margin-bottom: 10px;
    }
    .modalTitle { font-weight: 950; font-family: var(--serif); font-size: 15px; letter-spacing: 0.2px; }
    .cpList { display: grid; gap: 10px; }
    .cpItem {
      border: 1px solid var(--border2);
      border-radius: 12px;
      background: rgba(36,36,35,0.55);
      padding: 10px;
    }
    :root[data-theme="light"] .cpItem { background: rgba(255,255,255,0.70); }
    .cpMeta { display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between; }
    .cpMetaL { display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
    .cpK { font-family: var(--mono); font-size: 12px; color: var(--muted); }
    .cpItem .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; }
    .cpItem button { padding: 7px 10px; border-radius: 10px; font-weight: 800; }
    .cpItem button.primary { border-color: rgba(217,119,87,0.45); background: rgba(217,119,87,0.14); }
    :root:not([data-theme="light"]) .cpItem button.primary { background: rgba(217,119,87,0.18); }
    .cpItem button:hover { border-color: rgba(217,119,87,0.38); }
    .cpBtns { display:flex; gap:8px; flex-wrap:wrap; }
    .cpBtns button { padding: 6px 8px; }
    @media (max-width: 1100px) {
      .layout { grid-template-columns: 1fr; }
      .col { min-height: auto; }
      .kvbox, .list { max-height: 50vh; }
    }
  </style>
</head>
<body>
	  <div class="topbar">
	    <button id="btnTheme" class="themeIcon" title="切换主题" aria-label="切换主题"></button>
	    <div class="topbar-row">
	      <div class="title">
	        Model Redirect Toolkit
	        <span class="badge" id="dashVer"></span>
	        <span class="badge" id="planInfo"></span>
	      </div>
	      <button id="btnRefresh">刷新快照</button>
	      <button class="primary" id="btnDryRun">运行 dry-run</button>
	      <button class="danger" id="btnApply">写入数据库</button>
	      <label class="toggle prom" title="锁批次：额外生成带日期/批次的 key（例如 deepseek-r1-0528）。用于精确指定批次；开启后 key 会更多。">
	        <input id="pinnedKeys" type="checkbox" checked />
	        锁批次
	      </label>
	      <div class="bar" title="进度"><div id="barFill"></div></div>
	      <div id="status" class="muted"></div>
	    </div>
	    <div class="topbar-row" style="margin-top:8px;">
	      <div class="tabs" id="familyTabs"></div>
	      <div class="topbar-spacer"></div>
	    </div>
	  </div>

  <div class="layout">
    <div class="col">
      <div class="card">
        <div class="card-h">
          <strong>渠道</strong>
          <span class="muted" id="chCount"></span>
        </div>
		        <div class="card-b">
		          <div class="leftToolRow">
		            <input id="chSearch" class="inputSm grow" placeholder="筛选渠道（id/名称/group）" />
		            <div class="right">
		              <label class="toggle sm"><input id="onlyEnabled" type="checkbox" /> enabled</label>
		              <label class="toggle sm"><input id="onlyChanged" type="checkbox" /> 有变更</label>
		              <select id="pageSize" class="btnSm" title="每页条数">
		                <option value="10">10/页</option>
		                <option value="20">20/页</option>
		                <option value="30">30/页</option>
		                <option value="50">50/页</option>
		                <option value="100">100/页</option>
		              </select>
		              <div class="pager">
		                <button class="pagerBtn" id="prevPage" title="上一页">‹</button>
		                <button class="pagerBtn" id="nextPage" title="下一页">›</button>
		              </div>
		            </div>
		          </div>
		          <div class="muted" style="margin-top:6px;">点击左侧渠道，查看 DB/计划/diff。</div>
		          <div class="list" id="chList"></div>
		        </div>
	      </div>
	    </div>

    <div class="col">
      <div class="card">
        <div class="card-h">
          <div class="row" style="gap:10px;">
            <strong id="midTitle">映射预览</strong>
            <span class="muted" id="midMeta"></span>
          </div>
          <div class="tabs">
            <div class="tab" data-mode="diff" data-on="1">Diff</div>
            <div class="tab" data-mode="plan" data-on="0">Plan</div>
            <div class="tab" data-mode="db" data-on="0">DB</div>
          </div>
        </div>
	        <div class="card-b">
	          <div class="row muted" style="justify-content:space-between; gap:10px; flex-wrap:wrap;">
	            <div class="row" style="gap:10px; flex-wrap:wrap; align-items:center;">
	              <div id="kvStats"></div>
	              <input id="kvSearch" class="inputXs" placeholder="筛选 key/value" />
	              <label class="toggle sm"><input id="onlyAnom" type="checkbox" /> 仅异常</label>
	            </div>
	            <button class="btnSm" id="copyView">复制视图 JSON</button>
	          </div>
	          <div class="kvbox">
	            <table>
	              <thead><tr id="tblHead"></tr></thead>
	              <tbody id="tblBody"></tbody>
	            </table>
	          </div>
        </div>
      </div>
    </div>

    <div class="col">
      <div class="card">
        <div class="card-h">
          <strong>操作详情</strong>
          <span class="muted" id="rightMeta"></span>
        </div>
        <div class="card-b">
          <div class="row">
            <button id="applyOne">写入此渠道</button>
            <button id="btnRollbackLast">回滚上次</button>
            <button id="btnCheckpoints">存档点</button>
            <button id="copyDB">复制 DB JSON</button>
            <button id="copyPlan">复制 Plan JSON</button>
            <button id="copyDiff">复制 Diff JSON</button>
          </div>
          <div class="split" style="margin-top:10px;">
            <div class="card" style="min-height:auto;">
              <div class="card-h"><strong>风险</strong><span class="muted" id="riskMeta"></span></div>
              <div class="card-b"><pre id="riskBox" class="muted">（暂无）</pre></div>
            </div>
            <div class="card" style="min-height:auto;">
              <div class="card-h"><strong>摘要</strong><span class="muted" id="sumMeta"></span></div>
              <div class="card-b"><pre id="sumBox" class="muted">（暂无）</pre></div>
            </div>
          </div>
          <div class="card" style="min-height:auto; margin-top:10px;">
            <div class="card-h"><strong>JSON 预览</strong><span class="muted">当前选中渠道</span></div>
            <div class="card-b"><pre id="jsonBox" class="muted">（请选择一个渠道）</pre></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div class="modalMask" id="cpMask">
    <div class="modal" role="dialog" aria-modal="true" aria-label="存档点">
      <div class="modalH">
        <div class="modalTitle">存档点（写库前强制备份）</div>
        <div class="row" style="gap:8px;">
          <button id="cpExport">导出 JSON</button>
          <button id="cpClose">关闭</button>
        </div>
      </div>
      <div class="muted" style="margin:0 6px 10px 6px;">
        提示：回滚会先自动创建“回滚前快照”，避免覆盖当前手工修复后的映射。
      </div>
      <div class="cpList" id="cpList"></div>
    </div>
  </div>

  <script>
    (function(){
      const TOOL_ID = ${JSON.stringify(TOOL_ID)};
      const tool = window.opener && window.opener[TOOL_ID];
      if (!tool) {
        document.body.innerHTML = '<div style="padding:16px;font:14px/1.4 system-ui;color:#fff">无法连接 opener：请从 /console/channel 页面点击“打开仪表盘”。</div>';
        return;
      }

      const el = (id) => document.getElementById(id);
      const qsa = (sel) => Array.from(document.querySelectorAll(sel));

      const st = {
        selectedFamily: 'all',
        viewMode: 'diff',
        onlyEnabled: false,
	        onlyChanged: false,
        onlyAnom: false,
        chSearch: '',
        kvSearch: '',
        page: 0,
        pageSize: 10,
        selectedChannelId: null,
        snapshot: null,
        plan: null,
        progress: { pct: 0, text: '' },
      };

      const SCRIPT_VERSION = tool.SCRIPT_VERSION || 'unknown';

      function setProgress(pct, text) {
        st.progress = { pct: pct||0, text: text||'' };
        el('barFill').style.width = Math.max(0, Math.min(100, st.progress.pct)) + '%';
        el('status').textContent = st.progress.text || '';
      }

      function setButtonsDisabled(disabled) {
        el('btnRefresh').disabled = disabled;
        el('btnDryRun').disabled = disabled || !st.snapshot;
        el('btnApply').disabled = disabled || !st.plan;
        el('applyOne').disabled = disabled || !st.plan || !st.selectedChannelId;
        el('btnRollbackLast').disabled = disabled;
        el('btnCheckpoints').disabled = disabled;
        el('prevPage').disabled = disabled;
        el('nextPage').disabled = disabled;
      }

      function getChannelById(id) {
        const list = (st.snapshot && st.snapshot.channels) ? st.snapshot.channels : [];
        return list.find((x) => String(x.id) === String(id)) || null;
      }

      function getPlanRec(id) {
        return (st.plan && st.plan.perChannel) ? st.plan.perChannel[String(id)] : null;
      }

      function countDiff(diff) {
        const d = diff || {};
        return (Object.keys(d.added||{}).length + Object.keys(d.removed||{}).length + Object.keys(d.changed||{}).length);
      }

      function diffBreakdown(diff) {
        const d = diff || {};
        const added = Object.keys(d.added || {}).length;
        const removed = Object.keys(d.removed || {}).length;
        const changed = Object.keys(d.changed || {}).length;
        return { added, removed, changed, total: added + removed + changed };
      }

      function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',\"'\":'&#39;'}[c]));
      }

      function channelTitle(ch) {
        const g = String(ch.group || '').trim();
        return '#' + ch.id + ' ' + (ch.name || '') + (g ? '  [' + g + ']' : '');
      }

      function channelBadgeHTML(ch) {
        const rec = getPlanRec(ch.id);
        const b = (rec && rec.ok) ? diffBreakdown(rec.diff) : { added: 0, removed: 0, changed: 0, total: 0 };
        const enabled = Number(ch.status) === 1;
        const badges = [];
        badges.push('<span class="badge ' + (enabled?'good':'warn') + '">' + (enabled?'enabled':'disabled') + '</span>');
        badges.push('<span class="badge">models ' + (ch.models ? ch.models.length : 0) + '</span>');
        if (b.total) {
          badges.push('<span class="badge warn">+' + b.added + ' / -' + b.removed + ' / ~' + b.changed + '</span>');
        } else {
          badges.push('<span class="badge">diff 0</span>');
        }
        return badges.join('');
      }

	      function keyBelongsToFamily(key, fam) {
	        if (!fam || fam === 'all') return true;
	        try {
	          const n = tool.normalizeModel ? tool.normalizeModel(key) : null;
	          return !!(n && n.family === fam);
	        } catch {
	          return false;
	        }
	      }

	      function filterChannels() {
	        const list0 = (st.snapshot && st.snapshot.channels) ? st.snapshot.channels : [];
	        // 兜底：按 id 去重，避免出现两个完全相同的渠道项
	        const byId = new Map();
	        for (const ch of list0) {
	          const id = ch && ch.id != null ? String(ch.id) : '';
	          if (!id) continue;
	          if (!byId.has(id)) byId.set(id, ch);
	        }
	        const list = Array.from(byId.values()).sort((a, b) => Number(a.id) - Number(b.id));
	        const q = (st.chSearch || '').trim().toLowerCase();
	        const onlyEnabled = !!st.onlyEnabled;
	        const onlyChanged = !!st.onlyChanged;
	        const fam = st.selectedFamily;
	        const out = [];
        for (const ch of list) {
          if (onlyEnabled && Number(ch.status) !== 1) continue;
          if (q) {
            const hay = (String(ch.id) + ' ' + (ch.name||'') + ' ' + (ch.group||'')).toLowerCase();
            if (!hay.includes(q)) continue;
          }
          const rec = getPlanRec(ch.id);
          if (onlyChanged) {
            if (!rec || !rec.ok || !countDiff(rec.diff)) continue;
	          }
	          if (fam !== 'all') {
	            const mm = (rec && rec.ok && st.viewMode !== 'db') ? (rec.after||{}) : (ch.model_mapping||{});
	            const keys = Object.keys(mm || {});
	            if (!keys.some((k)=> keyBelongsToFamily(k, fam))) continue;
	          }
	          out.push(ch);
	        }
	        return out;
	      }

      function renderFamilyTabs() {
        const box = el('familyTabs');
        const fams = ['all'].concat(tool.DEFAULT_FAMILIES || []);
        box.innerHTML = '';
        for (const fam of fams) {
          const d = document.createElement('div');
          d.className = 'tab';
          d.textContent = fam;
          d.dataset.fam = fam;
          d.dataset.on = (st.selectedFamily === fam) ? '1' : '0';
          d.addEventListener('click', () => {
            st.selectedFamily = fam;
            st.page = 0;
            renderAll();
          });
          box.appendChild(d);
        }
      }

      function renderTabs() {
        qsa('.tab[data-mode]').forEach((t) => {
          const m = t.getAttribute('data-mode');
          t.setAttribute('data-on', (m === st.viewMode) ? '1' : '0');
        });
      }

      function renderChannelList() {
        const items = filterChannels();
        el('chCount').textContent = items.length + ' 渠道';
        const box = el('chList');
        box.innerHTML = '';
        const start = st.page * st.pageSize;
        const pageItems = items.slice(start, start + st.pageSize);
        for (const ch of pageItems) {
          const div = document.createElement('div');
          div.className = 'ch-item';
          div.dataset.sel = (String(st.selectedChannelId) === String(ch.id)) ? '1' : '0';
          div.innerHTML = '<div style="font-weight:800;">' + escapeHtml(channelTitle(ch)) + '</div><div class="badges">' + channelBadgeHTML(ch) + '</div>';
          div.addEventListener('click', () => {
            st.selectedChannelId = ch.id;
            renderAll();
          });
          box.appendChild(div);
        }
        if (!st.selectedChannelId && pageItems.length) {
          st.selectedChannelId = pageItems[0].id;
        }
      }

      function currentMaps() {
        const ch = getChannelById(st.selectedChannelId);
        const rec = getPlanRec(st.selectedChannelId);
        const db = (ch && ch.model_mapping) ? ch.model_mapping : {};
        const plan = (rec && rec.ok && rec.after) ? rec.after : {};
        const diff = (rec && rec.ok && rec.diff) ? rec.diff : { added:{}, removed:{}, changed:{} };
        return { ch, rec, db, plan, diff };
      }

      async function getLastApply() {
        try {
          const s = await tool.getState?.();
          return s && s.lastApply ? s.lastApply : null;
        } catch {
          return null;
        }
      }

      function flattenDiff(diff) {
        const out = [];
        for (const [k, v] of Object.entries(diff.added || {})) out.push({ op: '+', key: k, from: null, to: v });
        for (const [k, v] of Object.entries(diff.removed || {})) out.push({ op: '-', key: k, from: v, to: null });
        for (const [k, v] of Object.entries(diff.changed || {})) out.push({ op: '~', key: k, from: v.before, to: v.after });
        out.sort((a,b)=> a.key.localeCompare(b.key));
        return out;
      }

	      function renderTable() {
	        const { ch, rec, db, plan, diff } = currentMaps();
	        el('midTitle').textContent = ch ? ('#' + ch.id + ' ' + (ch.name||'')) : '映射预览';
	        el('midMeta').textContent = ch ? ('models ' + (ch.models?ch.models.length:0) + (ch.group?(' | ' + ch.group):'')) : '';
        // 右侧 meta：把 “翻译 | enabled” 这种调试串换成更直观的标签
        if (ch) {
          const enabled = Number(ch.status) === 1;
          const gs = String(ch.group || '').split(',').map((s) => s.trim()).filter(Boolean);
          const chips = [];
          for (const g of gs.slice(0, 12)) chips.push('<span class="badge">' + escapeHtml(g) + '</span>');
          chips.push('<span class="badge ' + (enabled ? 'good' : 'warn') + '">' + (enabled ? 'enabled' : 'disabled') + '</span>');
          el('rightMeta').innerHTML = chips.join(' ');
        } else {
          el('rightMeta').textContent = '';
        }

        if (rec && rec.ok) {
          const b = diffBreakdown(rec.diff);
          el('sumBox').textContent = JSON.stringify({ diff: { added: b.added, removed: b.removed, changed: b.changed } }, null, 2);
          el('sumMeta').textContent = '';
        } else if (rec && !rec.ok) {
          el('sumBox').textContent = String(rec.error || 'unknown_error');
          el('sumMeta').textContent = 'plan error';
        } else {
          el('sumBox').textContent = '（暂无 plan）';
          el('sumMeta').textContent = '';
        }

        const modelsSet = new Set((ch && ch.models) ? ch.models.map(String) : []);
        const anoms = [];
        const checkMap = (m) => {
          for (const [k,v] of Object.entries(m||{})) {
            if (!modelsSet.has(String(v))) anoms.push({ key: k, value: v, reason: 'value_not_in_models' });
          }
        };
        if (st.viewMode === 'db') checkMap(db);
        else if (st.viewMode === 'plan') checkMap(plan);
        else {
          const flat = flattenDiff(diff);
          for (const e of flat) {
            const v = (e.to!=null) ? e.to : (e.from!=null ? e.from : null);
            if (v!=null && !modelsSet.has(String(v))) anoms.push({ key: e.key, value: v, reason: 'value_not_in_models' });
          }
        }
        const warns = (rec && rec.ok && Array.isArray(rec.warnings)) ? rec.warnings : [];
        const risks = [];
        if (anoms.length) risks.push({ type: 'value_not_in_models', count: anoms.length, sample: anoms.slice(0, 12) });
        if (warns.length) risks.push({ type: 'warnings', count: warns.length, sample: warns.slice(0, 12) });
        el('riskBox').textContent = risks.length ? JSON.stringify(risks, null, 2) : '（暂无）';
        el('riskMeta').textContent = risks.length ? ('风险 ' + (anoms.length + warns.length)) : '';

        el('jsonBox').textContent = ch ? JSON.stringify({ db: db, plan: plan, diff: diff }, null, 2) : '（请选择一个渠道）';

        // plan 缓存提示：脚本版本/快照不一致时，建议重跑 dry-run
        const pv = st.plan && st.plan.script_version ? String(st.plan.script_version) : 'unknown';
        const snapTs = st.snapshot && st.snapshot.ts ? Number(st.snapshot.ts) : null;
        const planSnapTs = st.plan && st.plan.snapshot_ts ? Number(st.plan.snapshot_ts) : null;
        const stale = (pv !== SCRIPT_VERSION) || (snapTs && planSnapTs && snapTs !== planSnapTs);
        if (!st.plan) {
          el('planInfo').textContent = '';
        } else {
          // badge 里尽量短：展示 plan 版本与“建议重跑”提示
          el('planInfo').textContent = 'plan ' + pv + (stale ? ' · 建议重跑' : '');
          // 让“建议重跑”更醒目一点（不刷屏）
          el('planInfo').classList.toggle('warn', !!stale);
        }

        const head = el('tblHead');
        const body = el('tblBody');
        head.innerHTML = '';
        body.innerHTML = '';

	        const kvQ = (st.kvSearch || '').trim().toLowerCase();
	        const onlyAnom = !!st.onlyAnom;
	        const fam = st.selectedFamily;

	        if (st.viewMode === 'diff') {
	          head.innerHTML = '<th class="op">op</th><th style="width:34%;">key</th><th style="width:33%;">from</th><th>to</th>';
	          const rows = flattenDiff(diff);
          const reasonMap = (rec && rec.ok && rec.reasons) ? rec.reasons : {};
          const reasonBadgesHTML = (key) => {
            const r = reasonMap && reasonMap[String(key)];
            if (!r || !Array.isArray(r.reasons) || !r.reasons.length) return '';
            const uniq = Array.from(new Set(r.reasons.map(String)));
            const tags = [];
            for (const t of uniq.slice(0, 6)) {
              const cls = (t === 'keep_old' || t === 'old') ? 'good' : (t === 'pinned' || t === 'build' || t === 'date') ? 'warn' : '';
              const k = String(t).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);
              const dk = k ? (' data-k="' + escapeHtml(k) + '"') : '';
              tags.push('<span class="rtag ' + cls + '"' + dk + '>' + escapeHtml(t) + '</span>');
            }
            return tags.length ? ('<span class="rtags">' + tags.join('') + '</span>') : '';
          };
	          let shown = 0;
	          for (const e of rows) {
	            if (fam !== 'all' && !keyBelongsToFamily(e.key, fam)) continue;
	            if (kvQ) {
	              const hay = (String(e.key) + ' ' + String(e.from ?? '') + ' ' + String(e.to ?? '')).toLowerCase();
	              if (!hay.includes(kvQ)) continue;
            }
            const checkV = (e.op === '-') ? e.from : e.to;
            const an = (checkV != null) ? (!modelsSet.has(String(checkV))) : false;
            if (onlyAnom && !an) continue;
            const tr = document.createElement('tr');
            if (an) tr.className = 'anom';
            const cls = (e.op === '+') ? 'add' : (e.op === '-') ? 'rem' : 'chg';
            tr.innerHTML =
              '<td class="op ' + cls + '">' + escapeHtml(e.op) + '</td>' +
              '<td>' + escapeHtml(e.key) + '</td>' +
              '<td>' + escapeHtml(e.from == null ? '' : String(e.from)) + '</td>' +
              '<td>' + escapeHtml(e.to == null ? '' : String(e.to)) + ((e.op === '+' || e.op === '~') ? reasonBadgesHTML(e.key) : '') + '</td>';
            body.appendChild(tr);
            shown++;
            if (shown >= 2000) break;
          }
          el('kvStats').textContent = 'diff 条目: ' + shown + (shown>=2000?' (已截断)':'');
	        } else {
	          head.innerHTML = '<th style="width:50%;">key</th><th>value</th>';
	          const m = (st.viewMode === 'db') ? db : plan;
	          const keys = Object.keys(m||{}).sort();
	          let shown = 0;
	          for (const k of keys) {
	            if (fam !== 'all' && !keyBelongsToFamily(k, fam)) continue;
	            const v = String(m[k]);
	            if (kvQ) {
	              const hay = (String(k) + ' ' + v).toLowerCase();
              if (!hay.includes(kvQ)) continue;
            }
            const an = !modelsSet.has(String(v));
            if (onlyAnom && !an) continue;
            const tr = document.createElement('tr');
            if (an) tr.className = 'anom';
            tr.innerHTML = '<td>' + escapeHtml(k) + '</td><td>' + escapeHtml(v) + '</td>';
            body.appendChild(tr);
            shown++;
            if (shown >= 2000) break;
          }
          el('kvStats').textContent = (st.viewMode.toUpperCase()) + ' 条目: ' + shown + (shown>=2000?' (已截断)':'');
        }
      }

      function renderAll() {
        renderFamilyTabs();
        renderTabs();
        renderChannelList();
        renderTable();
        el('dashVer').textContent = 'v' + SCRIPT_VERSION;
        setButtonsDisabled(false);
      }

      async function refreshFromTool() {
        st.snapshot = await tool.getSnapshot();
        st.plan = await tool.getPlan();
      }

      function copyText(txt) {
        navigator.clipboard.writeText(String(txt)).catch(() => {
          const ta = document.createElement('textarea');
          ta.value = String(txt);
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        });
      }

      el('chSearch').addEventListener('input', (e) => { st.chSearch = e.target.value || ''; st.page = 0; renderAll(); });
      el('kvSearch').addEventListener('input', (e) => { st.kvSearch = e.target.value || ''; renderAll(); });
      el('pinnedKeys').addEventListener('change', async (e) => {
        try {
          setButtonsDisabled(true);
          setProgress(0, '更新设置...');
          await tool.setPinnedKeys(!!e.target.checked);
          await refreshFromTool();
          setProgress(0, '');
          renderAll();
        } catch (err) {
          setProgress(0, '更新设置失败: ' + (err && err.message ? err.message : err));
          setButtonsDisabled(false);
        }
      });
      el('onlyEnabled').addEventListener('change', (e) => { st.onlyEnabled = !!e.target.checked; st.page = 0; renderAll(); });
      el('onlyChanged').addEventListener('change', (e) => { st.onlyChanged = !!e.target.checked; st.page = 0; renderAll(); });
      el('onlyAnom').addEventListener('change', (e) => { st.onlyAnom = !!e.target.checked; renderAll(); });
      el('pageSize').addEventListener('change', (e) => { st.pageSize = Number(e.target.value)||10; st.page = 0; renderAll(); });
      el('prevPage').addEventListener('click', () => { st.page = Math.max(0, st.page-1); renderAll(); });
      el('nextPage').addEventListener('click', () => { st.page = st.page+1; renderAll(); });

      qsa('.tab[data-mode]').forEach((t) => {
        t.addEventListener('click', () => {
          st.viewMode = t.getAttribute('data-mode');
          renderAll();
        });
      });

      el('btnRefresh').addEventListener('click', async () => {
        try {
          setButtonsDisabled(true);
          setProgress(1, '刷新快照...');
          await tool.refreshSnapshot(true);
          await refreshFromTool();
          setProgress(100, '快照已刷新');
          st.page = 0;
          st.selectedChannelId = null;
          renderAll();
        } catch (e) {
          setProgress(0, '刷新失败: ' + (e && e.message ? e.message : e));
          setButtonsDisabled(false);
        }
      });

	      el('btnDryRun').addEventListener('click', async () => {
	        try {
	          setButtonsDisabled(true);
	          setProgress(1, '运行 dry-run...');
	          const fam = st.selectedFamily;
	          const opts = (fam && fam !== 'all') ? { families: [fam] } : null;
	          await tool.runDryRun((p)=> setProgress(p.pct, p.text), opts || undefined);
	          await refreshFromTool();
	          setProgress(100, 'dry-run 完成');
	          st.page = 0;
          st.selectedChannelId = null;
          renderAll();
        } catch (e) {
          setProgress(0, 'dry-run 失败: ' + (e && e.message ? e.message : e));
          setButtonsDisabled(false);
        }
      });

      el('btnApply').addEventListener('click', async () => {
        try {
          setButtonsDisabled(true);
          const ok = confirm('即将写入数据库：请确认你已在当前详情页审阅 dry-run 结果无误。继续写入？');
          if (!ok) { setButtonsDisabled(false); setProgress(0, ''); return; }
          setProgress(1, '写入数据库...');
          await tool.applyPlan((p)=> setProgress(p.pct, p.text), { skipConfirm: true });
          await tool.refreshSnapshot(true);
          await refreshFromTool();
          setProgress(100, '写入完成');
          const la = await getLastApply();
          if (la) {
            const msg = { applied: la };
            el('riskBox').textContent = JSON.stringify(msg, null, 2);
            el('riskMeta').textContent = '写入摘要';
          }
          st.page = 0;
          st.selectedChannelId = null;
          renderAll();
        } catch (e) {
          setProgress(0, '写入失败: ' + (e && e.message ? e.message : e));
          setButtonsDisabled(false);
        }
      });

      el('applyOne').addEventListener('click', async () => {
        const cid = st.selectedChannelId;
        if (!cid) return;
        try {
          setButtonsDisabled(true);
          const ok = confirm('即将写入当前渠道：请确认你已在当前详情页审阅无误。继续写入？');
          if (!ok) { setButtonsDisabled(false); setProgress(0, ''); return; }
          setProgress(1, '写入 channel ' + cid + '...');
          await tool.applyOne(String(cid), (p)=> setProgress(p.pct, p.text), { skipConfirm: true });
          await tool.refreshSnapshot(true);
          await refreshFromTool();
          setProgress(100, '写入完成');
          renderAll();
        } catch (e) {
          setProgress(0, '写入失败: ' + (e && e.message ? e.message : e));
          setButtonsDisabled(false);
        }
      });

      el('copyView').addEventListener('click', () => {
        const { db, plan, diff } = currentMaps();
        const out = st.viewMode === 'db' ? db : st.viewMode === 'plan' ? plan : diff;
        copyText(JSON.stringify(out || {}, null, 2));
      });
      el('copyDB').addEventListener('click', () => { const { db } = currentMaps(); copyText(JSON.stringify(db||{}, null, 2)); });
      el('copyPlan').addEventListener('click', () => { const { plan } = currentMaps(); copyText(JSON.stringify(plan||{}, null, 2)); });
      el('copyDiff').addEventListener('click', () => { const { diff } = currentMaps(); copyText(JSON.stringify(diff||{}, null, 2)); });

      function fmtTs(ts) {
        try { return new Date(Number(ts||0)).toLocaleString(); } catch { return String(ts||''); }
      }

      async function renderCheckpoints() {
        const mask = el('cpMask');
        const box = el('cpList');
        box.innerHTML = '<div class="muted" style="padding:6px;">加载中...</div>';
        const cps = await tool.getCheckpoints();
        const list = Array.isArray(cps) ? cps.slice().reverse() : [];
        if (!list.length) {
          box.innerHTML = '<div class="muted" style="padding:6px;">暂无存档点：只有在写入数据库前才会自动创建。</div>';
          return;
        }
        const parts = [];
        for (const cp of list) {
          const id = String(cp && cp.id ? cp.id : '');
          const kind = String(cp && cp.kind ? cp.kind : '');
          const stt = cp && cp.stats ? cp.stats : {};
          const nCh = Number(stt.channels || (cp.channels ? cp.channels.length : 0) || 0);
          const nDiff = Number(stt.diff_total || 0);
          parts.push(
            '<div class="cpItem" data-id="' + escapeHtml(id) + '">' +
              '<div class="cpMeta">' +
                '<div class="cpMetaL">' +
                  '<div style="font-weight:900;">' + escapeHtml(kind || 'checkpoint') + '</div>' +
                  '<div class="cpK">' + escapeHtml(fmtTs(cp.ts)) + '</div>' +
                  '<div class="badge warn">channels ' + nCh + '</div>' +
                  '<div class="badge">diff ' + nDiff + '</div>' +
                  '<div class="cpK">id ' + escapeHtml(id) + '</div>' +
                '</div>' +
                '<div class="cpBtns">' +
                  '<button class="primary" data-act="rb">回滚</button>' +
                  '<button data-act="del">删除</button>' +
                '</div>' +
              '</div>' +
            '</div>'
          );
        }
        box.innerHTML = parts.join('');
        box.querySelectorAll('button[data-act]').forEach((b) => {
          b.addEventListener('click', async (ev) => {
            const btn = ev.currentTarget;
            const act = btn.getAttribute('data-act');
            const item = btn.closest('.cpItem');
            const id = item ? String(item.getAttribute('data-id') || '') : '';
            if (!id) return;
            if (act === 'del') {
              const ok = confirm('删除该存档点？（不可恢复）');
              if (!ok) return;
              await tool.deleteCheckpoint(id);
              await renderCheckpoints();
              return;
            }
            if (act === 'rb') {
              const ok = confirm('即将回滚到该存档点。回滚会覆盖这些渠道当前的 model_mapping，且会先自动备份“回滚前快照”。继续？');
              if (!ok) return;
              try {
                setButtonsDisabled(true);
                setProgress(1, '回滚中...');
                await tool.rollbackById(id, (p)=> setProgress(p.pct, p.text));
                await tool.refreshSnapshot(true);
                await refreshFromTool();
                setProgress(100, '回滚完成');
                await renderCheckpoints();
                renderAll();
              } catch (e) {
                setProgress(0, '回滚失败: ' + (e && e.message ? e.message : e));
              } finally {
                setButtonsDisabled(false);
              }
            }
          });
        });
        mask.style.display = 'flex';
      }

      el('btnCheckpoints').addEventListener('click', async () => {
        await renderCheckpoints();
      });
      el('cpClose').addEventListener('click', () => { el('cpMask').style.display = 'none'; });
      el('cpMask').addEventListener('click', (e) => { if (e.target && e.target.id === 'cpMask') el('cpMask').style.display = 'none'; });
      el('cpExport').addEventListener('click', async () => {
        const cps = await tool.getCheckpoints();
        copyText(JSON.stringify(cps || [], null, 2));
        alert('已复制到剪贴板（JSON）');
      });

      el('btnRollbackLast').addEventListener('click', async () => {
        const ok = confirm('即将回滚“上一次写入”对应的存档点（整批）。回滚会先自动备份“回滚前快照”。继续？');
        if (!ok) return;
        try {
          setButtonsDisabled(true);
          setProgress(1, '回滚中...');
          await tool.rollbackLast((p)=> setProgress(p.pct, p.text));
          await tool.refreshSnapshot(true);
          await refreshFromTool();
          setProgress(100, '回滚完成');
          renderAll();
        } catch (e) {
          setProgress(0, '回滚失败: ' + (e && e.message ? e.message : e));
        } finally {
          setButtonsDisabled(false);
        }
      });

      (async function init(){
        setButtonsDisabled(true);
        setProgress(1, '加载缓存...');
        const settings = await tool.getSettings();
        if (settings && typeof settings.pinnedKeys === 'boolean') {
          el('pinnedKeys').checked = settings.pinnedKeys;
        }
        // 主题：默认 dark（暖暗色）；可切换 light（纸张风格）
        let theme = (settings && (settings.theme === 'light' || settings.theme === 'dark')) ? settings.theme : 'dark';
        const iconMoon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
        const iconSun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
        const syncThemeIcon = () => {
          // 约定：当前为 dark 时显示“太阳”（提示可切到亮色）；当前为 light 时显示“月亮”
          el('btnTheme').innerHTML = (theme === 'dark') ? iconSun : iconMoon;
        };
        const applyTheme = (t) => {
          theme = (t === 'light') ? 'light' : 'dark';
          document.documentElement.setAttribute('data-theme', theme);
          syncThemeIcon();
        };
        applyTheme(theme);
        // pageSize 默认 10（渠道很多时更易定位），用户可自行切换。
        try {
          el('pageSize').value = String(st.pageSize || 10);
        } catch {}
        el('btnTheme').addEventListener('click', async () => {
          const next = (theme === 'dark') ? 'light' : 'dark';
          applyTheme(next);
          try { await tool.setTheme(next); } catch {}
        });
        await refreshFromTool();
        setProgress(0, st.snapshot ? '' : '未发现快照：请点击“刷新快照”');
        renderAll();
      })();
    })();
  </script>
</body>
</html>`;
    w.document.open();
    w.document.write(html);
    w.document.close();
  }

  function injectStyles() {
    const css = `
      /* Claude-ish token set, scoped to toolkit UI only. */
      #${TOOL_ID}-panel, #${TOOL_ID}-btn {
        --paper: #FAF9F6;
        --surface: #FFFFFF;
        --subtle: #F2F0E8;
        --code: #FBFBF9;
        --text: #1C1C16;
        --muted: rgba(28,28,22,0.68);
        --border: rgba(0,0,0,0.10);
        --border2: rgba(0,0,0,0.06);
        --accent: #D97757;
        --accent-faint: rgba(217,119,87,0.10);
        --shadow: 0 20px 55px rgba(0,0,0,0.18);
        --r: 14px;
        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      }
      #${TOOL_ID}-panel[data-theme="dark"], #${TOOL_ID}-btn[data-theme="dark"] {
        --paper: #191918;
        --surface: #242423;
        --subtle: #2C2C2B;
        --code: #222221;
        --text: #ECEBE6;
        --muted: rgba(236,235,230,0.70);
        --border: rgba(255,255,255,0.14);
        --border2: rgba(255,255,255,0.08);
        --accent-faint: rgba(217,119,87,0.16);
        --shadow: 0 20px 55px rgba(0,0,0,0.36);
      }
      #${TOOL_ID}-btn {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 999999;
        background: rgba(250,249,246,0.92);
        color: var(--text);
        border: 1px solid var(--border2);
        border-radius: var(--r);
        padding: 10px 12px;
        cursor: pointer;
        box-shadow: 0 12px 28px rgba(0,0,0,0.16);
        font: 650 13px/1.1 var(--sans);
        backdrop-filter: blur(10px);
      }
      #${TOOL_ID}-btn[data-theme="dark"]{
        background: rgba(36,36,35,0.82);
        border-color: var(--border);
        box-shadow: 0 12px 28px rgba(0,0,0,0.22);
      }
      #${TOOL_ID}-panel {
        position: fixed;
        right: 16px;
        bottom: 64px;
        z-index: 999999;
        width: 420px;
        max-height: 70vh;
        overflow: auto;
        background: rgba(250,249,246,0.94);
        backdrop-filter: blur(10px);
        border: 1px solid var(--border2);
        border-radius: var(--r);
        box-shadow: var(--shadow);
        padding: 12px;
        display: none;
        color: var(--text);
        font: 13px/1.35 var(--sans);
      }
      #${TOOL_ID}-panel[data-theme="dark"]{
        background: rgba(25,25,24,0.92);
        border-color: var(--border2);
      }
      #${TOOL_ID}-panel h3 {
        margin: 0 0 6px 0;
        font-size: 14px;
      }
      #${TOOL_ID}-panel .muted { color: var(--muted); }
      #${TOOL_ID}-panelHead {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 6px;
      }
      #${TOOL_ID}-themeBtn {
        width: 34px;
        height: 34px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 12px;
        border: 1px solid var(--border2);
        background: rgba(255,255,255,0.60);
        cursor: pointer;
      }
      #${TOOL_ID}-panel[data-theme="dark"] #${TOOL_ID}-themeBtn { background: rgba(36,36,35,0.65); }
      #${TOOL_ID}-themeBtn:hover { border-color: rgba(217,119,87,0.35); background: rgba(217,119,87,0.10); }
      #${TOOL_ID}-themeBtn svg { width: 18px; height: 18px; }
      #${TOOL_ID}-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin: 8px 0;
      }
      #${TOOL_ID}-row button {
        background: rgba(255,255,255,0.60);
        color: var(--text);
        border: 1px solid var(--border2);
        border-radius: 12px;
        padding: 8px 10px;
        cursor: pointer;
        font-weight: 650;
      }
      #${TOOL_ID}-panel[data-theme="dark"] #${TOOL_ID}-row button{
        background: rgba(36,36,35,0.65);
        border-color: var(--border2);
      }
      #${TOOL_ID}-row button:hover{
        border-color: rgba(217,119,87,0.35);
        background: rgba(217,119,87,0.10);
      }
      #${TOOL_ID}-row button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
      #${TOOL_ID}-opts{
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        align-items:center;
        margin: 8px 0 0 0;
      }
      #${TOOL_ID}-opts .opt{
        display:inline-flex;
        gap:8px;
        align-items:center;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--border2);
        background: rgba(255,255,255,0.60);
        font-weight: 700;
        user-select:none;
      }
      #${TOOL_ID}-panel[data-theme="dark"] #${TOOL_ID}-opts .opt{
        background: rgba(36,36,35,0.65);
      }
      #${TOOL_ID}-opts .opt input{ accent-color: var(--accent); transform: translateY(1px); }
      #${TOOL_ID}-opts .opt:hover{ border-color: rgba(217,119,87,0.35); background: rgba(217,119,87,0.10); }
      #${TOOL_ID}-opts label.opt:has(input:checked){
        border-color: rgba(217,119,87,0.45);
        background: rgba(217,119,87,0.12);
      }
      #${TOOL_ID}-muted { color: var(--muted); }
      #${TOOL_ID}-bar {
        height: 10px;
        background: rgba(0,0,0,0.06);
        border-radius: 999px;
        overflow: hidden;
        border: 1px solid var(--border2);
      }
      #${TOOL_ID}-panel[data-theme="dark"] #${TOOL_ID}-bar{ background: rgba(255,255,255,0.06); }
      #${TOOL_ID}-bar > div {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, var(--accent), rgba(217,119,87,0.60));
        transition: width 120ms linear;
      }
      #${TOOL_ID}-families {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 8px 0;
      }
      .${TOOL_ID}-chip {
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid var(--border2);
        background: rgba(255,255,255,0.70);
        cursor: pointer;
        user-select: none;
      }
      #${TOOL_ID}-panel[data-theme="dark"] .${TOOL_ID}-chip{ background: rgba(36,36,35,0.70); }
      .${TOOL_ID}-chip[data-on="1"] {
        background: rgba(217,119,87,0.12);
        border-color: rgba(217,119,87,0.45);
      }
      #${TOOL_ID}-pre {
        white-space: pre-wrap;
        word-break: break-word;
        background: rgba(0,0,0,0.03);
        border: 1px solid var(--border2);
        border-radius: 12px;
        padding: 10px;
        margin-top: 8px;
        font-family: var(--mono);
        font-size: 12px;
        max-height: 220px;
        overflow: auto;
      }
      #${TOOL_ID}-panel[data-theme="dark"] #${TOOL_ID}-pre{ background: rgba(255,255,255,0.04); }
    `;
    const el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function injectUI() {
    if (document.getElementById(TOOL_ID + '-btn')) return;
    injectStyles();

    const btn = document.createElement('button');
    btn.id = TOOL_ID + '-btn';
    btn.textContent = '模型重定向';
    btn.addEventListener('click', () => {
      state.open = !state.open;
      render();
    });
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = TOOL_ID + '-panel';
    panel.innerHTML = `
      <div id="${TOOL_ID}-panelHead">
        <h3 style="margin:0;">Model Redirect Toolkit <span class="muted">v${SCRIPT_VERSION}</span></h3>
        <button id="${TOOL_ID}-themeBtn" title="切换主题" aria-label="切换主题"></button>
      </div>
      <div id="${TOOL_ID}-muted">只在浏览器本地计算：dry-run 预览后再写回 DB。</div>
      <div id="${TOOL_ID}-row">
        <button id="${TOOL_ID}-load">刷新全量渠道</button>
        <button id="${TOOL_ID}-run">运行 dry-run</button>
        <button id="${TOOL_ID}-dash">打开仪表盘</button>
      </div>
      <div id="${TOOL_ID}-opts">
        <label class="opt" title="锁批次：额外生成带日期/批次的 key（例如 deepseek-r1-0528）。用于精确指定批次；开启后 key 会更多。">
          <input id="${TOOL_ID}-pinned" type="checkbox" />
          锁批次
        </label>
      </div>
      <div id="${TOOL_ID}-bar"><div></div></div>
      <div id="${TOOL_ID}-status" style="margin-top:6px;"></div>
      <div style="margin-top:10px; font-weight:700;">Families</div>
      <div id="${TOOL_ID}-families"></div>
      <div style="margin-top:10px; font-weight:700;">摘要</div>
      <div id="${TOOL_ID}-summary"></div>
      <div style="margin-top:10px; font-weight:700;">计划概览</div>
      <div id="${TOOL_ID}-pre"></div>
    `;
    document.body.appendChild(panel);

    document.getElementById(TOOL_ID + '-load').addEventListener('click', async () => {
      try {
        await loadSnapshot(true);
      } catch (e) {
        alert('加载失败: ' + e.message);
      }
    });
    document.getElementById(TOOL_ID + '-run').addEventListener('click', async () => {
      try {
        await runDryRun();
      } catch (e) {
        alert('dry-run 失败: ' + e.message);
      }
    });
    document.getElementById(TOOL_ID + '-dash').addEventListener('click', () => {
      openDashboard();
    });
    document.getElementById(TOOL_ID + '-themeBtn').addEventListener('click', async () => {
      state.theme = (state.theme === 'light') ? 'dark' : 'light';
      await idbSet('settings', { pinnedKeys: !!state.pinnedKeys, theme: state.theme });
      applyThemeToLocalUI();
      render();
    });

    const pinned = document.getElementById(TOOL_ID + '-pinned');
    pinned.checked = !!state.pinnedKeys;
    pinned.addEventListener('change', async (e) => {
      state.pinnedKeys = !!e.target.checked;
      await idbSet('settings', { pinnedKeys: !!state.pinnedKeys, theme: state.theme });
      render();
    });
  }

  function applyThemeToLocalUI() {
    const theme = (state.theme === 'light') ? 'light' : 'dark';
    const panel = document.getElementById(TOOL_ID + '-panel');
    const btn = document.getElementById(TOOL_ID + '-btn');
    if (panel) panel.setAttribute('data-theme', theme);
    if (btn) btn.setAttribute('data-theme', theme);

    // 同步图标：当前为 dark 时显示“太阳”（提示可切到亮色）；当前为 light 时显示“月亮”
    const iconMoon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
    const iconSun = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
    const tbtn = document.getElementById(TOOL_ID + '-themeBtn');
    if (tbtn) tbtn.innerHTML = (theme === 'dark') ? iconSun : iconMoon;
  }

  function renderFamilies() {
    const box = document.getElementById(TOOL_ID + '-families');
    if (!box) return;
    box.innerHTML = '';
    for (const fam of DEFAULT_FAMILIES) {
      const chip = document.createElement('div');
      chip.className = TOOL_ID + '-chip';
      chip.dataset.on = state.families.has(fam) ? '1' : '0';
      chip.textContent = fam;
      chip.addEventListener('click', () => {
        if (state.families.has(fam)) state.families.delete(fam);
        else state.families.add(fam);
        render();
      });
      box.appendChild(chip);
    }
  }

  function renderSummary() {
    const el = document.getElementById(TOOL_ID + '-summary');
    if (!el) return;
    const snap = state.snapshot;
    const plan = state.plan;
    const parts = [];
    parts.push(`脚本版本: ${SCRIPT_VERSION}`);
    if (snap && snap.channels) {
      parts.push(`渠道数: ${snap.channels.length} | 快照时间: ${new Date(snap.ts).toLocaleString()}`);
    } else {
      parts.push('尚未加载全量渠道快照');
    }
    if (plan && plan.summary) {
      const fams = Array.isArray(plan.families) ? plan.families.join(', ') : Array.from(state.families).join(', ');
      const pv = plan.script_version ? String(plan.script_version) : 'unknown';
      const snapTs = plan.snapshot_ts ? Number(plan.snapshot_ts) : null;
      const stale = (pv !== SCRIPT_VERSION) || (snap && snap.ts && snapTs && snap.ts !== snapTs);
      parts.push(`dry-run families: ${fams} | 计划时间: ${new Date(plan.ts).toLocaleString()} | plan版本: ${pv}` + (stale ? ' | 缓存可能已过期：建议刷新快照并重跑 dry-run' : ''));
    }
    el.textContent = parts.join('\n');
  }

  function renderPlanPreview() {
    const el = document.getElementById(TOOL_ID + '-pre');
    if (!el) return;
    const plan = state.plan;
    if (!plan) {
      el.textContent = '（暂无 dry-run 结果）';
      return;
    }
    // Show top 10 changed channels.
    const changed = [];
    for (const ch of (state.snapshot?.channels || [])) {
      const rec = plan.perChannel && plan.perChannel[String(ch.id)];
      if (!rec || !rec.ok) continue;
      const d = rec.diff || {};
      const n = Object.keys(d.added || {}).length + Object.keys(d.removed || {}).length + Object.keys(d.changed || {}).length;
      if (n) changed.push({ id: ch.id, name: ch.name, n });
    }
    changed.sort((a, b) => b.n - a.n);
    const top = changed.slice(0, 10);
    const out = {
      elapsed_s: plan.elapsed_s,
      changed_channels: changed.length,
      top_changed: top,
      summary: plan.summary,
    };
    el.textContent = JSON.stringify(out, null, 2);
  }

  function renderProgress() {
    const bar = document.querySelector(`#${TOOL_ID}-bar > div`);
    const st = document.getElementById(TOOL_ID + '-status');
    if (bar) bar.style.width = String(Math.max(0, Math.min(100, state.progress.pct || 0))) + '%';
    if (st) st.textContent = state.progress.text || '';
  }

  function renderButtons() {
    const loadBtn = document.getElementById(TOOL_ID + '-load');
    const runBtn = document.getElementById(TOOL_ID + '-run');
    if (loadBtn) loadBtn.disabled = state.loading || state.running || state.applying;
    if (runBtn) runBtn.disabled = state.loading || state.running || state.applying || !state.snapshot;
  }

  function render() {
    const panel = document.getElementById(TOOL_ID + '-panel');
    if (!panel) return;
    panel.style.display = state.open ? 'block' : 'none';
    renderButtons();
    renderFamilies();
    renderProgress();
    renderSummary();
    renderPlanPreview();
  }

  async function bootstrap() {
    injectUI();
    applyThemeToLocalUI();
    // Expose minimal API for the dashboard window (about:blank uses opener reference).
		    window[TOOL_ID] = {
		      SCRIPT_VERSION,
		      DEFAULT_FAMILIES,
		      DEFAULT_STANDARDS,
		      // 供仪表盘/外部 UI 做“严格按家族”过滤，不再使用 includes 这类弱匹配。
		      normalizeModel,
		      detectFamily,
		      getState: async () => ({ lastApply: state.lastApply }),
		      getSnapshot: async () => state.snapshot,
		      getPlan: async () => state.plan,
		      refreshSnapshot: async (force) => loadSnapshot(!!force),
      getSettings: async () => ({ pinnedKeys: !!state.pinnedKeys, theme: state.theme }),
      setPinnedKeys: async (v) => {
        state.pinnedKeys = !!v;
        await idbSet('settings', { pinnedKeys: !!state.pinnedKeys, theme: state.theme });
        render();
      },
      setTheme: async (t) => {
        state.theme = (t === 'light') ? 'light' : 'dark';
        await idbSet('settings', { pinnedKeys: !!state.pinnedKeys, theme: state.theme });
        applyThemeToLocalUI();
        render();
      },
	      runDryRun: async (onProgress, opts) => {
	        if (typeof onProgress === 'function') onProgress({ pct: 1, text: '启动 dry-run...' });
	        // Forward progress updates by temporarily wrapping renderProgress.
	        if (typeof onProgress === 'function') {
	          const old = renderProgress;
	          // eslint-disable-next-line no-func-assign
	          renderProgress = () => {
	            old();
	            onProgress({ pct: state.progress.pct || 0, text: state.progress.text || '' });
	          };
	          try {
	            await runDryRun(opts);
	          } finally {
	            // eslint-disable-next-line no-func-assign
	            renderProgress = old;
	          }
	        } else {
	          await runDryRun(opts);
	        }
	        if (typeof onProgress === 'function') onProgress({ pct: 100, text: 'dry-run 完成' });
	      },
	      applyPlan: async (onProgress, opts) => {
	        if (typeof onProgress === 'function') onProgress({ pct: 1, text: '写入中...' });
	        await applyPlanWithOpts(opts);
	        if (typeof onProgress === 'function') onProgress({ pct: 100, text: '写入完成' });
	      },
      applyOne: async (channelId, onProgress, opts) => {
        if (typeof onProgress === 'function') onProgress({ pct: 30, text: '提交更新...' });
        await applyOneWithOpts(channelId, opts);
        if (typeof onProgress === 'function') onProgress({ pct: 100, text: '写入完成' });
      },
      getCheckpoints: async () => getCheckpoints(),
      deleteCheckpoint: async (id) => deleteCheckpointById(id),
      rollbackLast: async (onProgress) => {
        if (typeof onProgress === 'function') onProgress({ pct: 1, text: '回滚中...' });
        await rollbackLastCheckpoint();
        if (typeof onProgress === 'function') onProgress({ pct: 100, text: '回滚完成' });
      },
      rollbackById: async (id, onProgress) => {
        if (typeof onProgress === 'function') onProgress({ pct: 1, text: '回滚中...' });
        await rollbackCheckpoint(id);
        if (typeof onProgress === 'function') onProgress({ pct: 100, text: '回滚完成' });
      },
	    };
    // Load cached snapshot/plan for fast startup.
    try {
      const settings = await idbGet('settings');
      if (settings && typeof settings.pinnedKeys === 'boolean') state.pinnedKeys = settings.pinnedKeys;
      if (settings && (settings.theme === 'light' || settings.theme === 'dark')) state.theme = settings.theme;
      const snap = await idbGet('snapshot');
      if (snap && snap.channels && snap.channels.length) state.snapshot = snap;
      const plan = await idbGet('plan');
      if (plan && plan.perChannel) state.plan = plan;
    } catch (e) {
      log('cache load failed', e);
    }
    applyThemeToLocalUI();
    render();
  }

  bootstrap();
})();
