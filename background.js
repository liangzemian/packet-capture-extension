// === State ===
let capturing = false;
let currentTabId = null;
let currentSessionId = null;
let lastSessionId = null;
const pendingRequests = new Map();

// === IndexedDB ===
const DB_NAME = 'PacketCaptureDB';
const DB_VERSION = 1;
const STORE_REQUESTS = 'requests';
const STORE_SESSIONS = 'sessions';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
        const store = db.createObjectStore(STORE_REQUESTS, { keyPath: 'id', autoIncrement: true });
        store.createIndex('sessionId', 'sessionId');
        store.createIndex('url', 'url');
        store.createIndex('method', 'method');
        store.createIndex('status', 'status');
        store.createIndex('timestamp', 'timestamp');
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, data) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbClear(storeName) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetByIndex(storeName, indexName, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const idx = tx.objectStore(storeName).index(indexName);
    const req = idx.getAll(IDBKeyRange.only(value));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// === Session ===
async function createSession(tabId, tabUrl) {
  const session = {
    id: `sess_${Date.now()}`,
    tabId,
    tabUrl,
    startTime: Date.now(),
    endTime: null,
    requestCount: 0,
    name: new Date().toLocaleString('zh-CN')
  };
  await dbPut(STORE_SESSIONS, session);
  currentSessionId = session.id;
  lastSessionId = session.id;
  return session;
}

async function endSession() {
  if (!currentSessionId) return;
  const sessionId = currentSessionId;
  const session = await dbGet(STORE_SESSIONS, currentSessionId);
  if (session) {
    session.endTime = Date.now();
    await dbPut(STORE_SESSIONS, session);
  }
  lastSessionId = sessionId;
  currentSessionId = null;
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

function detachDebugger(tabId) {
  return new Promise((resolve) => {
    if (!tabId) {
      resolve();
      return;
    }
    chrome.debugger.detach({ tabId }, () => resolve());
  });
}

async function setStoredCaptureState(isCapturing, tabId = null, sessionId = null) {
  await chrome.storage.local.set({
    capturing: isCapturing,
    capturingTabId: tabId,
    currentSessionId: sessionId,
    lastSessionId
  });
}

// === Capture ===
async function startCapture(tabId) {
  if (capturing) throw new Error('已在抓包中');
  const tab = await chrome.tabs.get(tabId);
  let session = null;
  let attached = false;
  const previousLastSessionId = lastSessionId;

  try {
    await attachDebugger(tabId);
    attached = true;
    currentTabId = tabId;
    session = await createSession(tabId, tab.url);
    await sendCDPCommand(tabId, 'Network.enable');
    capturing = true;
    await setStoredCaptureState(true, tabId, session.id);
  } catch (err) {
    if (attached) await detachDebugger(tabId);
    if (session) await dbDelete(STORE_SESSIONS, session.id).catch(console.error);
    currentTabId = null;
    currentSessionId = null;
    lastSessionId = previousLastSessionId;
    capturing = false;
    await setStoredCaptureState(false);
    throw err;
  }
}

async function stopCapture() {
  if (!capturing) return;
  const tabId = currentTabId;
  await endSession();
  capturing = false;
  currentTabId = null;
  pendingRequests.clear();
  await setStoredCaptureState(false);
  await detachDebugger(tabId);
}

// === CDP Events ===
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!capturing || source.tabId !== currentTabId) return;
  switch (method) {
    case 'Network.requestWillBeSent': onRequestSent(params); break;
    case 'Network.responseReceived': onResponseReceived(params); break;
    case 'Network.loadingFinished': onLoadingFinished(source.tabId, params); break;
    case 'Network.loadingFailed': onLoadingFailed(params); break;
  }
});

function onRequestSent(params) {
  const { requestId, request, redirectResponse, type, timestamp, wallTime } = params;
  if (redirectResponse && pendingRequests.has(requestId)) {
    persistRedirectRequest(requestId, redirectResponse, timestamp);
  }

  pendingRequests.set(requestId, {
    requestId,
    sessionId: currentSessionId,
    url: request.url,
    method: request.method,
    requestHeaders: request.headers || {},
    requestBody: request.postData || null,
    resourceType: type || 'Other',
    timestamp: wallTime * 1000,
    cdpTimestamp: timestamp,
    status: 0,
    statusText: '',
    responseHeaders: {},
    responseBody: null,
    responseBase64Encoded: false,
    contentType: '',
    size: 0,
    duration: 0,
    failed: false,
    errorText: null
  });
}

