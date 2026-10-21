/* ZC 会话追踪助手 - side panel 逻辑
 * 存储模型（chrome.storage.local，按会话分键避免整库重写）：
 *   zcth:sessions  = { sid: 平台会话对象(不含 detail) }   列表元数据，一次写
 *   zcth:detail:<sid> = { entries: [...], n: 条数 }        每会话一条详情索引，独立写
 * - 首次抓取全量；之后增量（列表从第 1 页翻到已知 sid 即停）
 * - 索引并发由 content script 的页级闸门控制（请求级 AIMD 8→40 自适应）；详情写入攒批落盘
 * - 打开面板只读缓存渲染，不自动重拉详情
 */

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const searchInput = $('#searchInput');
const clearKwBtn = $('#clearKw');
const fillBtn = $('#fillBtn');
const statusEl = $('#status');
const targetBanner = $('#targetBanner');
const countInfo = $('#countInfo');
const crawlBar = $('#crawlBar');
const crawlText = $('#crawlText');
const crawlProgress = $('#crawlProgress');
const sortSel = $('#sortSel');
const statTotal = $('#statTotal');
const statIndexed = $('#statIndexed');
const statHits = $('#statHits');
const catGroup = $('#catGroup');

const PAGE_SIZE = 100;
const IDX_MAX_WORKERS = 64;      // 会话级 worker 上限（真实限流在 content script 的页级闸门）
const REQ_START_LIMIT = 8;       // 页级并发起点（请求级 AIMD）
const REQ_MAX_LIMIT = 40;        // 页级并发上限
const REQ_MIN_LIMIT = 4;         // 页级并发下限
const DETAIL_WRITE_BATCH = 16;   // 详情落盘批大小
const DETAIL_WRITE_DELAY = 400;  // 或最长 400ms 落一次盘
let stepsPerEvent = 0.5;         // 学习值：每 1 个 event 约等于多少 step，用于预取页数估算
const KEY_SESSIONS = 'zcth:sessions';
const KEY_DETAIL = (sid) => `zcth:detail:${sid}`;

const CATS = {
  assistant:   { label: '模型响应', color: '#4f8ef7' },
  thinking:    { label: '思考过程', color: '#9b7bf7' },
  tool_call:   { label: '工具调用', color: '#ffb454' },
  tool_result: { label: '工具结果', color: '#37d6c0' },
  user:        { label: '用户输入', color: '#3ecf7a' },
  system:      { label: '系统注解', color: '#94a5ba' },
  other:       { label: '其他', color: '#6c7f95' },
};

// sessions: sid -> 平台会话对象；details: sid -> { entries }（内存）
let sessions = new Map();
let details = new Map();
let lastCrawlAt = 0;
const checkedOrder = [];
let targetStage = 0;
let contentReady = false;
let crawling = false;

/* ---------- 状态提示 ---------- */
let statusTimer = null;
function setStatus(msg, kind = '', sticky = false) {
  statusEl.textContent = msg;
  statusEl.className = kind;
  clearTimeout(statusTimer);
  if (msg && !sticky) statusTimer = setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 6000);
}

/* ---------- 全局错误捕获：把异常显示到状态栏，避免"静默崩溃" ---------- */
window.addEventListener('error', (e) => {
  try { setStatus(`面板错误：${e.message || e}`, 'err', true); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  try { setStatus(`面板异常：${e.reason?.message || e.reason}`, 'err', true); } catch {}
});

/* ---------- 持久化（分键存储） ---------- */
async function safeSet(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    setStatus(`存储写入失败：${e.message}`, 'err');
  }
}
async function saveSessions() {
  const obj = {};
  for (const [sid, item] of sessions) obj[sid] = item;
  await safeSet({ [KEY_SESSIONS]: obj, lastCrawlAt });
}
async function saveDetail(sid, detail) {
  await safeSet({ [KEY_DETAIL(sid)]: detail });
}
// 记录有哪些 detail 键，便于加载与清理
async function saveDetailKeys(keys) {
  await safeSet({ 'zcth:detailKeys': keys });
}

