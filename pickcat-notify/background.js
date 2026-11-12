/* Pickcat 消息通知助手：后台定时检查未读数，网页关掉后照样弹通知 */

const BASE = 'https://pickcat.dao3.fun';
const API_SUMMARY = BASE + '/api/v1/notification-summary';
const API_LIST = BASE + '/api/v1/notifications?limit=5';
const ICON_PATH = 'icons/icon128.png';

const DEFAULTS = {
  enabled: true,
  mode: 'smart',
  intervalMin: 1,
  notify: true,
  badge: true,
  sound: true,
  openNotify: true,
  dndEnabled: false,
  dndStart: '22:30',
  dndEnd: '07:00'
};

const EMPTY_STATE = {
  unread: 0,
  lastCount: 0,
  lastCheck: 0,
  via: '',
  error: '',
  loggedOut: false,
  recent: []
};

/* ---------- 存储 ---------- */

async function cfg() {
  const got = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULTS, got.settings || {});
}

async function st() {
  const got = await chrome.storage.local.get('state');
  return Object.assign({}, EMPTY_STATE, got.state || {});
}

async function saveSt(patch) {
  const cur = await st();
  const next = Object.assign({}, cur, patch);
  await chrome.storage.local.set({ state: next });
  return next;
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function clampMin(v) {
  var n = Number(v) || 1;
  if (n < 1) n = 1;
  if (n > 30) n = 30;
  return n;
}

/* ---------- 闹钟 ---------- */

async function ensureAlarm() {
  const c = await cfg();
  await chrome.alarms.clear('pickcat-tick');
  if (!c.enabled) return;
  const m = clampMin(c.intervalMin);
  await chrome.alarms.create('pickcat-tick', {
    periodInMinutes: m,
    delayInMinutes: m
  });
}

async function alarmInfo() {
  const a = await chrome.alarms.get('pickcat-tick');
  if (!a) return null;
  return { when: a.scheduledTime, period: a.periodInMinutes };
}

/* ---------- 读未读数 ---------- */

async function directFetch(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    cache: 'no-store'
  });
  if (!res.ok) return { ok: false, status: res.status };
  let json = null;
  try { json = await res.json(); } catch (e) { return { ok: false, status: res.status, bad: true }; }
  return { ok: true, data: json };
}

function describeError(status, fallback) {
  if (status === 401 || status === 403) return '未登录（先在浏览器里登录 Pickcat）';
  if (status === 429) return '请求太频繁，被站点限流了';
  if (status === 0) return '网络不通';
  return fallback || '读取失败';
}

async function getHelperTab() {
  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  const live = tabs.filter(function (t) { return t.id != null; });
  if (!live.length) return null;
  const stored = await chrome.storage.local.get(['helperWindowId', 'helperTabId']);
  const winId = stored.helperWindowId;
  const tabIdSaved = stored.helperTabId;
  if (tabIdSaved != null) {
    const hitTab = live.find(function (t) { return t.id === tabIdSaved; });
    if (hitTab) return hitTab.id;
  }
  if (winId != null) {
    const hit = live.find(function (t) { return t.windowId === winId; });
    if (hit) return hit.id;
  }
  return live[0].id;
}

async function createHelperWindow() {
  let lastErr = '';

  // 1) 首选：把页面放进一个不抢焦点的后台标签页（不额外弹窗口，最不打扰）
  try {
    const tab = await chrome.tabs.create({ url: BASE + '/', active: false });
    await chrome.storage.local.set({ helperWindowId: null, helperTabId: tab.id });
    return tab.id;
  } catch (e) {
    lastErr = (e && e.message) || String(e);
  }

  // 2) 再试：独立小弹窗（不指定坐标，Chrome 会拒绝屏幕外坐标）
  try {
    const win = await chrome.windows.create({ url: BASE + '/', type: 'popup', width: 380, height: 300, focused: false });
    await chrome.storage.local.set({ helperWindowId: win && win.id != null ? win.id : null, helperTabId: null });
    if (win && win.tabs && win.tabs[0] && win.tabs[0].id != null) return win.tabs[0].id;
    return null;
  } catch (e) {
    lastErr = lastErr + ' / ' + ((e && e.message) || String(e));
  }

  // 3) 最后：普通窗口
  try {
    const win = await chrome.windows.create({ url: BASE + '/', focused: false });
    await chrome.storage.local.set({ helperWindowId: win && win.id != null ? win.id : null, helperTabId: null });
    if (win && win.tabs && win.tabs[0] && win.tabs[0].id != null) return win.tabs[0].id;
    return null;
  } catch (e) {
    lastErr = lastErr + ' / ' + ((e && e.message) || String(e));
  }

  throw new Error('不能打开后台页面：' + lastErr);
}

