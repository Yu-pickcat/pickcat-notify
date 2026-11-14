/* Pickcat 消息通知助手：后台定时检查未读数，网页关掉后照样弹通知 */

const BASE = 'https://pickcat.dao3.fun';
const API_SUMMARY = BASE + '/api/v1/notification-summary';
const API_LIST = BASE + '/api/v1/notifications?limit=5';
const ICON_PATH = 'icons/icon128.png';

const DEFAULTS = {
  enabled: true,
  mode: 'smart',
  chain: ['page', 'direct', 'window'],
  intervalMin: 1,
  notify: true,
  notifyTypes: { mention: true, reply: true, like: true, system: true },
  notifyMax: 3,
  badge: true,
  sound: true,
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
  if (n < 0.5) n = 0.5;
  if (n > 60) n = 60;
  return n;
}

/* ---------- 闹钟 ---------- */

async function ensureAlarm() {
  const c = await cfg();
  await chrome.alarms.clear('pickcat-tick');
  if (!c.enabled) return;
  const m = clampMin(c.intervalMin);
  try {
    await chrome.alarms.create('pickcat-tick', {
      periodInMinutes: m,
      delayInMinutes: m
    });
  } catch (e) {
    /* 老浏览器不认 30 秒，退回 1 分钟 */
    await chrome.alarms.create('pickcat-tick', { periodInMinutes: 1, delayInMinutes: 1 });
  }
}

async function alarmInfo() {
  const a = await chrome.alarms.get('pickcat-tick');
  if (!a) return null;
  const c = await cfg();
  return { when: a.scheduledTime, period: a.periodInMinutes, want: clampMin(c.intervalMin) };
}

/* 30 秒这种比 1 分钟还快的间隔，alarms 在老浏览器会被压成 1 分钟，
   所以再挂一条 setTimeout 链；浏览器把 service worker 挂起时靠 alarms 兜着 */
let ticker = null;

async function startTicker() {
  if (ticker) {
    clearTimeout(ticker);
    ticker = null;
  }
  const c = await cfg();
  if (!c.enabled) return;
  const ms = clampMin(c.intervalMin) * 60000;
  if (ms >= 60000) return;
  ticker = setTimeout(async function () {
    try { await poll(); } catch (e) { /* 忽略 */ }
    startTicker();
  }, ms);
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

/* 找「已经开着」的 Pickcat 页面。你自己开着的页面优先用，绝不新建 */
async function findOpenPickcatTab() {
  const tabs = await chrome.tabs.query({ url: BASE + '/*' });
  const live = tabs.filter(function (t) { return t.id != null && !t.incognito; });
  if (!live.length) return null;
  const stored = await chrome.storage.local.get(['helperWindowId', 'helperTabId']);
  if (stored.helperTabId != null) {
    const hitTab = live.find(function (t) { return t.id === stored.helperTabId; });
    if (hitTab) return hitTab.id;
  }
  if (stored.helperWindowId != null) {
    const hit = live.find(function (t) { return t.windowId === stored.helperWindowId; });
    if (hit) return hit.id;
  }
  return live[0].id;
}

/* 关掉兜底后台页（窗口 + 标签），清掉记录；找不到也不报错。
   兜底页重建前先调它，避免旧的没响应的隐藏窗口/标签一直堆积 */
async function closeHelper() {
  const got = await chrome.storage.local.get(['helperWindowId', 'helperTabId']);
  if (got.helperWindowId != null) {
    try { await chrome.windows.remove(got.helperWindowId); } catch (e) { /* 已关闭 */ }
  }
  if (got.helperTabId != null) {
    try { await chrome.tabs.remove(got.helperTabId); } catch (e) { /* 已关闭 */ }
  }
  await chrome.storage.local.set({ helperWindowId: null, helperTabId: null });
}

async function waitTabLoaded(tabId, timeout) {
  const until = Date.now() + (timeout || 12000);
  while (Date.now() < until) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t && t.status === 'complete') return true;
    } catch (e) { return false; }
    await sleep(600);
  }
  return false;
}