// 索引期间的详情写入先入队，攒批落盘，避免每会话一次 storage IPC
const pendingDetails = new Map();
let detailFlushTimer = null;
let lastKeysSaveAt = 0;
function queueDetailSave(sid, detail) {
  pendingDetails.set(KEY_DETAIL(sid), detail);
  if (pendingDetails.size >= DETAIL_WRITE_BATCH) { flushDetailWrites(); return; }
  if (!detailFlushTimer) detailFlushTimer = setTimeout(flushDetailWrites, DETAIL_WRITE_DELAY);
}
async function flushDetailWrites() {
  clearTimeout(detailFlushTimer);
  detailFlushTimer = null;
  if (!pendingDetails.size) return;
  const obj = Object.fromEntries(pendingDetails);
  pendingDetails.clear();
  // 顺带记录已索引的键（最多 2 秒一次）：中途关闭面板/重载插件后能接着跑，不重拉
  if (Date.now() - lastKeysSaveAt > 2000) {
    obj['zcth:detailKeys'] = [...details.keys()];
    lastKeysSaveAt = Date.now();
  }
  await safeSet(obj);
}
window.addEventListener('pagehide', () => { flushDetailWrites(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDetailWrites();
});

async function loadStore() {
  const { [KEY_SESSIONS]: stored, lastCrawlAt: lca, 'zcth:detailKeys': savedKeys } = await chrome.storage.local.get([KEY_SESSIONS, 'lastCrawlAt', 'zcth:detailKeys']);
  sessions = new Map(Object.entries(stored || {}));
  lastCrawlAt = lca || 0;
  details = new Map();

  // 详情键以存储中的实际键为准（getKeys 只取键名，不会把全部数据读进内存）；
  // 老版本 Chrome 没有 getKeys 时退回 zcth:detailKeys 记录
  const prefix = 'zcth:detail:';
  let dkeys = Array.isArray(savedKeys) ? savedKeys.slice() : [];
  if (typeof chrome.storage.local.getKeys === 'function') {
    try {
      const allKeys = await chrome.storage.local.getKeys();
      dkeys = allKeys.filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
    } catch {}
  }
  if (dkeys.length) {
    const keys = dkeys.map(sid => KEY_DETAIL(sid));
    const chunk = 64;
    const chunks = [];
    for (let i = 0; i < keys.length; i += chunk) chunks.push(keys.slice(i, i + chunk));
    // 分组并行读取，减少面板启动时的串行等待
    for (let i = 0; i < chunks.length; i += 8) {
      const parts = await Promise.all(chunks.slice(i, i + 8).map(c => chrome.storage.local.get(c)));
      for (const part of parts) {
        for (const [k, v] of Object.entries(part)) {
          const sid = k.replace(prefix, '');
          if (v && v.entries) details.set(sid, v);
        }
      }
    }
  }
}

/* ---------- 与内容脚本通信 ---------- */
// 缓存目标 tab，避免每条消息都全窗口 query 一次；失效（刷新/关页）时自动重查
let cachedTabId = null;

async function resolveTab() {
  if (cachedTabId != null) {
    try {
      const tab = await chrome.tabs.get(cachedTabId);
      if (tab && tab.url && tab.url.startsWith('https://zc.tencent.com')) return tab;
    } catch {}
    cachedTabId = null;
  }
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = active && active.url && active.url.startsWith('https://zc.tencent.com') ? active : null;
  if (!tab) {
    // 激活的不是 ZC 页时，任意 ZC 标签页都能代理接口（优先漏洞提交页）
    const zcTabs = await chrome.tabs.query({ url: 'https://zc.tencent.com/*' });
    tab = zcTabs.find(t => (t.url || '').includes('vulnSubmit')) || zcTabs[0] || null;
  }
  if (!tab) throw new Error('请先打开 zc.tencent.com 的页面');
  cachedTabId = tab.id;
  return tab;
}

async function sendToContent(message) {
  const tab = await resolveTab();
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (e) {
    cachedTabId = null; // 缓存失效，重查一次
    const tab2 = await resolveTab();
    return chrome.tabs.sendMessage(tab2.id, message);
  }
}

async function pingContent() {
  try {
    const resp = await sendToContent({ type: 'PING' });
    contentReady = resp && resp.ok;
  } catch {
    contentReady = false;
  }
  renderTargetBanner();
}

const ICON_OK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1.5px"><path d="M4 12.5l5 5L20 6.5"/></svg>';
const ICON_BAD = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="vertical-align:-1.5px"><circle cx="12" cy="12" r="9"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>';
const ICON_SEARCH_BIG = '<svg class="big-icon" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5M11 8v6M8 11h6"/></svg>';
const ICON_EMPTY_WIFI = '<svg class="big-icon" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.5"/><path d="M4.9 8.5a9 9 0 0114.2 0M2 5.5a13 13 0 0120 0M7.8 11.6a5 5 0 018.4 0M12 18.5v.01"/></svg>';

function renderTargetBanner() {
  if (contentReady) {
    targetBanner.className = 'ok';
    targetBanner.innerHTML = `${ICON_OK} 已连接漏洞提交页 <button id="reloadConn">重新检测</button>`;
  } else {
    targetBanner.className = 'bad';
    targetBanner.innerHTML = `${ICON_BAD} 未检测到提交页——请打开漏洞提交页后重试 <button id="reloadConn">重新检测</button>`;
  }
  $('#reloadConn').addEventListener('click', pingContent);
}

/* ---------- 抓取 ---------- */
function showCrawl(show) {
  crawlBar.style.display = show ? 'block' : 'none';
  if (!show) crawlProgress.style.width = '0%';
}
function setProgress(pct, text) {
  crawlProgress.style.width = `${Math.round(pct)}%`;
  if (text) crawlText.textContent = text;
}

async function crawlSessionsIncremental() {
  const known = new Set(sessions.keys());
  let page = 1, total = 0, totalPages = 1, newCount = 0, stop = false;

  while (!stop) {
    const resp = await sendToContent({ type: 'FETCH_SESSIONS', page, pageSize: PAGE_SIZE });
    if (!resp.ok) throw new Error(resp.error || '接口失败');
    const items = resp.items || [];
    totalPages = resp.pagination?.total_pages || 1;
    total = resp.pagination?.total || 0;
    for (const it of items) {
      const sid = String(it.session_id);
      if (known.has(sid)) { stop = true; break; }
      known.add(sid);
      sessions.set(sid, it);
      newCount++;
    }
    setProgress(0, `会话列表：第 ${page}/${totalPages} 页，新增 ${newCount} 条…`);
    if (page >= totalPages) break;
    page++;
    if (!stop) await new Promise(r => setTimeout(r, 120));
  }
  return { total, newCount };
}

// 为缺详情索引的会话建立索引。
// 并发控制在 content script 的页级闸门（请求级 AIMD）：大会话/小会话单条耗时差异大，
// 按会话数限并发会被大会话拖出的低速率骗去退避（v1.0.6 的回归）；按页（HTTP 请求）
// 观测吞吐才稳定，页数与实际网络开销成正比。
async function buildIndex() {
  const need = [];
  for (const sid of sessions.keys()) {
    if (!details.has(sid)) need.push(sid);
  }
  const total = need.length;
  if (!total) return { total: 0, errs: [] };
  let done = 0;
  const errs = [];
  const detailKeys = [...details.keys()];
  const startedAt = Date.now();

  // 页级 AIMD：每 3 秒一窗，按「完成的页请求数」与「页错误数」调整页级并发上限
  let reqLimit = REQ_START_LIMIT;
  try { await sendToContent({ type: 'SET_PAGE_LIMIT', limit: reqLimit }); } catch {}
  let bestReqRate = 0;
  let reqEma = 0;
  let lastPagesDone = 0;
  let lastPageErrs = 0;
  let lastTick = Date.now();
  const controller = setInterval(async () => {
    if (done >= total) return;
    let stats;
    try { stats = await sendToContent({ type: 'GET_PAGE_STATS' }); } catch { return; }
    const now = Date.now();
    const dt = Math.max((now - lastTick) / 1000, 0.001);
    lastTick = now;
    const pages = stats.pagesDone ?? 0;
    const perrs = stats.pageErrs ?? 0;
    const windowRate = (pages - lastPagesDone) / dt;
    const windowErrs = perrs - lastPageErrs;
    lastPagesDone = pages;
    lastPageErrs = perrs;
    reqEma = reqEma ? reqEma * 0.5 + windowRate * 0.5 : windowRate;
    if (windowErrs > 0) {
      reqLimit = Math.max(REQ_MIN_LIMIT, Math.floor(reqLimit * 0.75)); // 出错：退避
    } else if (reqEma > 0) {
      if (bestReqRate > 0 && reqEma < bestReqRate * 0.85) {
        reqLimit = Math.max(REQ_MIN_LIMIT, Math.floor(reqLimit * 0.75)); // 吞吐下降：退避
      } else {
        bestReqRate = Math.max(bestReqRate, reqEma);
        if (reqEma >= bestReqRate * 0.97) {
          reqLimit = Math.min(REQ_MAX_LIMIT, reqLimit + 4); // 吞吐没掉：继续加
        }
      }
    }
    try { await sendToContent({ type: 'SET_PAGE_LIMIT', limit: reqLimit }); } catch {}
  }, 3000);

  const fetchOne = async (sid) => {
    const meta = sessions.get(sid) || {};
    const ev = Number(meta.event_count ?? meta.range_call_count ?? 0) || 0;
    // 按学习到的 step/event 比例估算总页数，与首页并行预取（页级闸门兜底限流）
    const estPages = ev > 0
      ? Math.max(1, Math.min(Math.ceil((ev * stepsPerEvent) / PAGE_SIZE), 6))
      : 1;

    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await sendToContent({ type: 'FETCH_DETAIL', sessionId: Number(sid), prePages: estPages });
        if (!resp.ok) throw new Error(resp.error || '详情失败');
        if (resp.stepCount > 0 && ev > 0) {
          const observed = resp.stepCount / ev;
          stepsPerEvent = Math.max(0.05, Math.min(3, stepsPerEvent * 0.6 + observed * 0.4));
        }
        return resp;
      } catch (e) {
        lastErr = e;
        if (attempt === 0) await new Promise(r => setTimeout(r, 300));
      }
    }
    throw lastErr;
  };

  const worker = async () => {
    while (need.length) {
      const sid = need.shift();
      if (sid === undefined) break;
      try {
        const resp = await fetchOne(sid);
        const detail = { entries: resp.entries || [] };
        details.set(sid, detail);
        detailKeys.push(sid);
        queueDetailSave(sid, detail); // 攒批落盘
      } catch (e) {
        // 失败不落盘空索引，留待下次抓取/重建时重试
        errs.push({ sid, msg: e?.message || String(e) });
      }
      done++;
      if (done === 1 || done % 5 === 0 || done === total) {
        const sec = Math.max((Date.now() - startedAt) / 1000, 0.001);
        const perSec = done / sec;
        const remain = total - done;
        const eta = remain > 0 ? Math.ceil(remain / perSec) : 0;
        setProgress(
          (done / total) * 100,
          `会话索引：${done}/${total} · ${perSec.toFixed(1)} 条/秒 · 页并发 ${reqLimit}${remain > 0 ? ` · 剩余约 ${eta}s` : ''}${errs.length ? `（失败 ${errs.length}）` : ''}`,
        );
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(IDX_MAX_WORKERS, total) }, worker));
  } finally {
    clearInterval(controller);
  }
  await flushDetailWrites();
  await saveDetailKeys(detailKeys);
  return { total, errs };
}