async function ensureHelperTab() {
  const tabId = await getHelperTab();
  if (tabId != null) return tabId;
  return await createHelperWindow();
}

async function sendToTab(tabId, msg) {
  if (tabId == null) return null;
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, msg);
      if (resp) return resp;
    } catch (e) {
      /* 页面脚本还没就绪 */
    }
    await sleep(800);
  }
  return null;
}

async function readByHelper() {
  let tabId = await ensureHelperTab();
  if (tabId == null) throw new Error('不能打开后台窗口');
  let resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  if (!resp) {
    tabId = await createHelperWindow();
    resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  }
  if (!resp) throw new Error('后台窗口没响应（页面可能没加载出来）');
  if (!resp.ok) throw new Error(describeError(resp.status, resp.error));
  return { count: Number(resp.count) || 0, items: resp.items || [], via: 'window' };
}

async function readUnread() {
  const c = await cfg();
  let directStatus = 0;

  if (c.mode !== 'window') {
    const d = await directFetch(API_SUMMARY).catch(function () {
      return { ok: false, status: 0 };
    });
    if (d.ok) {
      const list = await directFetch(API_LIST).catch(function () { return { ok: false }; });
      const items = (list.ok && list.data && (list.data.items || (list.data.data && list.data.data.items))) || [];
      return { count: Number(d.data && d.data.unreadCount) || 0, items: items, via: 'direct' };
    }
    directStatus = d.status;
    if (c.mode === 'direct') throw new Error(describeError(d.status));
  }

  const byHelper = await readByHelper();
  if (directStatus && !byHelper.count) byHelper.hint = describeError(directStatus);
  return byHelper;
}

/* ---------- 通知 ---------- */

const TYPE_ACTION = {
  USER_MENTIONED: '在帖子里 @了你',
  USER_FOLLOWED: '关注了你',
  COMMENT_REPLY: '回复了你的评论',
  POST_REPLY: '回复了你的帖子',
  TOPIC_EVENT: '你关注的帖子有新动态',
  MANAGEMENT_ACTION: '给你发了一条管理通知',
  LIKE: '赞了你',
  LIKE_MILESTONE: '你的内容又收到了新的赞',
  LEVEL_CERTIFICATION: '等级认证出结果了',
  TAKEDOWN_APPEAL_DECIDED: '下架申诉有结果了'
};

function firstOf(obj, keys) {
  if (!obj) return '';
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v != null && v !== '') return v;
  }
  return '';
}