/* 直连也读不到时才用的兜底：开一个最小化的独立小窗（不进标签栏、不抢焦点），之后一直复用 */
async function createHiddenPage() {
  /* 先清掉上一次没响应的兜底页，避免隐藏窗口/标签堆积占内存 */
  await closeHelper();
  let lastErr = '';
  try {
    const win = await chrome.windows.create({ url: BASE + '/', type: 'popup', width: 420, height: 320, focused: false });
    if (win && win.tabs && win.tabs[0] && win.tabs[0].id != null) {
      const tabId = win.tabs[0].id;
      await chrome.storage.local.set({ helperWindowId: win.id != null ? win.id : null, helperTabId: tabId });
      await waitTabLoaded(tabId, 12000);
      /* 页面加载期间浏览器会把最小化还原，加载完再收起来，连压三次防它回弹 */
      for (let i = 0; i < 3; i++) {
        if (win.id != null) {
          try { await chrome.windows.update(win.id, { state: 'minimized', focused: false }); } catch (e) { /* 忽略 */ }
        }
        await sleep(600);
      }
      return tabId;
    }
    lastErr = '窗口没建出来';
  } catch (e) {
    lastErr = (e && e.message) || String(e);
  }
  /* 老浏览器建不出独立小窗时，退一步用不抢焦点的后台标签页 */
  try {
    const tab = await chrome.tabs.create({ url: BASE + '/', active: false });
    await chrome.storage.local.set({ helperWindowId: null, helperTabId: tab.id });
    await waitTabLoaded(tab.id, 12000);
    return tab.id;
  } catch (e2) {
    lastErr = lastErr + ' / ' + ((e2 && e2.message) || String(e2));
  }
  throw new Error('打不开后台页面：' + lastErr);
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

async function readFromTab(tabId, via) {
  const resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  if (!resp) throw new Error('这个页面没响应（可能还没加载完）');
  if (!resp.ok) throw new Error(describeError(resp.status, resp.error));
  return { count: Number(resp.count) || 0, items: resp.items || [], via: via };
}

async function readByHelper() {
  let tabId = await findOpenPickcatTab();
  if (tabId == null) tabId = await createHiddenPage();
  let resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  if (!resp) {
    /* 旧兜底页没响应：先关掉它再重建，不叠第二个隐藏页 */
    await closeHelper();
    tabId = await createHiddenPage();
    resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  }
  if (!resp) throw new Error('后台页面没响应（页面可能没加载出来）');
  if (!resp.ok) throw new Error(describeError(resp.status, resp.error));
  return { count: Number(resp.count) || 0, items: resp.items || [], via: 'window' };
}

async function readDirect() {
  const d = await directFetch(API_SUMMARY).catch(function () {
    return { ok: false, status: 0 };
  });
  if (!d.ok) throw new Error(describeError(d.status));
  const list = await directFetch(API_LIST).catch(function () { return { ok: false }; });
  const items = (list.ok && list.data && (list.data.items || (list.data.data && list.data.data.items))) || [];
  return { count: Number(d.data && d.data.unreadCount) || 0, items: items, via: 'direct' };
}

/* 读取顺序：
   智能 = 已开着的 Pickcat 页面 → 直连（什么都不开）→ 兜底后台页（最小化小窗）→ 还不行就报错
   自定义 = 按你勾选的顺序依次试，全勾上就等于智能
   只读已开页面 = 只读你自己开的那个页面，一个都不新建
   只直连 = 一个页面都不开
   后台页 = 直接用（或第一次建一个）最小化后台页 */
function modeChain(c) {
  const all = ['page', 'direct', 'window'];
  if (c && c.mode === 'custom' && Array.isArray(c.chain)) {
    const picked = c.chain.filter(function (s) { return all.indexOf(s) >= 0; });
    if (picked.length === 3) return all;
    if (picked.length) return picked;
  }
  if (c && c.mode === 'page') return ['page'];
  if (c && c.mode === 'direct') return ['direct'];
  if (c && c.mode === 'window') return ['window'];
  return all;
}

async function readUnread() {
  const c = await cfg();
  const chain = modeChain(c);
  let lastErr = null;

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    if (step === 'page') {
      const tabId = await findOpenPickcatTab();
      if (tabId == null) {
        lastErr = new Error('没开 Pickcat 页面（这个方式只读你已经打开的页面）');
        continue;
      }
      try {
        return await readFromTab(tabId, 'page');
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    if (step === 'direct') {
      try {
        return await readDirect();
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
    if (step === 'window') {
      try {
        return await readByHelper();
      } catch (e) {
        lastErr = e;
        continue;
      }
    }
  }

  throw lastErr || new Error('读取失败');
}

/* ---------- 通知 ---------- */

/* 四类提醒开关，和站点自己的四个分类一一对应 */
const TYPE_CATEGORY = {
  mention: ['USER_MENTIONED', 'WORK_COMMENT_MENTIONED'],
  reply: ['REPLY_CREATED', 'WORK_COMMENT_CREATED', 'WORK_COMMENT_REPLY_CREATED'],
  like: ['POST_LIKED', 'WORK_LIKED', 'WORK_COMMENT_LIKED'],
  system: ['MANAGEMENT_ACTION', 'TOPIC_EVENT', 'LEVEL_CERTIFICATION', 'USER_FOLLOWED', 'TAKEDOWN_APPEAL_DECIDED', 'QUESTION_DUPLICATE_REQUEST_DECIDED']
};

function categoryOf(type) {
  for (const key in TYPE_CATEGORY) {
    if (TYPE_CATEGORY[key].indexOf(type) >= 0) return key;
  }
  return 'system';
}

/* 只留下用户开着的那几类；全关了就等于不弹 */
function filterByTypes(items, types) {
  const on = Object.assign({ mention: true, reply: true, like: true, system: true }, types || {});
  if (!Array.isArray(items)) return [];
  return items.filter(function (it) {
    if (!it || typeof it !== 'object') return false;
    return on[categoryOf(it.type)] !== false;
  });
}

const TYPE_ACTION = {
  USER_MENTIONED: '在帖子里 @了你',
  WORK_COMMENT_MENTIONED: '在作品评论里 @了你',
  REPLY_CREATED: '回复了你的帖子',
  WORK_COMMENT_CREATED: '评论了你的作品',
  WORK_COMMENT_REPLY_CREATED: '回复了你在作品下的评论',
  POST_LIKED: '赞了你的帖子',
  WORK_LIKED: '赞了你的作品',
  WORK_COMMENT_LIKED: '赞了你的评论',
  USER_FOLLOWED: '关注了你',
  TOPIC_EVENT: '你关注的帖子有新动态',
  MANAGEMENT_ACTION: '给你发了管理通知',
  LEVEL_CERTIFICATION: '等级认证出结果了',
  TAKEDOWN_APPEAL_DECIDED: '下架申诉有结果了',
  QUESTION_DUPLICATE_REQUEST_DECIDED: '题目重复提交有结果了'
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

/* 头像地址：站点给的是相对路径（/api/v1/avatars/...），这里拼成完整地址；
   兼容头像字段直接是字符串，或嵌套成 { url } 对象这两种形态 */
function resolveAvatar(raw) {
  if (!raw) return '';
  if (typeof raw === 'object') {
    raw = raw.url || raw.src || raw.path || raw.link || '';
  }
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf('//') === 0) return 'https:' + s;
  if (s.charAt(0) === '/') return BASE + s;
  return BASE + '/' + s;
}

/* 时间：站点给的是 ISO 字符串（2026-11-14T06:29:24.132Z），转成时间戳 */
function parseTs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  const n = Date.parse(String(v));
  return isNaN(n) ? 0 : n;
}

/* 把站点返回的一条通知，整理成「谁 + 干了什么 + 涉及什么内容」 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const d = it.details || {};
  const actorObj = d.actor || d.user || d.from || d.sender || {};
  const actor = firstOf(actorObj, ['username', 'nickname', 'displayName', 'name']);

  let avatarRaw = actorObj.avatar;
  if (!avatarRaw) avatarRaw = firstOf(actorObj, ['avatarUrl', 'avatar_url', 'avatarPath', 'src']);
  const avatar = resolveAvatar(avatarRaw);

  const topicObj = d.topic || {};
  const postObj = d.post || {};
  const commentObj = d.comment || {};

  let excerpt = firstOf(d, ['excerpt', 'content', 'title', 'text', 'body']);
  if (!excerpt && commentObj) excerpt = firstOf(commentObj, ['excerpt', 'content', 'body']);
  if (!excerpt && topicObj) excerpt = firstOf(topicObj, ['title', 'excerpt', 'content']);
  if (!excerpt && postObj) excerpt = firstOf(postObj, ['title', 'excerpt', 'content']);

  const topicTitle = flat(firstOf(topicObj, ['title']), 60);
  const floor = Number(postObj.postNumber) || 0;
  const postId = postObj.id || '';
  const topicId = topicObj.id || '';
  const actorId = actorObj.id || '';

  const action = TYPE_ACTION[it.type] || '有新消息';
  const category = categoryOf(it.type);
  const isRead = !(it.readAt === null || typeof it.readAt === 'undefined');
  const ts = parseTs(firstOf(it, ['createdAt', 'created_at', 'time']));

  return {
    type: it.type || '',
    category: category,
    actor: flat(actor, 24),
    actorId: actorId,
    avatar: avatar,
    action: action,
    excerpt: flat(excerpt, 60),
    topicTitle: topicTitle,
    floor: floor,
    postId: postId,
    topicId: topicId,
    read: isRead,
    ts: ts
  };
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

function topicLine(i) {
  let s = '';
  if (i.topicTitle) s = '《' + i.topicTitle + '》';
  else if (i.excerpt) s = i.excerpt;
  if (i.floor) s += ' · 第 ' + i.floor + ' 楼';
  return s;
}

/* 通知文案：固定写成「谁 + 做了什么 + 涉及什么内容」，不说空话 */
function noteText(count, items, delta, max) {
  const list = arrangeItems(items);
  const unread = list.filter(function (i) { return !i.read; });
  const use = (unread.length ? unread : list).slice(0, Math.max(1, Number(max) || 3));

  if (!use.length) {
    return { title: 'Pickcat 有新消息', message: '你现在有 ' + count + ' 条未读' };
  }

  if (use.length === 1) {
    const one = use[0];
    const who = one.actor || '有人';
    const title = who + ' ' + one.action;
    const topic = topicLine(one);
    const message = topic
      ? topic
      : (count > 1 ? '你现在有 ' + count + ' 条未读，点开消息中心看详情' : '点开消息中心看详情');
    return { title: title, message: message };
  }

  let message = use.map(function (i) {
    const who = i.actor || '有人';
    const topic = topicLine(i);
    return '· ' + who + ' ' + i.action + (topic ? '：' + topic : '');
  }).join('\n');
  if (count > use.length) message += '\n· 还有 ' + (count - use.length) + ' 条';

  return { title: 'Pickcat · ' + count + ' 条新消息', message: message };
}

/* 弹窗里显示的最近动态，条数跟随「通知里最多列几条」设置（1～5） */
function recentFor(items, max) {
  const n = Math.max(1, Math.min(5, Number(max) || 3));
  return arrangeItems(items).slice(0, n).map(function (i) {
    return {
      actor: i.actor,
      actorId: i.actorId,
      avatar: i.avatar,
      action: i.action,
      category: i.category,
      excerpt: i.excerpt,
      topicTitle: i.topicTitle,
      floor: i.floor,
      ts: i.ts,
      postId: i.postId,
      topicId: i.topicId
    };
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

/* 通知数量封顶：老浏览器里通知堆多了也占资源，只留最近 5 条 */
async function capNotifications() {
  try {
    const all = await chrome.notifications.getAll();
    const ids = Object.keys(all || {}).filter(function (id) { return id.indexOf('pickcat-') === 0; });
    while (ids.length > 5) {
      const old = ids.shift();
      try { await chrome.notifications.clear(old); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 不支持 getAll 时忽略 */ }
}

async function showNote(count, items, delta) {
  const c = await cfg();
  const text = noteText(count, items, delta, c.notifyMax);

  /* 只有一条时，通知图标用发送者头像（站点头像匿名可访问）；多条或没头像就回退扩展图标 */
  const list = arrangeItems(items);
  const unread = list.filter(function (i) { return !i.read; });
  const use = (unread.length ? unread : list).slice(0, Math.max(1, Number(c.notifyMax) || 3));
  let iconUrl = chrome.runtime.getURL(ICON_PATH);
  if (use.length === 1 && use[0].avatar && /^https?:\/\//i.test(use[0].avatar)) {
    iconUrl = use[0].avatar;
  }

  await capNotifications();
  chrome.notifications.create('pickcat-' + Date.now(), {
    type: 'basic',
    iconUrl: iconUrl,
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

/* 并发锁：闹钟、计时器、手动检查可能撞在一起，上一轮还没读完就跳过，避免叠加兜底页 */
let pollRunning = false;

async function poll() {
  if (pollRunning) return { skipped: true, reason: 'already running' };
  pollRunning = true;
  try {
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
        recent: recentFor(res.items, c.notifyMax)
      });

      await updateBadge(res.count, c);

      if (c.notify && res.count > 0 && res.count > prevCount && !inDnd(c)) {
        const picked = filterByTypes(res.items, c.notifyTypes);
        if (picked.length) await showNote(res.count, picked, res.count - prevCount);
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
  } finally {
    pollRunning = false;
  }
}

/* ---------- 事件 ---------- */

chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name === 'pickcat-tick') {
    poll();
    startTicker();
  }
});

chrome.runtime.onInstalled.addListener(async function (details) {
  const got = await chrome.storage.local.get(['settings', 'welcomeShown']);
  if (!got.settings) await chrome.storage.local.set({ settings: DEFAULTS });
  await ensureAlarm();
  poll();
  startTicker();

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
  startTicker();
});

chrome.notifications.onClicked.addListener(async function (id) {
  if (id === 'pickcat-welcome-once') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    return;
  }
  /* 点通知固定直达消息中心 */
  chrome.tabs.create({ url: BASE + '/notifications' });
});

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'PC_CHECK_NOW') {
    poll().then(async function (r) {
      sendResponse({ result: r, state: await st() });
    });
    return true;
  }

  if (msg.type === 'PC_MARK_ALL_READ') {
    (async function () {
      try {
        let tabId = await findOpenPickcatTab();
        if (tabId == null) tabId = await createHiddenPage();
        const r = await sendToTab(tabId, { type: 'PC_MARK_ALL_READ' });
        if (!r) throw new Error('页面没响应（可能还没加载完）');
        if (!r.ok) throw new Error(describeError(r.status, r.error));
        await saveSt({ unread: 0, lastCount: 0, recent: [], error: '' });
        await updateBadge(0, await cfg());
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'PC_SAVE') {
    (async function () {
      const cur = await cfg();
      const next = Object.assign({}, cur, msg.patch || {});
      if (msg.patch && msg.patch.intervalMin != null) next.intervalMin = clampMin(msg.patch.intervalMin);
      if (msg.patch && msg.patch.notifyMax != null) next.notifyMax = Math.max(1, Math.min(5, Number(msg.patch.notifyMax) || 3));
      if (msg.patch && Array.isArray(msg.patch.chain)) {
        const all = ['page', 'direct', 'window'];
        const picked = msg.patch.chain.filter(function (s) { return all.indexOf(s) >= 0; });
        next.chain = picked;
        if (picked.length === 3) {
          next.mode = 'smart';
        } else if (picked.length) {
          next.mode = 'custom';
        } else {
          next.mode = 'smart';
          next.chain = all;
        }
      }
      if (msg.patch && msg.patch.mode && !Array.isArray(msg.patch.chain)) {
        if (msg.patch.mode === 'smart') next.chain = ['page', 'direct', 'window'];
        else if (msg.patch.mode !== 'custom') next.chain = [msg.patch.mode];
      }
      await chrome.storage.local.set({ settings: next });
      try {
        await ensureAlarm();
        await startTicker();
        await updateBadge((await st()).unread || 0, next);
        if (next.enabled) poll();
      } catch (e) {
        /* 闹钟/角标出问题也不能让设置页卡住 */
      }
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
      await closeHelper();
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
