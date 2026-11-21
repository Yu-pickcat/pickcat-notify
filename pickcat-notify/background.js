/* Pickcat 消息通知助手：后台定时检查未读数，网页关掉后照样弹通知 */

const BASE = 'https://pickcat.dao3.fun';
const API_SUMMARY = BASE + '/api/v1/notification-summary';
const API_LIST = BASE + '/api/v1/notifications?limit=5';
const ICON_PATH = 'icons/hot128.png';

const DEFAULTS = {
  enabled: true,
  mode: 'smart',
  chain: ['page', 'direct', 'window'],
  intervalMin: 1,
  notify: true,
  notifyTypes: { mention: true, reply: true, like: true, system: true },
  notifyMax: 3,
  badge: false,
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
  recent: [],
  readSeen: []
};

/* ---------- 版本与更新（参考 PICKCAT Plus 的「关于页检查更新」） ----------
   解压加载的扩展没有自动更新通道，只能自己比对远端版本号。
   源顺序：GitHub Releases API（发布即生效、不走 CDN 缓存）→ jsDelivr 镜像的 manifest.json。
   两个源都返回 Access-Control-Allow-Origin: *，后台直接 fetch，不需要新增 host 权限。 */
const REPO = 'Yu-pickcat/pickcat-notify';
const RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases?per_page=5';
const RELEASE_PAGE = 'https://github.com/' + REPO + '/releases/tag/';
/* 版本号 → Release 页地址。tag 一律小写 v 前缀（version 只有三段数字），
   直接拼 version 会得到 /releases/tag/2.6.4 这种不存在的地址，点开就是 404 */
function releaseUrl(ver) {
  var t = String(ver || '').trim();
  if (t.charAt(0) === 'V') t = 'v' + t.slice(1);
  else if (t.charAt(0) !== 'v') t = t ? 'v' + t : '';
  return t ? RELEASE_PAGE + encodeURIComponent(t) : 'https://github.com/' + REPO + '/releases';
}
/* 直连 raw.githubusercontent 最快也最新（GitHub 自己的文件），jsDelivr 只是备用：
   在国内网络里 jsDelivr 偶尔整段不可用，实测浏览器里会直接 Failed to fetch */
const MANIFEST_SOURCES = [
  'https://raw.githubusercontent.com/' + REPO + '/main/pickcat-notify/manifest.json',
  'https://fastly.jsdelivr.net/gh/' + REPO + '@main/pickcat-notify/manifest.json',
  'https://cdn.jsdelivr.net/gh/' + REPO + '@main/pickcat-notify/manifest.json',
  'https://gcore.jsdelivr.net/gh/' + REPO + '@main/pickcat-notify/manifest.json'
];
const UPDATE_KEY = 'updateCheck';
const UPDATE_TTL = 6 * 60 * 60 * 1000;

/* ---------- 通知记账（参考 PickScribe 的按 id 去重） ----------
   seen = 已经提醒过/已经见过的通知 id，首轮只记账不弹，避免装完把历史未读全弹一遍；
   pending = 通知 id → 点击跳转链接，落盘保存，后台被挂起后点击也还能直达 */
const NOTE_STATE_KEY = 'notifySeen';
const NOTE_PREFIX = 'pickcat-n-';
const SEEN_LIMIT = 300;
const PENDING_LIMIT = 60;

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

/* 新开标签；浏览器刚启动、窗口刚被关掉，或闹钟唤醒 SW 的瞬间，当前窗口可能还没就绪，
   tabs.create 会 reject「No current window」。这里延迟重试一次；仍失败就静默放弃 */
function createOrRetry(url) {
  return chrome.tabs.create({ url: url }).catch(function () {
    return sleep(800).then(function () {
      return chrome.tabs.create({ url: url });
    });
  }).catch(function () { /* 窗口仍未就绪，放弃 */ });
}

/* 打开链接。共存时最关键的一条：消息中心、更新页这类「不带锚点」的地址，
   如果已经开着就直接切过去，不再开第二个标签——同时装了 PICKCAT Plus / PickScribe 时，
   两边都会点开消息中心，这样最多只会有一个消息中心标签，不会开出一排重复页。
   带 #post-<楼号> 的帖子链接每层楼是不同目标，不能复用别的楼层，直接新开 */
