// === DOM ===
const $ = (id) => document.getElementById(id);

const captureBtn = $('captureBtn');
const exportHarBtn = $('exportHarBtn');
const exportJsonBtn = $('exportJsonBtn');
const clearBtn = $('clearBtn');
const statusBadge = $('statusBadge');
const searchInput = $('searchInput');
const methodFilter = $('methodFilter');
const statusFilter = $('statusFilter');
const requestCount = $('requestCount');
const requestList = $('requestList');
const detailPanel = $('detailPanel');
const detailContent = $('detailContent');
const detailTitle = $('detailTitle');
const closeDetailBtn = $('closeDetailBtn');
const archiveList = $('archiveList');

let capturing = false;
let currentTabId = null;
let currentSessionId = null;
let selectedSessionId = null;
let selectedReqId = null;
let allRequests = [];
let refreshTimer = null;

// === Init ===
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab?.id;

  // Tab switching
  document.querySelectorAll('.tab').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tabEl.classList.add('active');
      $(tabEl.dataset.tab + 'Tab').classList.add('active');
      if (tabEl.dataset.tab === 'archive') loadArchives();
    });
  });

  await refreshStatus();
  await refreshRequests();
  startAutoRefresh();
}

// === Messaging ===
function sendMsg(msg) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(msg, resp => resolve(resp || {}));
  });
}

// === Status ===
async function refreshStatus() {
  const s = await sendMsg({ action: 'getStatus' });
  capturing = s.capturing;
  currentSessionId = s.sessionId || null;
  if (capturing) selectedSessionId = currentSessionId;
  if (!selectedSessionId) selectedSessionId = currentSessionId || s.lastSessionId || null;
  updateUI();
}

function updateUI() {
  if (capturing) {
    statusBadge.textContent = '抓包中...';
    statusBadge.className = 'status-badge capturing';
    captureBtn.textContent = '停止抓包';
    captureBtn.classList.add('active');
  } else {
    statusBadge.textContent = '未启动';
    statusBadge.className = 'status-badge';
    captureBtn.textContent = '开始抓包';
    captureBtn.classList.remove('active');
  }
  exportHarBtn.disabled = allRequests.length === 0;
  exportJsonBtn.disabled = allRequests.length === 0;
  clearBtn.disabled = allRequests.length === 0;
}

// === Requests ===
async function refreshRequests() {
  const resp = await sendMsg({
    action: 'getRequests',
    sessionId: selectedSessionId || undefined,
    filters: {
      search: searchInput.value || undefined,
      method: methodFilter.value || undefined,
      status: statusFilter.value || undefined
    }
  });
  if (resp.ok) {
    allRequests = resp.requests;
    renderList();
    updateUI();
  }
}

function renderList() {
  requestCount.textContent = `共 ${allRequests.length} 条请求`;
  if (allRequests.length === 0) {
    requestList.innerHTML = '<div class="empty-state">暂无数据，点击「开始抓包」捕获请求</div>';
    return;
  }

  const items = [...allRequests].reverse();
  requestList.innerHTML = items.map(r => {
    const url = fmtUrl(r.url);
    const statusClass = r.failed ? 's-err' : r.status === 0 ? 's-pending' : `s-${String(r.status)[0]}xx`;
    return `<div class="request-item${r.id === selectedReqId ? ' selected' : ''}" data-id="${r.id}">
      <span class="method-badge m-${r.method}">${r.method}</span>
      <span class="status-code ${statusClass}">${r.failed ? 'ERR' : r.status || '...'}</span>
      <span class="req-url" title="${esc(r.url)}">${esc(url)}</span>
      <span class="req-size">${fmtSize(r.size)}</span>
      <span class="req-time">${fmtTime(r.duration)}</span>
    </div>`;
  }).join('');

  requestList.querySelectorAll('.request-item').forEach(el => {
    el.addEventListener('click', () => showDetail(parseInt(el.dataset.id)));
  });
}

// === Detail ===
async function showDetail(id) {
  selectedReqId = id;
  requestList.querySelectorAll('.request-item').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.id) === id);
  });

  const resp = await sendMsg({ action: 'getRequestDetail', id });
  if (!resp.ok || !resp.request) return;

  const r = resp.request;
  detailTitle.textContent = `${r.method} ${r.status || '...'}`;
  detailPanel.classList.add('visible');

  let html = `<div class="detail-section"><h3>General</h3>
    <dl class="detail-meta">
      <dt>URL</dt><dd>${esc(r.url)}</dd>
      <dt>Method</dt><dd>${r.method}</dd>
      <dt>Status</dt><dd>${r.status} ${esc(r.statusText)}</dd>
      <dt>Type</dt><dd>${r.resourceType}</dd>
      <dt>Time</dt><dd>${fmtTime(r.duration)}</dd>
      <dt>Size</dt><dd>${fmtSize(r.size)}</dd>
    </dl></div>`;

  if (r.requestHeaders && Object.keys(r.requestHeaders).length) {
    html += `<div class="detail-section"><h3>Request Headers</h3><pre>${esc(fmtHeaders(r.requestHeaders))}</pre></div>`;
  }
  if (r.requestBody) {
    html += `<div class="detail-section"><h3>Request Body</h3><pre>${esc(fmtBody(r.requestBody))}</pre></div>`;
  }
  if (r.responseHeaders && Object.keys(r.responseHeaders).length) {
    html += `<div class="detail-section"><h3>Response Headers</h3><pre>${esc(fmtHeaders(r.responseHeaders))}</pre></div>`;
  }
  if (r.responseBody) {
    html += `<div class="detail-section"><h3>Response Body</h3><pre>${esc(fmtBody(r.responseBody))}</pre></div>`;
  }
  if (r.failed) {
    html += `<div class="detail-section"><h3>Error</h3><pre style="color:#e57373">${esc(r.errorText)}</pre></div>`;
  }

  detailContent.innerHTML = html;
}