function persistRedirectRequest(requestId, response, timestamp) {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  pending.status = response.status || 0;
  pending.statusText = response.statusText || '';
  pending.responseHeaders = response.headers || {};
  pending.contentType = response.mimeType || '';
  pending.size = response.encodedDataLength || pending.size || 0;
  pending.duration = Math.max(0, Math.round((timestamp - pending.cdpTimestamp) * 1000));
  pending.redirectURL = response.url || '';
  persistRequest(pending).catch(console.error);
  pendingRequests.delete(requestId);
}

function onResponseReceived(params) {
  const { requestId, response } = params;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pending.status = response.status || 0;
  pending.statusText = response.statusText || '';
  pending.responseHeaders = response.headers || {};
  pending.contentType = response.mimeType || '';
  pending.size = response.encodedDataLength || 0;
}

async function onLoadingFinished(tabId, params) {
  const { requestId, timestamp, encodedDataLength } = params;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;

  pending.duration = Math.round((timestamp - pending.cdpTimestamp) * 1000);
  pending.size = encodedDataLength || pending.size;

  // Get response body
  try {
    const body = await sendCDPCommand(tabId, 'Network.getResponseBody', { requestId });
    pending.responseBody = body.body;
    pending.responseBase64Encoded = body.base64Encoded || false;
  } catch { /* some resources don't have accessible body */ }

  // Truncate oversized body (500KB)
  if (pending.responseBody && pending.responseBody.length > 500000) {
    pending.responseBody = pending.responseBody.substring(0, 500000) + '\n... [truncated]';
    pending.truncated = true;
  }

  try {
    await persistRequest(pending);
  } catch (e) {
    console.error('Failed to save request:', e);
  }
  pendingRequests.delete(requestId);
}

function onLoadingFailed(params) {
  const { requestId, errorText } = params;
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  pending.failed = true;
  pending.errorText = errorText || 'Unknown error';
  persistRequest(pending).catch(console.error);
  pendingRequests.delete(requestId);
}

async function persistRequest(request) {
  await dbPut(STORE_REQUESTS, request);
  if (!request.sessionId) return;

  const session = await dbGet(STORE_SESSIONS, request.sessionId);
  if (session) {
    session.requestCount = (session.requestCount || 0) + 1;
    await dbPut(STORE_SESSIONS, session);
  }
}

function sendCDPCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// === Tab & Debugger Events ===
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === currentTabId && capturing) {
    stopCapture();
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === currentTabId && capturing) {
    endSession().catch(console.error);
    capturing = false;
    currentTabId = null;
    pendingRequests.clear();
    setStoredCaptureState(false).catch(console.error);
  }
});

// === HAR Export ===
function parseQueryString(url) {
  try {
    const u = new URL(url);
    return Array.from(u.searchParams.entries()).map(([name, value]) => ({ name, value }));
  } catch { return []; }
}