async function crawlAll() {
  if (crawling) return;
  if (!contentReady) await pingContent();
  if (!contentReady) { setStatus('提交页未就绪，请先打开漏洞提交页', 'err'); return; }

  crawling = true;
  $('#loadBtn').disabled = true;
  $('#loadBtn').innerHTML = '<span class="spin"></span> 抓取中';
  $('#indexBtn').disabled = true;
  showCrawl(true);
  setStatus('');
  try {
    const isFirst = sessions.size === 0;
    const r1 = await crawlSessionsIncremental();
    const msg1 = isFirst ? `首次抓取完成：共 ${r1.total} 条会话` : `增量抓取完成：新增 ${r1.newCount} 条（共 ${sessions.size} 条）`;
    setProgress(0, msg1);
    await saveSessions();

    const r2 = await buildIndex();
    const idxMsg = r2.total ? `，索引 ${r2.total} 条${r2.errs.length ? `（失败 ${r2.errs.length}）` : ''}` : '，索引已最新';
    setStatus(msg1 + idxMsg, r2.errs.length ? 'err' : 'ok');
    renderList();
  } catch (e) {
    setStatus(`抓取失败：${e.message}`, 'err');
    await saveSessions();
  } finally {
    showCrawl(false);
    crawling = false;
    $('#loadBtn').disabled = false;
    $('#loadBtn').textContent = sessions.size ? '增量抓取' : '抓取全部';
    $('#indexBtn').disabled = sessions.size === 0;
  }
}