function openTab(url) {
  const target = String(url || '');
  if (!target) return;
  const canReuse = /^https?:/i.test(target) && target.indexOf('#') < 0;
  if (!canReuse) {
    createOrRetry(target);
    return;
  }
  chrome.tabs.query({ url: target + '*' }).then(function (tabs) {
    const live = (tabs || []).filter(function (t) { return t.id != null && !t.incognito; });
    if (!live.length) return createOrRetry(target);
    return chrome.tabs.update(live[0].id, { active: true }).catch(function () {
      return createOrRetry(target);
    });
  }).catch(function () {
    /* 查询本身失败（比如没有读标签地址的权限）就老实开新的 */
    createOrRetry(target);
  });
}

function clampMin(v) {
  var n = Number(v) || 1;
  if (n < 0.5) n = 0.5;
  if (n > 60) n = 60;
  return n;
}

/* ---------- 版本比较 ---------- */

/* 逐段按数字比，不能按字符串比：字符串会把 2.10 判成比 2.9 小。
   返回 1 表示 a 新、-1 表示 a 旧、0 表示一样 */
function verCmp(a, b) {
  const x = String(a || '').split('.');
  const y = String(b || '').split('.');
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const p = Number(x[i]) || 0;
    const q = Number(y[i]) || 0;
    if (p > q) return 1;
    if (p < q) return -1;
  }
  return 0;
}

/* 'v2.4.7-beta' → '2.4.7'；取不到数字就返回空串 */
function tagVersion(tag) {
  const m = String(tag || '').match(/(\d+\.\d+(?:\.\d+)*)/);
  return m ? m[1] : '';
}