// === Archives ===
async function loadArchives() {
  const resp = await sendMsg({ action: 'getSessions' });
  if (!resp.ok) return;
  const sessions = resp.sessions;

  if (sessions.length === 0) {
    archiveList.innerHTML = '<div class="empty-state">暂无归档记录</div>';
    return;
  }

  archiveList.innerHTML = sessions.map(s => {
    const dur = s.endTime ? fmtTime(s.endTime - s.startTime) : '进行中';
    const date = new Date(s.startTime).toLocaleString('zh-CN');
    return `<div class="archive-item" data-sid="${s.id}">
      <div class="archive-info">
        <div class="archive-name">${esc(s.name || date)}</div>
        <div class="archive-meta">${s.requestCount} 条请求 | ${dur} | ${date}</div>
      </div>
      <div class="archive-actions">
        <button class="btn btn-secondary btn-sm archive-view" data-sid="${s.id}">查看</button>
        <button class="btn btn-secondary btn-sm archive-export-har" data-sid="${s.id}">HAR</button>
        <button class="btn btn-danger btn-sm archive-delete" data-sid="${s.id}">删除</button>
      </div>
    </div>`;
  }).join('');

  archiveList.querySelectorAll('.archive-view').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      selectedSessionId = btn.dataset.sid;
      // Switch to capture tab and filter by this session
      document.querySelector('.tab[data-tab="capture"]').click();
      await refreshRequests();
    });
  });

  archiveList.querySelectorAll('.archive-export-har').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await exportData('exportHAR', btn.dataset.sid);
    });
  });

  archiveList.querySelectorAll('.archive-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('确定删除该归档？')) return;
      await sendMsg({ action: 'deleteSession', sessionId: btn.dataset.sid });
      loadArchives();
    });
  });
}

// === Event Handlers ===
captureBtn.addEventListener('click', async () => {
  if (capturing) {
    await sendMsg({ action: 'stopCapture' });
    stopAutoRefresh();
  } else {
    if (!currentTabId) return;
    const resp = await sendMsg({ action: 'startCapture', tabId: currentTabId });
    if (!resp.ok) { alert(resp.error || '启动失败'); return; }
    await refreshStatus();
    selectedSessionId = currentSessionId;
    startAutoRefresh();
  }
  await refreshStatus();
  await refreshRequests();
});

exportHarBtn.addEventListener('click', () => {
  exportData('exportHAR', selectedSessionId || undefined);
});

exportJsonBtn.addEventListener('click', () => {
  exportData('exportJSON', selectedSessionId || undefined);
});

clearBtn.addEventListener('click', async () => {
  if (!confirm('确定清空所有抓包数据？')) return;
  await sendMsg({ action: 'clearRequests', sessionId: selectedSessionId || undefined });
  selectedReqId = null;
  detailPanel.classList.remove('visible');
  await refreshRequests();
});

closeDetailBtn.addEventListener('click', () => {
  detailPanel.classList.remove('visible');
  selectedReqId = null;
  requestList.querySelectorAll('.request-item.selected').forEach(el => el.classList.remove('selected'));
});

// Filters
let debounce = null;
searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(refreshRequests, 300);
});
methodFilter.addEventListener('change', refreshRequests);
statusFilter.addEventListener('change', refreshRequests);

// === Auto Refresh ===
function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => { if (capturing) refreshRequests(); }, 2000);
}
function stopAutoRefresh() {
  if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
}

async function exportData(action, sessionId) {
  const resp = await sendMsg({ action, sessionId });
  if (!resp.ok) {
    alert(resp.error || '导出失败');
    return;
  }
  downloadJson(resp.data, resp.ext || 'json');
}

async function downloadJson(data, ext) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  try {
    await chrome.downloads.download({ url, filename: `capture-${ts}.${ext}`, saveAs: true });
  } catch (err) {
    alert(err.message || '下载失败');
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// === Formatters ===
function fmtUrl(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

function fmtSize(bytes) {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function fmtTime(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtHeaders(h) {
  return Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function fmtBody(body) {
  if (!body) return '';
  try { return JSON.stringify(JSON.parse(body), null, 2); } catch { return body; }
}

// === Start ===
init();
