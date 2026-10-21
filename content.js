/* ZC 会话追踪助手 - content script
 * 职责：
 * 1) 代理调用 zc.tencent.com 的网关 API（token 从 localStorage.user_info 读取）
 * 2) 详情抓取：按 event 分页拉全，输出结构化分类条目（模型响应/工具调用/工具结果/用户输入/系统注解）
 * 3) 在漏洞提交页操作子步骤表单：打开弹窗、填名称/描述/参与度/会话ID、点确定
 */

(() => {
  const PROJECT_CODE = new URLSearchParams(location.search).get('project_code') || 'PROJ2026_AISRC01';
  const API_BASE = '/api/v1/whitehat/ai_gateway';
  const MAX_TEXT = 100000; // 单条文本上限，避免超长会话拖慢传输/存储

  // 页级闸门：限制同时在途的 API 请求总数（跨所有会话共享）。
  // 会话有大会话/小会话之分，按「会话数」限并发在混合负载下抖动；
  // 页级闸门让每次详情会话（1~N 页）自动分摊带宽。
  let pageLimit = 8;
  let pageInFlight = 0;
  let pagesDone = 0;       // 累计完成的页请求数（AIMD 观测用）
  let pageErrs = 0;        // 累计失败的页请求数
  const pageWaiters = [];
  function setMaxConcurrentPages(n) {
    pageLimit = Math.max(1, Math.min(48, Math.round(n)));
  }
  async function acquirePageSlot() {
    if (pageInFlight < pageLimit) { pageInFlight++; return; }
    await new Promise((resolve) => pageWaiters.push(resolve));
    pageInFlight++;
  }
  function releasePageSlot() {
    pageInFlight--;
    const w = pageWaiters.shift();
    if (w) w();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getToken() {
    try {
      const info = JSON.parse(localStorage.getItem('user_info') || '{}');
      return info.token || '';
    } catch {
      return '';
    }
  }

  async function apiPost(path, body) {
    await acquirePageSlot();
    try {
      const out = await doApiPost(path, body);
      pagesDone++;
      return out;
    } catch (e) {
      pageErrs++;
      throw e;
    } finally {
      releasePageSlot();
    }
  }

  async function doApiPost(path, body) {
    const token = getToken();
    if (!token) throw new Error('未取到登录 token（请确认已登录）');
    const resp = await fetch(`${API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json, text/plain, */*',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.code !== 1) {
      throw new Error(data.msg || `HTTP ${resp.status}`);
    }
    return data.data;
  }

  /* ---------- 消息路由 ---------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            sendResponse({ ok: true, page: detectPage() });
            return;
          case 'SET_PAGE_LIMIT':
            setMaxConcurrentPages(msg.limit || 8);
            sendResponse({ ok: true, limit: pageLimit });
            return;
          case 'GET_PAGE_STATS':
            sendResponse({ ok: true, limit: pageLimit, inFlight: pageInFlight, pagesDone, pageErrs });
            return;
          case 'FETCH_SESSIONS': {
            const data = await apiPost('sessions', {
              project_code: PROJECT_CODE,
              page: msg.page || 1,
              page_size: msg.pageSize || 20,
            });
            sendResponse({ ok: true, items: data.items || [], pagination: data.pagination });
            return;
          }
          case 'FETCH_DETAIL': {
            // 所有页（含首页）并发发起，由页级闸门统一限流；缺哪页补哪页
            const fetchPage = (p) =>
              apiPost('session_detail', {
                project_code: PROJECT_CODE,
                session_id: msg.sessionId,
                page: p,
                page_size: 100,
              });

            const prePages = Math.max(1, Math.min(Number(msg.prePages) || 1, 6));
            const pre = await Promise.all(
              Array.from({ length: prePages }, (_, i) => fetchPage(i + 1).catch(() => null)),
            );
            if (!pre[0]) throw new Error('会话详情首页拉取失败');
            const totalPages = pre[0].pagination?.total_pages || 1;
            const pageSteps = new Map();
            pre.forEach((r, i) => {
              if (r) pageSteps.set(i + 1, r.steps || []);
            });
            // 缺哪页补哪页：预取失败的页、超出预取范围的页都在这里补
            const missing = [];
            for (let p = 1; p <= totalPages; p++) if (!pageSteps.has(p)) missing.push(p);
            await Promise.all(
              missing.map((q) =>
                fetchPage(q).then((r) => pageSteps.set(q, r.steps || [])).catch(() => pageSteps.set(q, [])),
              ),
            );
            const entries = [];
            let stepCount = 0;
            for (let p = 1; p <= totalPages; p++) {
              const steps = pageSteps.get(p) || [];
              stepCount += steps.length;
              for (const step of steps) {
                for (const item of step.items || []) {
                  if (!item.text && !(item.args && Object.keys(item.args).length)) continue;
                  const cat = categorize(item);
                  let argsStr = item.args ? argsToText(item.args) : '';
                  if (argsStr.length > MAX_TEXT) argsStr = argsStr.slice(0, MAX_TEXT) + '\n…(过长截断)';
                  let text = item.text || '';
                  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n…(过长截断)';
                  entries.push({
                    seq: step.seq,
                    cat,
                    tool: item.kind === 'tool_call' ? (item.name || 'tool') : (item.kind === 'tool_result' ? (item.name || '') : ''),
                    isError: !!item.is_error,
                    args: argsStr,
                    text,
                    time: step.captured_at,
                    charLen: item.char_len || text.length,
                  });
                }
              }
            }
            sendResponse({ ok: true, session: pre[0].session || null, entries, totalPages, stepCount });
            return;
          }
          case 'FILL_SUBSTEP': {
            const result = await fillSubstep(msg.sessionId, msg.stage, msg.detailText);
            sendResponse(result);
            return;
          }
          default:
            sendResponse({ ok: false, error: 'unknown message' });
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async sendResponse
  });

  function detectPage() {
    const path = location.pathname;
    if (path.includes('vulnSubmit')) return 'vulnSubmit';
    if (path.includes('aiGateway')) return 'aiGateway';
    return 'other';
  }

  // 分类：与前端展示的五大类一致
  function categorize(item) {
    switch (item.kind) {
      case 'assistant_text': return 'assistant';
      case 'thinking': return 'thinking';
      case 'tool_call': return 'tool_call';
      case 'tool_result': return 'tool_result';
      case 'user_text': return 'user';
      case 'system_note': return 'system';
      case 'session_note': return 'system';
      default:
        if (item.role === 'assistant') return 'assistant';
        if (item.role === 'user') return 'user';
        if (item.role === 'tool') return 'tool_result';
        if (item.role === 'system') return 'system';
        return 'other';
    }
  }

  // args 对象 → 可读文本（如 {"command":"..."} → command: ...）
  function argsToText(args) {
    try {
      if (args == null) return '';
      if (typeof args === 'string') return args;
      return Object.entries(args)
        .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join('\n');
    } catch {
      return String(args);
    }
  }

  /* ---------- 子步骤表单操作 ---------- */

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  };

  // Vue 兼容赋值：用原生 setter 再派发 input/change
  function setInputValue(input, value) {
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getVisibleSubstepDialog() {
    return Array.from(document.querySelectorAll('.t-dialog')).find(
      (d) => isVisible(d) && d.querySelector('.ai-substep-form'),
    );
  }

  async function fillSubstep(sessionId, stage, detailText) {
    // 1) 定位目标步骤容器
    const steps = document.querySelectorAll('.ai-step');
    if (steps.length < 3) return { ok: false, error: '页面上未找到 3 个申报步骤容器' };
    const target = steps[stage];
    if (!target) return { ok: false, error: `步骤 ${stage + 1} 不存在` };

    // 2) 若弹窗已开着，先取消，保证状态干净
    let dialog = getVisibleSubstepDialog();
    if (dialog) {
      const cancel = Array.from(dialog.querySelectorAll('.t-dialog__footer button')).find((b) =>
        b.textContent.includes('取消'),
      );
      cancel?.click();
      await sleep(400);
    }

    // 3) 点击目标步骤的「新增子步骤」
    const addBtn = target.querySelector('.ai-sub-add');
    if (!addBtn) return { ok: false, error: '未找到「新增子步骤」按钮' };
    addBtn.click();
    await sleep(800);

    dialog = getVisibleSubstepDialog();
    if (!dialog) return { ok: false, error: '新增子步骤弹窗未打开' };

    // 4) 填子步骤名称（必填）
    const nameInput = dialog.querySelector('.t-form-item__name input.t-input__inner');
    if (!nameInput) return { ok: false, error: '未找到子步骤名称输入框' };
    setInputValue(nameInput, `会话#${sessionId}`);

    // 5) 填步骤描述（非必填）：放会话标题/摘要
    const descTa = dialog.querySelector('.t-form-item__description textarea');
    if (descTa) {
      const titleLine = (detailText || '').split('\n').find((l) => l.trim()) || '';
      const desc = buildDescription(titleLine || `AI 网关会话 #${sessionId}`);
      setInputValue(descTa, desc);
    }

    // 6) AI 参与度选「AI 自动」（p=1）——如需其他档位改这里
    //    TDesign 下拉 option 渲染在 popup 容器里，span 本身可能报不可见，直接按类名+文本点击
    const partInput = dialog.querySelector('.t-form-item__participation .t-input__inner');
    if (partInput) {
      partInput.click(); // 打开下拉
      await sleep(500);
      let picked = false;
      const candidates = document.querySelectorAll('.t-select-option, [role="option"]');
      for (const o of candidates) {
        if (o.textContent.includes('AI 自动') || o.textContent.includes('AI自动')) {
          o.click();
          picked = true;
          break;
        }
      }
      if (picked) {
        await sleep(600);
      } else {
        partInput.click(); // 收起
      }
    }

    // 7) 填平台会话 ID（选了 AI 参与度后才会出现）
    let sidInput = null;
    for (let i = 0; i < 10; i++) {
      sidInput = dialog.querySelector('.t-form-item__session_id input.t-input__inner');
      if (sidInput) break;
      await sleep(300);
    }
    if (sidInput) {
      setInputValue(sidInput, String(sessionId));
    } else {
      return { ok: false, error: '会话 ID 输入框未出现（参与度可能未生效）' };
    }

    // 8) 点「确定」提交——页面确认后弹窗保持打开（便于连续添加），以子步骤列表是否新增为准
    const confirmBtn = Array.from(dialog.querySelectorAll('.t-dialog__footer button')).find((b) =>
      b.textContent.includes('确定'),
    );
    if (!confirmBtn) return { ok: false, error: '未找到「确定」按钮' };
    const listBefore = target.querySelectorAll('.ai-sub-row').length;
    confirmBtn.click();

    // 9) 校验：目标步骤子步骤列表行数增加，或弹窗自行关闭（表单校验失败则行数不变）
    let added = false;
    for (let i = 0; i < 15; i++) {
      await sleep(400);
      const stillOpen = getVisibleSubstepDialog();
      if (!stillOpen) { added = true; break; }
      if (target.querySelectorAll('.ai-sub-row').length > listBefore) { added = true; break; }
    }
    if (!added) {
      const stuck = getVisibleSubstepDialog();
      const errText = stuck
        ? Array.from(stuck.querySelectorAll('[class*="error"]')).map((e) => e.textContent.trim()).filter(Boolean).slice(0, 3).join(' | ')
        : '';
      stuck && Array.from(stuck.querySelectorAll('.t-dialog__footer button')).find((b) => b.textContent.includes('取消'))?.click();
      return { ok: false, error: `确认未生效${errText ? `：${errText}` : ''}` };
    }

    return { ok: true, sessionId, stage };
  }

  function buildDescription(detailText) {
    let desc = detailText || '';
    if (desc.length > 480) desc = desc.slice(0, 480) + '…';
    return desc;
  }
})();