function flat(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

/* 把站点返回的一条通知，整理成「谁 + 干了什么 + 涉及什么内容」 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const d = it.details || {};
  const actorObj = d.actor || d.user || {};
  const actor = firstOf(actorObj, ['nickname', 'displayName', 'name', 'username']);
  const avatar = firstOf(actorObj, ['avatarUrl', 'avatar', 'avatar_url', 'avatarPath']);
  const action = TYPE_ACTION[it.type] || '有新动态';
  let excerpt = firstOf(d, ['excerpt', 'content', 'title', 'text']);
  if (!excerpt && d.comment) excerpt = firstOf(d.comment, ['excerpt', 'content']);
  if (!excerpt && d.post) excerpt = firstOf(d.post, ['title', 'excerpt', 'content']);
  if (!excerpt && d.topic) excerpt = firstOf(d.topic, ['title']);
  if (!excerpt && d.body) excerpt = firstOf(d.body, ['title', 'excerpt']);
  const isRead = !(it.readAt === null || typeof it.readAt === 'undefined');
  const ts = Number(firstOf(it, ['createdAt', 'created_at', 'time']) ) || 0;
  return { type: it.type || '', actor: flat(actor, 24), avatar: String(avatar || ''),
           action: action, excerpt: flat(excerpt, 60), read: isRead, ts: ts };
}

function arrangeItems(items) {
  if (!Array.isArray(items)) return [];
  const list = items.map(normalizeItem).filter(Boolean);
  const unread = list.filter(function (i) { return !i.read; });
  const read = list.filter(function (i) { return i.read; });
  unread.sort(function (a, b) { return b.ts - a.ts; });
  read.sort(function (a, b) { return b.ts - a.ts; });
  return unread.concat(read);
}

/* 通知标题与正文：尽量写清是谁、做了什么 */
function noteText(count, items, delta) {
  const list = arrangeItems(items);
  const unread = list.filter(function (i) { return !i.read; });
  const use = (unread.length ? unread : list).slice(0, 3);

  let title = 'Pickcat 有新消息';
  let message = '';

  if (use.length === 1) {
    const one = use[0];
    title = (one.actor ? one.actor + ' ' : '') + one.action;
    message = one.excerpt || ('你现在有 ' + count + ' 条未读');
  } else if (use.length > 1) {
    title = 'Pickcat · ' + count + ' 条新消息';
    message = use.map(function (i) {
      return '· ' + (i.actor ? i.actor + ' ' : '') + i.action + (i.excerpt ? '：' + i.excerpt : '');
    }).join('\n');
    if (count > use.length) message += '\n· 还有 ' + (count - use.length) + ' 条…';
  } else {
    message = '你现在有 ' + count + ' 条未读';
  }

  return { title: title, message: message };
}

/* 弹窗里显示的最近三条 */
function recentFor(items) {
  return arrangeItems(items).slice(0, 3).map(function (i) {
    return { actor: i.actor, avatar: i.avatar, action: i.action, excerpt: i.excerpt };
  });
}

function inDnd(c) {
  if (!c.dndEnabled) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const toMin = function (s) {
    const p = String(s || '').split(':');
    const h = Number(p[0]);
    const m = Number(p[1]);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  };
  const a = toMin(c.dndStart);
  const b = toMin(c.dndEnd);
  if (a == null || b == null || a === b) return false;
  if (a < b) return cur >= a && cur < b;
  return cur >= a || cur < b;
}

async function showNote(count, items, delta) {
  const c = await cfg();
  const text = noteText(count, items, delta);

  chrome.notifications.create('pickcat-' + Date.now(), {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    title: text.title,
    message: text.message,
    contextMessage: 'Pickcat 通知助手',
    silent: !c.sound,
    priority: 2
  });
}

const ICONS_ON = { '16': 'icons/icon16.png', '32': 'icons/icon32.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' };
const ICONS_IDLE = { '16': 'icons/idle16.png', '32': 'icons/idle32.png', '48': 'icons/idle48.png', '128': 'icons/idle128.png' };

async function updateBadge(count, c) {
  const has = count > 0;
  try {
    await chrome.action.setIcon({ path: has ? ICONS_ON : ICONS_IDLE });
  } catch (e) { /* 图标缺失时忽略 */ }

  if (!c.badge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#C8362C' });
  await chrome.action.setBadgeText({ text: has ? (count > 99 ? '99+' : String(count)) : '' });
}

/* ---------- 主流程 ---------- */

async function poll() {
  const c = await cfg();

  if (!c.enabled) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setIcon({ path: ICONS_IDLE }).catch(function () {});
    return { skipped: true };
  }

  try {
    const res = await readUnread();
    const prev = await st();
    const prevCount = Number(prev.lastCount) || 0;

    await saveSt({
      unread: res.count,
      lastCount: res.count,
      lastCheck: Date.now(),
      via: res.via,
      error: '',
      loggedOut: false,
      recent: recentFor(res.items)
    });

    await updateBadge(res.count, c);

    if (c.notify && res.count > 0 && res.count > prevCount && !inDnd(c)) {
      await showNote(res.count, res.items, res.count - prevCount);
    }
    return { ok: true, count: res.count, via: res.via };
  } catch (e) {
    const msg = String((e && e.message) || e);
    await saveSt({
      lastCheck: Date.now(),
      error: msg,
      loggedOut: /未登录/.test(msg)
    });
    return { ok: false, error: msg };
  }
}

/* ---------- 事件 ---------- */

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'pickcat-tick') poll();
});