async function rebuildIndex() {
  if (crawling) return;
  crawling = true;
  $('#indexBtn').disabled = true;
  $('#indexBtn').innerHTML = '<span class="spin"></span>';
  $('#loadBtn').disabled = true;
  showCrawl(true);
  try {
    // 清掉旧 detail 键（同时丢弃未落盘的旧队列，避免把旧数据写回来）
    clearTimeout(detailFlushTimer);
    detailFlushTimer = null;
    pendingDetails.clear();
    const removeKeys = [...details.keys()].map(sid => KEY_DETAIL(sid));
    details = new Map();
    if (removeKeys.length) {
      for (let i = 0; i < removeKeys.length; i += 64) {
        await chrome.storage.local.remove(removeKeys.slice(i, i + 64));
      }
    }
    // 重建走的是老版本的 detailKeys 记录，也一并清空，避免下次启动读到已删除的键
    await safeSet({ 'zcth:detailKeys': [] });
    const r = await buildIndex();
    setStatus(`索引重建完成：${r.total} 条${r.errs.length ? `（失败 ${r.errs.length}）` : ''}`, r.errs.length ? 'err' : 'ok');
    renderList();
  } finally {
    showCrawl(false);
    crawling = false;
    $('#indexBtn').innerHTML = '重建索引';
    $('#indexBtn').disabled = false;
    $('#loadBtn').disabled = false;
  }
}