async function buildHAR(sessionId) {
  const requests = sessionId
    ? await dbGetByIndex(STORE_REQUESTS, 'sessionId', sessionId)
    : await dbGetAll(STORE_REQUESTS);

  return {
    log: {
      version: '1.2',
      creator: { name: '抓包归档', version: '1.0.0' },
      entries: requests.map(req => ({
        startedDateTime: new Date(req.timestamp).toISOString(),
        time: req.duration || 0,
        request: {
          method: req.method,
          url: req.url,
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(req.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          queryString: parseQueryString(req.url),
          postData: req.requestBody ? {
            mimeType: req.requestHeaders?.['Content-Type'] || 'application/octet-stream',
            text: req.requestBody
          } : undefined,
          bodySize: req.requestBody ? req.requestBody.length : 0
        },
        response: {
          status: req.status || 0,
          statusText: req.statusText || '',
          httpVersion: 'HTTP/1.1',
          headers: Object.entries(req.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
          content: {
            size: req.size || 0,
            mimeType: req.contentType || 'application/octet-stream',
            text: req.responseBody || '',
            encoding: req.responseBase64Encoded ? 'base64' : undefined
          },
          redirectURL: req.redirectURL || '',
          headersSize: -1,
          bodySize: req.size || 0
        },
        cache: {},
        timings: { send: 0, wait: req.duration || 0, receive: 0 }
      }))
    }
  };
}

// === Message Handler ===
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch(err => sendResponse({ ok: false, error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.action) {
    case 'startCapture':
      await startCapture(msg.tabId);
      return { ok: true };

    case 'stopCapture':
      await stopCapture();
      return { ok: true };

    case 'getStatus':
      return {
        capturing,
        tabId: currentTabId,
        sessionId: currentSessionId,
        lastSessionId,
        pendingCount: pendingRequests.size
      };

    case 'getRequests': {
      let requests = msg.sessionId
        ? await dbGetByIndex(STORE_REQUESTS, 'sessionId', msg.sessionId)
        : await dbGetAll(STORE_REQUESTS);
      const f = msg.filters || {};
      if (f.method) requests = requests.filter(r => r.method === f.method);
      if (f.status) requests = requests.filter(r => String(r.status).startsWith(String(f.status)));
      if (f.search) {
        const s = f.search.toLowerCase();
        requests = requests.filter(r => r.url.toLowerCase().includes(s));
      }
      if (f.domain) {
        requests = requests.filter(r => {
          try { return new URL(r.url).hostname.includes(f.domain); } catch { return false; }
        });
      }
      return { ok: true, requests };
    }

    case 'getRequestDetail': {
      const req = await dbGet(STORE_REQUESTS, msg.id);
      return { ok: true, request: req };
    }

    case 'getSessions': {
      const sessions = await dbGetAll(STORE_SESSIONS);
      return { ok: true, sessions: sessions.reverse() };
    }

    case 'exportHAR': {
      const har = await buildHAR(msg.sessionId);
      return { ok: true, data: har, ext: 'har' };
    }

    case 'exportJSON': {
      const requests = msg.sessionId
        ? await dbGetByIndex(STORE_REQUESTS, 'sessionId', msg.sessionId)
        : await dbGetAll(STORE_REQUESTS);
      return { ok: true, data: requests, ext: 'json' };
    }

    case 'clearRequests': {
      if (msg.sessionId) {
        const db = await openDB();
        const tx = db.transaction(STORE_REQUESTS, 'readwrite');
        const idx = tx.objectStore(STORE_REQUESTS).index('sessionId');
        const cursor = idx.openCursor(IDBKeyRange.only(msg.sessionId));
        cursor.onsuccess = (e) => {
          const c = e.target.result;
          if (c) { c.delete(); c.continue(); }
        };
        await new Promise(r => { tx.oncomplete = r; });
      } else {
        await dbClear(STORE_REQUESTS);
      }
      return { ok: true };
    }

    case 'deleteSession': {
      // Delete all requests in this session
      const db = await openDB();
      const tx = db.transaction(STORE_REQUESTS, 'readwrite');
      const idx = tx.objectStore(STORE_REQUESTS).index('sessionId');
      const cursor = idx.openCursor(IDBKeyRange.only(msg.sessionId));
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { c.delete(); c.continue(); }
      };
      await new Promise(r => { tx.oncomplete = r; });
      // Delete session itself
      await dbDelete(STORE_SESSIONS, msg.sessionId);
      return { ok: true };
    }

    default:
      return { ok: false, error: 'Unknown action' };
  }
}

// === Keep alive during capture ===
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive' && capturing) {
    chrome.storage.local.get('capturing');
  }
});

// === Restore state on SW restart ===
chrome.storage.local.get(['capturing', 'capturingTabId', 'currentSessionId', 'lastSessionId'], (data) => {
  lastSessionId = data.lastSessionId || data.currentSessionId || null;
  if (data.capturing && data.capturingTabId) {
    currentTabId = data.capturingTabId;
    currentSessionId = data.currentSessionId || null;
    chrome.debugger.attach({ tabId: data.capturingTabId }, '1.3', () => {
      if (chrome.runtime.lastError) {
        // Tab gone or already detached
        endSession();
        setStoredCaptureState(false);
        return;
      }
      chrome.debugger.sendCommand({ tabId: data.capturingTabId }, 'Network.enable', null, () => {
        if (chrome.runtime.lastError) {
          endSession();
          setStoredCaptureState(false);
          return;
        }
        capturing = true;
      });
    });
  }
});