chrome.runtime.onInstalled.addListener(async function (details) {
  const got = await chrome.storage.local.get(['settings', 'welcomeShown']);
  if (!got.settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await ensureAlarm();
  poll();

  if (!got.welcomeShown) {
    await chrome.storage.local.set({ welcomeShown: true });
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL('welcome.html'),
        type: 'popup',
        width: 760,
        height: 620,
        focused: true
      });
    } catch (e) {
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    }
    chrome.notifications.create('pickcat-welcome-once', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL(ICON_PATH),
      title: 'Pickcat 通知已开启',
      message: '这是一次性测试通知。以后只在新消息到来时提醒你。',
      priority: 2
    });
  }
});

chrome.runtime.onStartup.addListener(async function () {
  await ensureAlarm();
  poll();
});

chrome.notifications.onClicked.addListener(async function (id) {
  if (id === 'pickcat-welcome-once') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    return;
  }
  const c = await cfg();
  chrome.tabs.create({ url: c.openNotify ? BASE + '/notifications' : BASE + '/' });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'PC_CHECK_NOW') {
    poll().then(async function (r) {
      sendResponse({ result: r, state: await st() });
    });
    return true;
  }

  if (msg.type === 'PC_SAVE') {
    (async function () {
      const cur = await cfg();
      const next = Object.assign({}, cur, msg.patch || {});
      if (msg.patch && msg.patch.intervalMin != null) next.intervalMin = clampMin(msg.patch.intervalMin);
      await chrome.storage.local.set({ settings: next });
      await ensureAlarm();
      await updateBadge((await st()).unread || 0, next);
      if (next.enabled) poll();
      sendResponse({ settings: next, state: await st() });
    })();
    return true;
  }

  if (msg.type === 'PC_TEST') {
    (async function () {
      const c = await cfg();
      chrome.notifications.create('pickcat-test-' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL(ICON_PATH),
        title: '测试通知 · 羽Yu 赞了你',
        message: '被赞的那条帖子标题会显示在这里\n真实通知只在有新动静时才出现。',
        contextMessage: '这是测试，不是真消息',
        silent: !c.sound,
        priority: 2
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PC_OPEN') {
    chrome.tabs.create({ url: BASE + '/' });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_WELCOME') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_CLOSE_HELPER') {
    (async function () {
      const got = await chrome.storage.local.get(['helperWindowId', 'helperTabId']);
      if (got.helperWindowId != null) {
        try { await chrome.windows.remove(got.helperWindowId); } catch (e) { /* 已关闭 */ }
      }
      if (got.helperTabId != null) {
        try { await chrome.tabs.remove(got.helperTabId); } catch (e) { /* 已关闭 */ }
      }
      await chrome.storage.local.set({ helperWindowId: null, helperTabId: null });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PC_DIAG') {
    (async function () {
      const gotHelper = await chrome.storage.local.get(['helperWindowId', 'helperTabId']);
      sendResponse({
        settings: await cfg(),
        state: await st(),
        alarm: await alarmInfo(),
        helper: gotHelper.helperWindowId || null,
        helperTab: gotHelper.helperTabId || null
      });
    })();
    return true;
  }

  if (msg.type === 'PC_CLOSED_PAGE_TEST') {
    (async function () {
      const tabs = await chrome.tabs.query({ url: BASE + '/*' });
      let closed = 0;
      for (const t of tabs) {
        if (t.id != null) {
          try { await chrome.tabs.remove(t.id); closed++; } catch (e) { /* 忽略 */ }
        }
      }
      await sleep(1800);
      const r = await poll();
      sendResponse({ result: r, state: await st(), closed: closed });
    })();
    return true;
  }

  if (msg.type === 'PC_STATE') {
    (async function () {
      sendResponse({ settings: await cfg(), state: await st() });
    })();
    return true;
  }

  return false;
});