/* ---------- 查询（不缓存全文，直接扫描，内存恒定） ---------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeReg(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function parseQuery(q) {
  return q.trim().split('|').map(g => g.trim().split(/\s+/).filter(Boolean).map(w => w.toLowerCase())).filter(g => g.length);
}

// 编译匹配器：每组（OR）内的词（AND）各编译一个大小写不敏感正则，避免为大文本生成小写副本
function buildMatchers(groups) {
  return groups.map(g => g.map(w => ({ w, re: new RegExp(escapeReg(w), 'i') })));
}

// 条目内匹配：逐字段 test，避免为每条目拼接大字符串（3638 条会话时节省大量分配）
function termInEntry(t, e) {
  if (e.args && t.re.test(e.args)) return true;
  if (e.text && t.re.test(e.text)) return true;
  if (e.tool && t.re.test(e.tool)) return true;
  return false;
}
function anyTermInEntry(e, matchers) {
  for (const g of matchers) {
    let all = true;
    for (const t of g) {
      if (!termInEntry(t, e)) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}
function anyTermIn(hay, matchers) {
  for (const g of matchers) {
    let all = true;
    for (const t of g) {
      if (!t.re.test(hay)) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

// 命中判定：标题/ID/模型 或（所选类目的条目）
function matchItem(sid, item, matchers, catKeys) {
  if (!matchers.length) return true;
  const titleHay = (item.title || '') + ' ' + sid + ' ' + (item.model || '');
  if (anyTermIn(titleHay, matchers)) return true;
  const d = details.get(sid);
  if (!d) return false;
  const only = catKeys.length ? new Set(catKeys) : null;
  for (const e of d.entries) {
    if (only && !only.has(e.cat)) continue;
    if (anyTermInEntry(e, matchers)) return true;
  }
  return false;
}

// 命中类目集合（一次扫描）
function hitCats(sid, item, matchers, catKeys) {
  if (!matchers.length) return [];
  const out = new Set();
  const titleHay = (item.title || '') + ' ' + sid + ' ' + (item.model || '');
  for (const g of matchers) for (const t of g) {
    if (t.re.test(titleHay)) out.add('title');
  }
  const d = details.get(sid);
  if (!d) return [...out];
  const only = catKeys.length ? new Set(catKeys) : null;
  for (const e of d.entries) {
    if (only && !only.has(e.cat)) continue;
    if (out.has(e.cat)) continue;
    if (anyTermInEntry(e, matchers)) out.add(e.cat);
  }
  return [...out];
}

function bestExcerpt(sid, item, matchers) {
  const d = details.get(sid);
  if (!d || !matchers.length) return null;
  for (const e of d.entries) {
    const src = (e.args ? e.args + '\n' : '') + (e.text || '');
    if (!src) continue;
    for (const g of matchers) {
      for (const t of g) {
        const m = t.re.exec(src);
        if (!m) continue;
        const idx = m.index;
        const start = Math.max(0, idx - 50);
        const end = Math.min(src.length, idx + t.w.length + 90);
        let frag = (start > 0 ? '…' : '') + src.slice(start, end).replace(/\s+/g, ' ') + (end < src.length ? '…' : '');
        return { cat: e.cat, html: highlight(escapeHtml(frag), matchers) };
      }
    }
  }
  return null;
}

function currentCatKeys() {
  return [...catGroup.querySelectorAll('.catchip.on')].map(c => c.dataset.cat);
}

function sortItems(list) {
  const mode = sortSel.value;
  const num = (v) => Number(v) || 0;
  const cmp = {
    time: (a, b) => new Date(b.last_active_at || 0) - new Date(a.last_active_at || 0),
    calls: (a, b) => num(b.range_call_count ?? b.event_count) - num(a.range_call_count ?? a.event_count),
    tokens: (a, b) => {
      const tt = (u) => u ? (u.input || 0) + (u.output || 0) + (u.reasoning || 0) : 0;
      return tt(b.total_usage) - tt(a.total_usage);
    },
    sid: (a, b) => num(b.session_id) - num(a.session_id),
  }[mode];
  return list.sort(cmp);
}

/* ---------- 渲染 ---------- */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTokens(u) {
  if (!u) return '';
  const total = (u.input || 0) + (u.output || 0) + (u.reasoning || 0);
  if (total >= 1000000) return `${(total / 1000000).toFixed(1)}M tok`;
  if (total >= 1000) return `${(total / 1000).toFixed(1)}K tok`;
  return `${total} tok`;
}
// 高亮：接受纯词数组、matchers（{w,re}）或分组 matchers（[[{w,re}],…]），统一摊平
function highlight(textHtml, matchersOrWords) {
  if (!matchersOrWords || !matchersOrWords.length) return textHtml;
  const words = new Set();
  const add = (x) => {
    if (!x) return;
    if (typeof x === 'string') { words.add(x); return; }
    if (Array.isArray(x)) { x.forEach(add); return; }
    if (x.w) words.add(x.w);
  };
  matchersOrWords.forEach(add);
  let out = textHtml;
  for (const w of words) {
    out = out.replace(new RegExp(escapeReg(escapeHtml(w)), 'gi'), (m) => `<mark>${m}</mark>`);
  }
  return out;
}

function currentFilter() {
  const chip = document.querySelector('.filterbar .chip.on');
  return chip ? chip.dataset.f : 'all';
}

function updateStats(hits, hasKw) {
  statTotal.textContent = sessions.size || '–';
  statIndexed.textContent = sessions.size ? details.size : '–';
  statHits.textContent = hasKw ? hits : '–';
}

/* 分块渲染：一次最多画 RENDER_CHUNK 张卡片，避免数百卡片一次性建 DOM */
const RENDER_CHUNK = 60;
let renderState = { list: [], rendered: 0, matchers: [], hasKw: false };