/* 带超时的 JSON 请求；失败、超时、非 2xx 都返回 null，不抛错（离线时静默） */
async function readJsonSafe(url, ms) {
  let ctl = null;
  let timer = 0;
  try {
    if (typeof AbortController === 'function') {
      ctl = new AbortController();
      timer = setTimeout(function () { ctl.abort(); }, ms || 8000);
    }
    const res = await fetch(url, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { accept: 'application/json' },
      signal: ctl ? ctl.signal : undefined
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 取远端最新版本：先问 Releases（能同时拿到 tag 与下载页），再退回镜像里的 manifest */
async function fetchLatestVersion() {
  const rel = await readJsonSafe(RELEASES_API + '&_=' + Date.now(), 9000);
  if (Array.isArray(rel)) {
    const list = rel.filter(function (r) { return r && !r.draft && r.tag_name; });
    if (list.length) {
      const ver = tagVersion(list[0].tag_name);
      if (ver) {
        return {
          version: ver,
          tag: list[0].tag_name,
          url: list[0].html_url || releaseUrl(list[0].tag_name)
        };
      }
    }
  }
  /* 镜像源各自缓存进度不一样（jsDelivr 边缘节点可能还停在旧版本），
     所以并行拉全部、取其中版本号最大的那个，而不是第一个成功就算数 */
  const got = await Promise.all(MANIFEST_SOURCES.map(function (u) {
    return readJsonSafe(u + '?_=' + Date.now(), 6000);
  }));
  let best = '';
  for (let i = 0; i < got.length; i++) {
    const ver = tagVersion(got[i] && got[i].version);
    if (ver && verCmp(ver, best) > 0) best = ver;
  }
  if (best) return { version: best, tag: '', url: 'https://github.com/' + REPO + '/releases' };
  return null;
}

/* force=false 时优先用 6 小时内的缓存，避免设置页每开一次都请求外网 */
async function checkUpdate(force) {
  const local = chrome.runtime.getManifest().version;
  const got = await chrome.storage.local.get(UPDATE_KEY);
  const cached = got[UPDATE_KEY];
  if (!force && cached && cached.version && cached.at && Date.now() - cached.at < UPDATE_TTL) {
    return {
      ok: true,
      local: local,
      latest: cached.version,
      url: cached.url || '',
      hasNew: verCmp(cached.version, local) > 0,
      cached: true,
      at: cached.at
    };
  }
  const r = await fetchLatestVersion();
  if (!r) {
    return { ok: false, local: local, latest: '', url: '', hasNew: false, error: '网络不通，稍后再试' };
  }
  const at = Date.now();
  const patch = {};
  patch[UPDATE_KEY] = { version: r.version, url: r.url, at: at };
  await chrome.storage.local.set(patch);
  return {
    ok: true,
    local: local,
    latest: r.version,
    url: r.url,
    hasNew: verCmp(r.version, local) > 0,
    cached: false,
    at: at
  };
}

/* ---------- 通知记账 ---------- */

async function noteState() {
  const got = await chrome.storage.local.get(NOTE_STATE_KEY);
  const s = got[NOTE_STATE_KEY] || {};
  return {
    seeded: !!s.seeded,
    seen: Array.isArray(s.seen) ? s.seen.slice() : [],
    pending: (s.pending && typeof s.pending === 'object') ? s.pending : {}
  };
}

async function saveNoteState(s) {
  const patch = {};
  patch[NOTE_STATE_KEY] = s;
  await chrome.storage.local.set(patch);
}

/* pending 只留最近 60 条，避免越攒越多 */
function prunePending(s) {
  const p = s.pending || {};
  const keys = Object.keys(p);
  if (keys.length <= PENDING_LIMIT) return s;
  keys.sort(function (a, b) { return (p[b].at || 0) - (p[a].at || 0); });
  const keep = keys.slice(0, PENDING_LIMIT);
  const next = {};
  keep.forEach(function (k) { next[k] = p[k]; });
  s.pending = next;
  return s;
}

/* 本轮真正该弹的：未读、类型开着、以前没见过。首轮（seeded=false）一条都不弹 */
function freshItems(items, seen, seeded) {
  if (!Array.isArray(items)) return [];
  const seenArr = Array.isArray(seen) ? seen : [];
  return items.filter(function (it) {
    if (!it || typeof it !== 'object' || !it.id) return false;
    if (it.readAt !== null && typeof it.readAt !== 'undefined') return false;
    if (!seeded) return false;
    return seenArr.indexOf(it.id) < 0;
  });
}

/* 把本轮见到的 id 并进 seen，去重并裁到 300 条 */
function mergeSeen(seen, items) {
  const out = Array.isArray(seen) ? seen.slice() : [];
  if (Array.isArray(items)) {
    items.forEach(function (it) {
      if (it && it.id && out.indexOf(it.id) < 0) out.push(it.id);
    });
  }
  if (out.length > SEEN_LIMIT) out.splice(0, out.length - SEEN_LIMIT);
  return out;
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
  let win = null;
  /* 窗口刚启动时可能抢不到当前窗口，小窗创建失败就等一下重试一次 */
  for (let attempt = 0; attempt < 2 && !win; attempt++) {
    try {
      win = await chrome.windows.create({ url: BASE + '/', type: 'popup', width: 420, height: 320, focused: false });
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      if (attempt === 0) await sleep(1000);
    }
  }
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
  if (!lastErr) lastErr = '窗口没建出来';
  /* 老浏览器建不出独立小窗时，退一步用不抢焦点的后台标签页；同样重试一次 */
  let tab = null;
  for (let attempt = 0; attempt < 2 && !tab; attempt++) {
    try {
      tab = await chrome.tabs.create({ url: BASE + '/', active: false });
    } catch (e2) {
      lastErr = lastErr + ' / ' + ((e2 && e2.message) || String(e2));
      if (attempt === 0) await sleep(1000);
    }
  }
  if (tab) {
    await chrome.storage.local.set({ helperWindowId: null, helperTabId: tab.id });
    await waitTabLoaded(tab.id, 12000);
    return tab.id;
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

/* 头像响应头带 cross-origin-resource-policy: same-origin，扩展弹窗（chrome-extension:// 源）
   直接 <img> 会被浏览器拦掉。这里由后台凭跨源权限把头像抓成 data URL 再给弹窗，
   data URL 同源加载不受 CORP 限制。内存缓存避免重复抓取。 */
const avatarCache = {};
/* 通知序号：只用来给「还有 N 条」这类汇总通知拼一个不重复的 id；
   单条通知直接用消息自己的 id，见 NOTE_PREFIX */
let noteSeq = 0;

function readBlobAsDataUrl(blob) {
  return new Promise(function (resolve) {
    try {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result || ''); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(blob);
    } catch (e) { resolve(''); }
  });
}

async function avatarDataUrl(url) {
  if (!url || !/^https?:\/\//i.test(url)) return '';
  if (avatarCache[url]) return avatarCache[url];
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
    if (!res.ok) return '';
    const blob = await res.blob();
    const data = await readBlobAsDataUrl(blob);
    if (data) avatarCache[url] = data;
    return data;
  } catch (e) {
    return '';
  }
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

/* 点开后直达对应帖子：优先主题 id 拼线程链接；带楼号时加 #post-<楼号> 锚点。
   站点自己的通知链接就是这个格式（消息中心里回复通知指向 /forum/post/<topicId>#post-<postNumber>），
   页面加载后会自己滚动定位到那一楼，实测有效；评论 id 的 UUID 形式站点不识别，不要用它 */
function linkFor(i) {
  const topic = (i && i.topicId) || '';
  const floor = Number(i && i.floor) || 0;
  if (topic) return BASE + '/forum/post/' + topic + (floor > 0 ? '#post-' + floor : '');
  return BASE + '/notifications';
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

/* 弹窗里显示的最近动态，条数跟随「通知里最多列几条」设置（1～5）
   已经点开看过的消息不再回来：用一条稳定 key 记住，下轮检查时直接滤掉 */
function itemKey(i) {
  return [i.category || '', i.actor || '', i.ts || '', i.postId || i.topicId || '', i.floor || ''].join('|');
}

function recentFor(items, max, readSeen) {
  const n = Math.max(1, Math.min(5, Number(max) || 3));
  const skip = Array.isArray(readSeen) ? readSeen : [];
  return arrangeItems(items).filter(function (i) {
    return skip.indexOf(itemKey(i)) === -1;
  }).slice(0, n).map(function (i) {
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

/* 一条新消息单独弹一条通知：谁 + 做了什么 + 哪条帖子第几楼。
   通知 id 用消息自己的 id（稳定），同一条消息不会重复弹；
   跳转链接写进 storage 的 pending，后台被回收后点击仍然能直达 */
async function showItemNote(raw) {
  const c = await cfg();
  const one = normalizeItem(raw);
  if (!one) return null;
  /* 直接拼单条文案：normalizeItem 已经把「谁 + 做了啥 + 哪条」拆好了，
     再走 noteText 会被二次 normalize 丢掉字段 */
  const title = (one.actor || '有人') + ' ' + (one.action || '有新消息');
  const message = topicLine(one) || '点开消息中心看详情';

  /* 图标用发送者头像：先抓成 data URL（绕开站点 CORP 跨源限制），抓不到再退远程地址，最后回退扩展图标 */
  let iconUrl = chrome.runtime.getURL(ICON_PATH);
  if (one.avatar) {
    const data = await avatarDataUrl(one.avatar);
    if (data) iconUrl = data;
    else if (/^https?:\/\//i.test(one.avatar)) iconUrl = one.avatar;
  }

  const nid = NOTE_PREFIX + String(raw.id || Date.now());
  const ns = await noteState();
  ns.pending[nid] = { url: linkFor(one), at: Date.now() };
  await saveNoteState(prunePending(ns));

  await capNotifications();
  chrome.notifications.create(nid, {
    type: 'basic',
    iconUrl: iconUrl,
    title: title,
    message: message,
    contextMessage: 'Pickcat 通知助手',
    silent: !c.sound,
    priority: 2
  });
  return nid;
}

/* 新消息比设置里允许的条数多时，多出来的合并成一条「还有 N 条」 */
async function showSummary(rest) {
  const c = await cfg();
  await capNotifications();
  const nid = 'pickcat-sum-' + Date.now() + '-' + (++noteSeq);
  const ns = await noteState();
  ns.pending[nid] = { url: BASE + '/notifications', at: Date.now() };
  await saveNoteState(prunePending(ns));
  chrome.notifications.create(nid, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    title: '还有 ' + rest + ' 条新消息',
    message: '前面几条已经单独提醒过，点这里看全部',
    contextMessage: 'Pickcat 通知助手',
    silent: !c.sound,
    priority: 1
  });
  return nid;
}

const ICONS_HOT = {
  '16': 'icons/hot16.png', '24': 'icons/hot24.png', '32': 'icons/hot32.png', '48': 'icons/hot48.png',
  '64': 'icons/hot64.png', '96': 'icons/hot96.png', '128': 'icons/hot128.png',
  '192': 'icons/hot192.png', '256': 'icons/hot256.png'
};
const ICONS_ON = {
  '16': 'icons/icon16.png', '24': 'icons/icon24.png', '32': 'icons/icon32.png', '48': 'icons/icon48.png',
  '64': 'icons/icon64.png', '96': 'icons/icon96.png', '128': 'icons/icon128.png',
  '192': 'icons/icon192.png', '256': 'icons/icon256.png'
};
const ICONS_IDLE = {
  '16': 'icons/idle16.png', '24': 'icons/idle24.png', '32': 'icons/idle32.png', '48': 'icons/idle48.png',
  '64': 'icons/idle64.png', '96': 'icons/idle96.png', '128': 'icons/idle128.png',
  '192': 'icons/idle192.png', '256': 'icons/idle256.png'
};

async function updateBadge(count, c) {
  // 关掉开关就换灰 C，别让用户以为它还在跑
  if (c && c.enabled === false) {
    try {
      await chrome.action.setIcon({ path: ICONS_IDLE });
    } catch (e) { /* 图标缺失时忽略 */ }
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const has = count > 0;
  // 未读由字形右下角那块信号块变红表示；数字角标默认关闭（会压小图标），需要时再开
  try {
    await chrome.action.setIcon({ path: has ? ICONS_HOT : ICONS_ON });
  } catch (e) { /* 图标缺失时忽略 */ }

  if (!c.badge) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: '#FA322D' });
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

      await saveSt({
        unread: res.count,
        lastCount: res.count,
        lastCheck: Date.now(),
        via: res.via,
        error: '',
        loggedOut: false,
        recent: recentFor(res.items, c.notifyMax, prev.readSeen)
      });

      await updateBadge(res.count, c);

      /* 先按 id 记账再决定弹不弹：首轮只记账（避免装完把历史未读一起弹），
         之后只弹「以前没见过 & 未读 & 类型开着」的那几条，一条新消息只弹一次 */
      const ns = await noteState();
      const picked = filterByTypes(res.items, c.notifyTypes);
      const fresh = (c.notify && !inDnd(c)) ? freshItems(picked, ns.seen, ns.seeded) : [];
      let noteCount = 0;

      if (fresh.length) {
        const max = Math.max(1, Math.min(5, Number(c.notifyMax) || 3));
        const shown = fresh.slice(0, max);
        for (let k = 0; k < shown.length; k++) await showItemNote(shown[k]);
        noteCount = shown.length;
        if (fresh.length > shown.length) {
          await showSummary(fresh.length - shown.length);
          noteCount = fresh.length;
        }
      }

      /* 记账：本轮见到的全部 id（含已读、含被类型开关滤掉的），关掉再打开也不会补弹旧消息 */
      ns.seen = mergeSeen(ns.seen, res.items);
      ns.seeded = true;
      await saveNoteState(prunePending(ns));

      return { ok: true, count: res.count, via: res.via, notes: noteCount };
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

  /* 升级安装时弹一次「已更新」通知，同一个版本只弹一次（参考 PickScribe 的升级提示） */
  if (details && details.reason === 'update') await showUpdateNotice();

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
      openTab(chrome.runtime.getURL('welcome.html'));
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
    openTab(chrome.runtime.getURL('welcome.html'));
    return;
  }
  /* 升级提示：点正文直接去看更新内容 */
  if (id.indexOf('pickcat-update-') === 0) {
    openTab(releaseUrl(id.slice('pickcat-update-'.length)));
    return;
  }
  /* 单条新消息的通知 id 就是这条消息的 id，直达链接存在 storage 的 pending 里；
     多条汇总的通知回消息中心；都没记到就回消息中心 */
  const ns = await noteState();
  const hit = ns.pending && ns.pending[id];
  const url = (hit && hit.url) || BASE + '/notifications';
  if (hit) {
    delete ns.pending[id];
    await saveNoteState(ns);
  }
  openTab(url);
});

/* 升级提示上的按钮：第一个去看更新内容，第二个关掉 */
chrome.notifications.onButtonClicked.addListener(async function (id, index) {
  if (id.indexOf('pickcat-update-') !== 0) return;
  const ver = id.slice('pickcat-update-'.length);
  if (index === 0) openTab(releaseUrl(ver));
  try { await chrome.notifications.clear(id); } catch (e) { /* 通知已消失 */ }
});

/* 每个版本到底改了什么：升级提示里直接列出来，不再写空话 */
const UPDATE_NOTES = {
  '2.6.6': [
    '修掉更新提示点开就 404：Release 地址补上了 tag 的 v 前缀',
    '更新提示、设置页检查更新用的是同一个地址生成方式'
  ],
  '2.6.5': [
    '图标按官网原图重新量的：右上那条起笔斜边改成真直线',
    '直边统一用直线，圆角用切线连续的曲线，边缘不再有起伏'
  ],
  '2.6.4': [
    '图标改成几何矢量：该直的是直线，圆角是真圆弧',
    '字形的开口尖角按官网原字还原，边缘不再有起伏'
  ],
  '2.6.3': [
    '图标 SVG 先平滑再转路径，边缘不再有像素抖动',
    '页面图标全部矢量，设置页仍是带红块那版'
  ],
  '2.6.2': [
    '页面里的图标换成 SVG 矢量，放在多大都是硬的',
    '设置页头部用带红块那版图标',
    '工具栏图标仍是 9 档位图（Chrome 只收位图，已按 DPI 备齐）'
  ],
  '2.6.1': [
    '设置页内容宽度跟屏幕走，大屏不再一条窄条',
    '弹窗宽度改成按屏幕宽度算，不再是四档跳',
    '升级提示改成列出这一版的具体改动'
  ],
  '2.6.0': [
    '图标换成官网 logo 里的 C，右下角斜块变红＝有未读',
    '数字角标默认关闭，不再压住图标',
    '看过的动态点开就从列表撤掉'
  ],
  '2.5.0': [
    '界面照官网重做',
    '图标重画，底色改成超椭圆'
  ]
};

/* 升级后弹一次提示，同一个版本只弹一次（参考 PickScribe 的 showUpdateNotice） */
async function showUpdateNotice() {
  const mf = chrome.runtime.getManifest();
  const ver = mf.version;
  const name = mf.version_name || ('V' + ver);
  const got = await chrome.storage.local.get('updateNotice');
  if (got.updateNotice === ver) return;
  await chrome.storage.local.set({ updateNotice: ver });
  const notes = UPDATE_NOTES[ver] || [];
  let body;
  if (notes.length) {
    body = '这版改了什么：\n' + notes.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n');
  } else {
    body = '这版有改动，点「看看更新内容」可以看完整说明。';
  }
  chrome.notifications.create('pickcat-update-' + ver, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL(ICON_PATH),
    title: 'Pickcat 通知已更新到 ' + name,
    message: body,
    contextMessage: 'Pickcat 通知助手',
    buttons: [{ title: '看看更新内容' }, { title: '以后再说' }],
    priority: 1
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;

  if (msg.type === 'PC_CHECK_NOW') {
    poll().then(async function (r) {
      sendResponse({ result: r, state: await st() });
    });
    return true;
  }

  /* 设置页 / 弹窗里的「检查更新」：force=true 忽略 6 小时缓存 */
  if (msg.type === 'PC_CHECK_UPDATE') {
    (async function () {
      try {
        sendResponse(await checkUpdate(!!msg.force));
      } catch (e) {
        sendResponse({ ok: false, local: chrome.runtime.getManifest().version, hasNew: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  /* 打开扩展页里的外部链接（设置页的「去下载」） */
  if (msg.type === 'PC_OPEN_URL') {
    openTab(String(msg.url || ''));
    sendResponse({ ok: true });
    return false;
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
    openTab(BASE + '/');
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_POST') {
    openTab(linkFor({ topicId: msg.topicId, floor: msg.floor }));
    /* 点开看过的这条，立刻从「最近动态」里撤掉，下次检查也不再冒出来 */
    (async function () {
      try {
        const s = await st();
        const key = itemKey({ category: msg.category, actor: msg.actor, ts: msg.ts, postId: msg.topicId, floor: msg.floor });
        const readSeen = (Array.isArray(s.readSeen) ? s.readSeen : []).concat([key]).slice(-300);
        const recent = (Array.isArray(s.recent) ? s.recent : []).filter(function (x) { return itemKey(x) !== key; });
        await saveSt({ readSeen: readSeen, recent: recent });
      } catch (e) { /* 记录失败不影响打开帖子 */ }
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_WELCOME') {
    openTab(chrome.runtime.getURL('welcome.html'));
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

  if (msg.type === 'PC_AVATAR') {
    (async function () {
      sendResponse({ data: await avatarDataUrl(String(msg.url || '')) });
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