function renderList() {
  const kw = searchInput.value.trim();
  const groups = parseQuery(kw);
  const hasKw = groups.length > 0;
  const matchers = buildMatchers(groups);
  const cats = currentCatKeys();
  const filter = currentFilter();

  let list = [...sessions.entries()].map(([sid, it]) => ({ sid, ...it }));
  if (hasKw) list = list.filter(it => matchItem(it.sid, it, matchers, cats));
  const hits = hasKw ? list.length : 0;
  if (filter === 'checked') list = list.filter(it => checkedOrder.includes(it.sid));
  sortItems(list);

  countInfo.innerHTML = hasKw ? `命中 <b>${hits}</b> / ${sessions.size}` : `${list.length} 条`;

  if (!list.length) {
    listEl.innerHTML = `<div class="empty">${hasKw ? ICON_SEARCH_BIG : ICON_EMPTY_WIFI}${hasKw ? '没有命中的会话——试试别的关键词/类目，或先「增量抓取」' : '点击「抓取全部」开始'}</div>`;
    updateStats(hits, hasKw);
    return;
  }

  listEl.innerHTML = '';
  renderState = { list, rendered: 0, matchers, hasKw };
  appendChunk();
  updateStats(hits, hasKw);
}

function appendChunk() {
  const { list, matchers, hasKw } = renderState;
  const end = Math.min(renderState.rendered + RENDER_CHUNK, list.length);
  for (let i = renderState.rendered; i < end; i++) {
    listEl.appendChild(buildCard(list[i], matchers, hasKw));
  }
  renderState.rendered = end;

  // 移除旧的"加载更多"
  const oldMore = listEl.querySelector('.more-btn');
  if (oldMore) oldMore.remove();
  if (end < list.length) {
    const more = document.createElement('button');
    more.className = 'more-btn';
    more.textContent = `显示更多（已显示 ${end}/${list.length}）`;
    more.addEventListener('click', appendChunk);
    listEl.appendChild(more);
  }
}

function buildCard(s, matchers, hasKw) {
  const sid = String(s.sid);
  const div = document.createElement('div');
  div.className = 'item' + (checkedOrder.includes(sid) ? ' checked' : '');
  div.dataset.sid = sid;

  const row1 = document.createElement('div');
  row1.className = 'row1';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'checkbox';
  cb.checked = checkedOrder.includes(sid);
  cb.addEventListener('click', (e) => e.stopPropagation());
  cb.addEventListener('change', () => toggleCheck(sid, cb.checked));
  const sidEl = document.createElement('span');
  sidEl.className = 'sid';
  sidEl.textContent = `#${sid}`;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = fmtTime(s.last_active_at || s.first_captured_at);
  row1.append(cb, sidEl, time);

  const title = document.createElement('div');
  title.className = 'title';
  const rawTitle = escapeHtml((s.title || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '(无标题)');
  title.innerHTML = highlight(rawTitle, matchers);
  title.title = (s.title || '').replace(/<[^>]+>/g, ' ').trim();

  div.appendChild(row1);
  div.appendChild(title);

  if (hasKw) {
    const hitList = hitCats(sid, s, matchers, currentCatKeys());
    if (hitList.length) {
      const hitRow = document.createElement('div');
      hitRow.className = 'row3';
      for (const ck of hitList) {
        const t = document.createElement('span');
        t.className = 'tag hit';
        t.textContent = ck === 'title' ? '标题' : CATS[ck]?.label || ck;
        hitRow.appendChild(t);
      }
      div.appendChild(hitRow);
    }
    const ex = bestExcerpt(sid, s, matchers);
    if (ex) {
      const exDiv = document.createElement('div');
      exDiv.className = 'excerpt';
      exDiv.innerHTML = ex.html;
      div.appendChild(exDiv);
    }
  }

  const row3 = document.createElement('div');
  row3.className = 'row3';
  const mkTag = (txt, cls = '') => {
    const t = document.createElement('span');
    t.className = 'tag ' + cls;
    t.textContent = txt;
    return t;
  };
  row3.append(
    mkTag(s.model || 'unknown', 'model'),
    mkTag(`${s.range_call_count ?? s.event_count ?? 0} 次`),
    mkTag(fmtTokens(s.total_usage)),
  );

  const actions = document.createElement('div');
  actions.className = 'actions';
  const viewBtn = document.createElement('button');
  viewBtn.textContent = '查看详情';
  viewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openViewer(sid);
  });
  const fillOne = document.createElement('button');
  fillOne.textContent = '填入此条';
  fillOne.addEventListener('click', (e) => {
    e.stopPropagation();
    fillSessions([sid]);
  });
  const delOne = document.createElement('button');
  delOne.textContent = '删除';
  delOne.className = 'danger';
    delOne.addEventListener('click', async (e) => {
      e.stopPropagation();
      sessions.delete(sid);
      details.delete(sid);
      pendingDetails.delete(KEY_DETAIL(sid));
      await chrome.storage.local.remove(KEY_DETAIL(sid));
    await saveSessions();
    const dkeys = [...details.keys()];
    await saveDetailKeys(dkeys);
    const ci = checkedOrder.indexOf(sid);
    if (ci !== -1) checkedOrder.splice(ci, 1);
    renderList();
  });
  actions.append(viewBtn, fillOne, delOne);

  div.addEventListener('click', () => {
    const cb2 = div.querySelector('.checkbox');
    cb2.checked = !cb2.checked;
    toggleCheck(sid, cb2.checked);
  });

  div.appendChild(row3);
  div.appendChild(actions);
  return div;
}

function toggleCheck(sid, on) {
  const i = checkedOrder.indexOf(sid);
  if (on && i === -1) checkedOrder.push(sid);
  if (!on && i !== -1) checkedOrder.splice(i, 1);
  updateFillBtn();
  const item = listEl.querySelector(`.item[data-sid="${sid}"]`);
  if (item) item.classList.toggle('checked', on);
}

function updateFillBtn() {
  fillBtn.disabled = checkedOrder.length === 0;
  fillBtn.textContent = checkedOrder.length
    ? `一键填入 ${checkedOrder.length} 条 → 步骤${['①侦察', '②发现', '③验证'][targetStage]}`
    : '一键填入子步骤';
}

/* ---------- 会话详情查看器 ---------- */
const viewerEl = $('#viewer');
const viewerBody = $('#viewerBody');
const viewerTitle = $('#viewerTitle');
const viewerKw = $('#viewerKw');
const viewerCatChips = $('#viewerCatChips');
let viewerSid = null;
let viewerEntries = [];
let viewerCats = new Set();

async function openViewer(sid) {
  const item = sessions.get(sid);
  if (!item) return;
  viewerSid = sid;
  viewerTitle.textContent = `会话 #${sid} · ${item.model || ''}`;
  viewerKw.value = '';

  let detail = details.get(sid);
  if (!detail) {
    viewerBody.innerHTML = '<div class="v-loading"><span class="spin"></span> 正在拉取会话详情…</div>';
    viewerEl.classList.add('open');
    try {
      const resp = await sendToContent({ type: 'FETCH_DETAIL', sessionId: Number(sid) });
      if (!resp.ok) throw new Error(resp.error);
      detail = { entries: resp.entries || [] };
      details.set(sid, detail);
      await saveDetail(sid, detail);
      const dkeys = [...details.keys()];
      await saveDetailKeys(dkeys);
    } catch (e) {
      viewerBody.innerHTML = `<div class="v-loading err">拉取失败：${escapeHtml(e?.message || e)}</div>`;
      return;
    }
  } else {
    viewerEl.classList.add('open');
  }

  viewerEntries = detail.entries || [];
  viewerCats = new Set();
  renderViewerCatChips();
  renderViewer();
}

function renderViewerCatChips() {
  viewerCatChips.innerHTML = '';
  const counts = {};
  for (const e of viewerEntries) counts[e.cat] = (counts[e.cat] || 0) + 1;

  const allChip = document.createElement('span');
  allChip.className = 'vchip on';
  allChip.dataset.cat = '__all';
  allChip.textContent = `全部 ${viewerEntries.length}`;
  allChip.addEventListener('click', () => {
    viewerCats = new Set();
    viewerCatChips.querySelectorAll('.vchip').forEach(c => c.classList.toggle('on', c.dataset.cat === '__all'));
    renderViewer();
  });
  viewerCatChips.appendChild(allChip);

  for (const [ck, def] of Object.entries(CATS)) {
    if (!counts[ck]) continue;
    const chip = document.createElement('span');
    chip.className = 'vchip';
    chip.dataset.cat = ck;
    chip.innerHTML = `<i style="background:${def.color}"></i>${def.label} ${counts[ck]}`;
    chip.addEventListener('click', () => {
      if (viewerCats.has(ck)) viewerCats.delete(ck);
      else viewerCats.add(ck);
      if (viewerCats.size === 0) {
        viewerCatChips.querySelectorAll('.vchip').forEach(c => c.classList.toggle('on', c.dataset.cat === '__all'));
      } else {
        allChip.classList.remove('on');
        chip.classList.toggle('on', viewerCats.has(ck));
      }
      renderViewer();
    });
    viewerCatChips.appendChild(chip);
  }
}

/* 查看器也分块渲染，避免大会话一次性建上千 DOM 节点 */
const VIEW_CHUNK = 40;
let viewerState = { list: [], rendered: 0, words: [] };

function renderViewer() {
  const kw = viewerKw.value.trim();
  const groups = parseQuery(kw);
  const matchers = buildMatchers(groups);
  const words = [...new Set(groups.flat())];
  let list = viewerEntries;
  if (viewerCats.size) list = list.filter(e => viewerCats.has(e.cat));
  if (matchers.length) {
    list = list.filter(e => anyTermInEntry(e, matchers));
  }

  if (!list.length) {
    viewerBody.innerHTML = '<div class="v-loading">该筛选条件下没有条目</div>';
    return;
  }

  viewerBody.innerHTML = '';
  viewerState = { list, rendered: 0, words };
  appendViewerChunk();
}

function appendViewerChunk() {
  const { list, words } = viewerState;
  const end = Math.min(viewerState.rendered + VIEW_CHUNK, list.length);
  for (let i = viewerState.rendered; i < end; i++) {
    viewerBody.appendChild(buildViewerBlock(list[i], words));
  }
  viewerState.rendered = end;

  const oldMore = viewerBody.querySelector('.more-btn');
  if (oldMore) oldMore.remove();
  if (end < list.length) {
    const more = document.createElement('button');
    more.className = 'more-btn';
    more.textContent = `显示更多（已显示 ${end}/${list.length}）`;
    more.addEventListener('click', appendViewerChunk);
    viewerBody.appendChild(more);
  }
}

function buildViewerBlock(e, words) {
  const block = document.createElement('div');
  block.className = `vblock cat-${e.cat}` + (e.isError ? ' is-err' : '');

  const head = document.createElement('div');
  head.className = 'vhead';
  const def = CATS[e.cat] || CATS.other;
  head.innerHTML = `<i style="background:${def.color}"></i>
    <b>${def.label}${e.tool ? ` · ${escapeHtml(e.tool)}` : ''}${e.isError ? ' <span class="errtag">错误</span>' : ''}</b>
    <span class="vmeta">#${e.seq} · ${fmtTime(e.time)} · ${e.charLen} 字</span>`;
  block.appendChild(head);

  if (e.args) {
    const argsDiv = document.createElement('div');
    argsDiv.className = 'vargs';
    argsDiv.innerHTML = highlight(escapeHtml(e.args), words);
    block.appendChild(argsDiv);
  }

  const textDiv = document.createElement('div');
  textDiv.className = 'vtext';
  const raw = e.text || '(空)';
  textDiv.innerHTML = highlight(escapeHtml(raw.length > 8000 ? raw.slice(0, 8000) + '\n…(过长截断)' : raw), words);
  block.appendChild(textDiv);
  return block;
}

viewerKw.addEventListener('input', () => renderViewer());
$('#viewerClose').addEventListener('click', () => viewerEl.classList.remove('open'));
viewerEl.addEventListener('click', (e) => { if (e.target === viewerEl) viewerEl.classList.remove('open'); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && viewerEl.classList.contains('open')) viewerEl.classList.remove('open');
});

/* ---------- 一键填入 ---------- */
async function fillSessions(sids) {
  if (!sids.length) return;
  if (!contentReady) await pingContent();
  if (!contentReady) { setStatus('提交页未就绪，请先打开漏洞提交页', 'err'); return; }

  const stageNames = ['目标侦察', '漏洞发现', '漏洞利用与验证'];
  fillBtn.disabled = true;
  fillBtn.textContent = '填入中…';
  let ok = 0, fail = 0;
  for (const sid of sids) {
    setStatus(`正在填入 #${sid} → ${stageNames[targetStage]}…`, '', true);
    try {
      const item = sessions.get(sid) || {};
      const d = details.get(sid);
      const firstLine = (d?.entries || []).map(e => e.text || e.args || '').find(t => t.trim()) || item.title || '';
      const resp = await sendToContent({
        type: 'FILL_SUBSTEP',
        sessionId: Number(sid),
        stage: targetStage,
        detailText: firstLine,
      });
      if (resp.ok) { ok++; } else { fail++; setStatus(`#${sid} 填入失败：${resp.error}`, 'err'); }
    } catch (e) {
      fail++;
      setStatus(`#${sid} 通信失败：${e?.message || e}`, 'err');
    }
  }
  setStatus(`填入完成：成功 ${ok} 条${fail ? `，失败 ${fail} 条` : ''}（${stageNames[targetStage]}）`, fail ? 'err' : 'ok');
  fillBtn.disabled = false;
  updateFillBtn();
}

/* ---------- 事件绑定 ---------- */
$('#loadBtn').addEventListener('click', crawlAll);
$('#indexBtn').addEventListener('click', rebuildIndex);
$('#clearBtn').addEventListener('click', () => {
  checkedOrder.length = 0;
  updateFillBtn();
  renderList();
  setStatus('已清空勾选');
});
fillBtn.addEventListener('click', () => fillSessions([...checkedOrder]));

let searchTimer = null;
searchInput.addEventListener('input', () => {
  clearKwBtn.style.display = searchInput.value ? 'block' : 'none';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderList, 160);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); renderList(); }
});
clearKwBtn.addEventListener('click', () => {
  searchInput.value = '';
  clearKwBtn.style.display = 'none';
  renderList();
  searchInput.focus();
});

document.querySelectorAll('.filterbar .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filterbar .chip').forEach(c => c.classList.remove('on'));
    chip.classList.add('on');
    renderList();
  });
});
sortSel.addEventListener('change', renderList);
catGroup.addEventListener('click', (e) => {
  const chip = e.target.closest('.catchip');
  if (!chip) return;
  chip.classList.toggle('on');
  renderList();
});

document.querySelectorAll('.stageSel button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.stageSel button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    targetStage = Number(btn.dataset.stage);
    updateFillBtn();
  });
});

/* 启动：只读缓存渲染；增量抓取由用户点击触发（避免每次打开面板都打接口） */
(async () => {
  await loadStore();
  $('#loadBtn').textContent = sessions.size ? '增量抓取' : '抓取全部';
  $('#indexBtn').disabled = sessions.size === 0;
  renderList();
  await pingContent();
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === 'complete') pingContent();
  });
  chrome.tabs.onActivated.addListener(() => pingContent());
})();
