/* Pickcat 消息通知助手 v2.4.1
   后台定时检查未读数，网页关掉后照样弹通知；点通知可直达那条帖子 / 作品。 */

const BASE = 'https://pickcat.dao3.fun';
const API_SUMMARY = '/api/v1/notification-summary';
const API_LIST = '/api/v1/notifications';
const ICON_PATH = 'icons/icon128.png';
const VERSION = '2.4.1';

/* ============================================================
   兼容层
   Chrome / Edge / 其它 Chromium 内核浏览器（360、QQ、Brave、Vivaldi）都能跑：
   - 老版本只支持回调式 API，新版本才返回 Promise → 统一用回调包 Promise
   - 新版是 chrome.action，老一点的 MV3 可能还是 browserAction → 兜底
   - 没有通知 API 的环境（少数精简内核）→ 只显示角标，不影响检查
   ============================================================ */

const EXT = (typeof browser !== 'undefined' && browser && browser.runtime) ? browser : chrome;
const ACT = EXT.action || EXT.browserAction || null;
const NOTE = EXT.notifications || null;
const ALARM = EXT.alarms || null;

function hasApi(fn) { return typeof fn === 'function'; }

/* 回调式调用包成 Promise，同时兼容直接返回 Promise 的实现 */
function call(fn, ctx, args) {
  if (!hasApi(fn)) return Promise.reject(new Error('当前浏览器不支持该接口'));
  return new Promise(function (resolve, reject) {
    let settled = false;
    function done(res) {
      if (settled) return;
      settled = true;
      const err = EXT.runtime && EXT.runtime.lastError;
      if (err) reject(new Error(err.message)); else resolve(res);
    }
    let ret;
    try {
      ret = fn.apply(ctx, (args || []).concat([done]));
    } catch (e) {
      if (!settled) { settled = true; reject(e); }
      return;
    }
    if (ret && typeof ret.then === 'function') {
      ret.then(done, function (e) { if (!settled) { settled = true; reject(e); } });
    }
  });
}

function pGet(keys) { return call(EXT.storage.local.get, EXT.storage.local, [keys]); }
function pSet(obj) { return call(EXT.storage.local.set, EXT.storage.local, [obj]); }
function pDel(keys) { return call(EXT.storage.local.remove, EXT.storage.local, [keys]); }

function tabsQuery(q) { return call(EXT.tabs.query, EXT.tabs, [q]); }
function tabCreate(o) { return call(EXT.tabs.create, EXT.tabs, [o]); }
function tabSend(id, msg) { return call(EXT.tabs.sendMessage, EXT.tabs, [id, msg]); }
function tabUpdate(id, o) { return call(EXT.tabs.update, EXT.tabs, [id, o]); }
function tabRemove(id) { return call(EXT.tabs.remove, EXT.tabs, [id]).catch(function () {}); }
function winCreate(o) { return call(EXT.windows.create, EXT.windows, [o]); }
function winGetAll(q) { return call(EXT.windows.getAll, EXT.windows, [q]); }
function winUpdate(id, o) { return call(EXT.windows.update, EXT.windows, [id, o]).catch(function () {}); }
function winRemove(id) { return call(EXT.windows.remove, EXT.windows, [id]).catch(function () {}); }
function openOptions() {
  if (hasApi(EXT.runtime.openOptionsPage)) {
    return call(EXT.runtime.openOptionsPage, EXT.runtime, []).catch(function () {
      return tabCreate({ url: EXT.runtime.getURL('options.html'), active: true });
    });
  }
  return tabCreate({ url: EXT.runtime.getURL('options.html'), active: true });
}

/* 闹钟：create / clear 没有回调，直接调用即可 */
function alarmClear(name) {
  if (!ALARM) return Promise.resolve();
  try { ALARM.clear(name); } catch (e) { /* 忽略 */ }
  return Promise.resolve();
}
function alarmCreate(name, info) {
  if (!ALARM) return Promise.resolve();
  try { ALARM.create(name, info); } catch (e) { /* 忽略 */ }
  return Promise.resolve();
}
function alarmGet(name) {
  if (!ALARM) return Promise.resolve(null);
  return call(ALARM.get, ALARM, [name]).catch(function () { return null; });
}

/* 角标 */
function setBadgeText(o) { if (ACT) return call(ACT.setBadgeText, ACT, [o]).catch(function () {}); return Promise.resolve(); }
function setBadgeBg(o) { if (ACT) return call(ACT.setBadgeBackgroundColor, ACT, [o]).catch(function () {}); return Promise.resolve(); }
function setIcon(o) { if (ACT) return call(ACT.setIcon, ACT, [o]).catch(function () {}); return Promise.resolve(); }

/* 通知 */
function noteCreate(id, opts) { if (NOTE) return call(NOTE.create, NOTE, [id, opts]).catch(function () {}); return Promise.resolve(); }
function noteClear(id) { if (NOTE) return call(NOTE.clear, NOTE, [id]).catch(function () {}); return Promise.resolve(); }

/* ============================================================
   设置与状态
   ============================================================ */

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
  dndEnd: '07:00',
  notifyReply: true,
  notifyMention: true,
  notifyLike: true,
  notifySystem: true,
  groupLikes: true
};

const EMPTY_STATE = {
  unread: 0,
  lastCount: 0,
  lastCheck: 0,
  via: '',
  error: '',
  loggedOut: false,
  recent: [],
  byType: null,
  seen: [],
  inited: false
};

async function cfg() {
  const got = await pGet('settings').catch(function () { return {}; });
  return Object.assign({}, DEFAULTS, (got && got.settings) || {});
}

async function st() {
  const got = await pGet('state').catch(function () { return {}; });
  return Object.assign({}, EMPTY_STATE, (got && got.state) || {});
}

async function saveSt(patch) {
  const cur = await st();
  const next = Object.assign({}, cur, patch);
  await pSet({ state: next });
  return next;
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function clampMin(v) {
  let n = Number(v) || 1;
  if (n < 1) n = 1;
  if (n > 30) n = 30;
  return Math.round(n);
}

/* 安全取值：getIn(obj, 'a.b.c') */
function getIn(obj, path) {
  if (!obj) return undefined;
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur === 'undefined') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}

/* ============================================================
   闹钟
   ============================================================ */

async function ensureAlarm() {
  const c = await cfg();
  await alarmClear('pickcat-tick');
  if (!c.enabled) return;
  const m = clampMin(c.intervalMin);
  await alarmCreate('pickcat-tick', { periodInMinutes: m, delayInMinutes: m });
}

async function alarmInfo() {
  const a = await alarmGet('pickcat-tick');
  if (!a) return null;
  return { when: a.scheduledTime, period: a.periodInMinutes };
}

/* ============================================================
   读取未读数与消息列表
   ============================================================ */

async function directFetch(url, method, body) {
  const opts = {
    method: method || 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
    cache: 'no-store'
  };
  if (body) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return { ok: true, data: null, status: 204 };
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

function pickItems(json) {
  if (!json) return [];
  if (Array.isArray(json.items)) return json.items;
  if (json.data && Array.isArray(json.data.items)) return json.data.items;
  return [];
}

async function getHelperTab() {
  const tabs = await tabsQuery({ url: BASE + '/*' }).catch(function () { return []; });
  const live = (tabs || []).filter(function (t) { return t && t.id != null; });
  if (!live.length) return null;
  const stored = await pGet(['helperWindowId', 'helperTabId']).catch(function () { return {}; });
  const tabIdSaved = stored.helperTabId;
  const winId = stored.helperWindowId;
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

async function createHelperTab() {
  /* 已经有一个 Pickcat 标签页就复用它，绝不多开 */
  const exist = await getHelperTab();
  if (exist != null) return exist;

  /* 关键：只在你已经开着的普通窗口里，放一个不抢焦点的后台标签页。
     从来不用 windows.create（那会弹出可见的小窗），也绝不在没有窗口时新建窗口
     —— 否则等于帮用户把浏览器拉起来。 */
  let win = null;
  try {
    const wins = await winGetAll({ windowTypes: ['normal'] });
    const list = (wins || []).filter(function (w) { return w && w.id != null; });
    win = list.find(function (w) { return w.focused; }) || list[0] || null;
  } catch (e) { win = null; }
  if (!win) throw new Error('浏览器没有打开的窗口，本轮跳过（不会自己开浏览器）');

  const tab = await tabCreate({ url: BASE + '/', active: false, windowId: win.id });
  await pSet({ helperWindowId: null, helperTabId: tab && tab.id != null ? tab.id : null });
  if (tab && tab.id != null) return tab.id;
  throw new Error('不能打开后台页面');
}

async function ensureHelperTab() {
  const tabId = await getHelperTab();
  if (tabId != null) return tabId;
  return await createHelperTab();
}

async function sendToTab(tabId, msg) {
  if (tabId == null) return null;
  for (let i = 0; i < 5; i++) {
    try {
      const resp = await tabSend(tabId, msg);
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
    tabId = await createHelperTab();
    resp = await sendToTab(tabId, { type: 'PC_READ_UNREAD' });
  }
  if (!resp) throw new Error('后台页面没响应（页面可能没加载出来）');
  if (!resp.ok) throw new Error(describeError(resp.status, resp.error));
  return {
    count: Number(resp.count) || 0,
    items: resp.items || [],
    byType: resp.byType || null,
    via: 'window'
  };
}

async function readUnread() {
  const c = await cfg();
  let directStatus = 0;

  if (c.mode !== 'window') {
    const d = await directFetch(API_SUMMARY).catch(function () { return { ok: false, status: 0 }; });
    if (d.ok) {
      const list = await directFetch(API_LIST + '?limit=8').catch(function () { return { ok: false }; });
      const items = list.ok ? pickItems(list.data) : [];
      return {
        count: Number(getIn(d.data, 'unreadCount')) || 0,
        items: items,
        byType: getIn(d.data, 'unreadCountByType') || null,
        via: 'direct'
      };
    }
    directStatus = d.status;
    if (c.mode === 'direct') throw new Error(describeError(d.status));
  }

  const byHelper = await readByHelper();
  if (directStatus && !byHelper.count) byHelper.hint = describeError(directStatus);
  return byHelper;
}

/* 手动「全部标为已读」：先试直连 PATCH，不行再用页面里的登录态发 */
async function markAllRead() {
  const d = await directFetch(API_LIST, 'PATCH', { read: true }).catch(function (e) {
    return { ok: false, status: 0, error: String(e) };
  });
  if (d.ok) return { ok: true, via: 'direct' };

  let tabId = await ensureHelperTab();
  let resp = await sendToTab(tabId, { type: 'PC_MARK_READ' });
  if (!resp) {
    tabId = await createHelperTab();
    resp = await sendToTab(tabId, { type: 'PC_MARK_READ' });
  }
  if (resp && resp.ok) return { ok: true, via: 'window' };
  throw new Error(describeError((resp && resp.status) || d.status, '标记已读失败'));
}

/* ============================================================
   把站点的一条通知整理成「谁 + 做了什么 + 哪条内容 + 点开去哪」
   类型表与文案取自站点前端真实的通知类型，不要凭感觉猜。
   ============================================================ */

const TYPE_INFO = {
  REPLY_CREATED: { kind: 'reply', act: '回复了你的帖子' },
  POST_LIKED: { kind: 'like', act: '赞了你的内容' },
  USER_FOLLOWED: { kind: 'follow', act: '关注了你' },
  USER_MENTIONED: { kind: 'mention', act: '@了你' },
  TOPIC_EVENT: { kind: 'system', act: '你关注的帖子有了新动态' },
  WORK_COMMENT_CREATED: { kind: 'reply', act: '评论了你的作品' },
  WORK_COMMENT_REPLY_CREATED: { kind: 'reply', act: '回复了你的评论' },
  WORK_COMMENT_MENTIONED: { kind: 'mention', act: '在评论中 @了你' },
  WORK_LIKED: { kind: 'like', act: '赞了你的作品' },
  WORK_COMMENT_LIKED: { kind: 'like', act: '赞了你的评论' },
  MANAGEMENT_ACTION: { kind: 'system', act: '给你发了一条社区管理通知' },
  LEVEL_CERTIFICATION: { kind: 'system', act: '等级认证出结果了' },
  TAKEDOWN_APPEAL_DECIDED: { kind: 'system', act: '下架申诉有结果了' },
  QUESTION_DUPLICATE_REQUEST_DECIDED: { kind: 'system', act: '问答重复申请有结果了' }
};

const KIND_LABEL = { reply: '回复', mention: '@我', like: '赞', follow: '关注', system: '系统', other: '动态' };

const MGMT_ACTION = {
  USER_SILENCED: '你的账号已被禁言',
  USER_SUSPENDED: '你的账号已被停用',
  USER_UNSILENCED: '你的账号禁言已解除',
  USER_UNSUSPENDED: '你的账号停用已解除',
  POST_REMOVED: '你的回复已被移除',
  TOPIC_REMOVED: '你的帖子已被移除',
  CONTENT_RESTORED: '你的内容已恢复',
  CASE_RESOLVED: '与你相关的举报已处理',
  USER_LEVEL_CEILING_CHANGED: '你的等级成长上限已调整',
  WORK_REMOVED: '你的作品已被移除',
  TOPIC_TAKEN_DOWN: '你的帖子已被下架',
  WORK_TAKEN_DOWN: '你的作品已被下架',
  CONTENT_REINSTATED: '你的内容已解除下架',
  WORK_COMMENT_REMOVED: '你的评论已被移除'
};

const LEVEL_STATUS = { APPROVED: '等级认证已通过', REJECTED: '等级认证未通过', WITHDRAWN: '等级认证已撤回' };

function flat(text, max) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

function actorOf(d) {
  const a = d && d.actor;
  if (!a) return { name: '', avatar: '', id: '' };
  let name = a.username || a.nickname || a.displayName || a.name || '';
  let avatar = '';
  if (a.avatar && typeof a.avatar === 'object') avatar = a.avatar.url || a.avatar.src || '';
  else if (typeof a.avatar === 'string') avatar = a.avatar;
  if (avatar && avatar.charAt(0) === '/') avatar = BASE + avatar;
  return { name: flat(name, 24), avatar: String(avatar || ''), id: a.id || '' };
}

/* 与站点前端完全一致的跳转规则：
   作品 → /works/<workId>（有评论楼层再加 #post-N）
   帖子 → /forum/post/<topicId>（postNumber > 1 时加 #post-N） */
function targetUrl(d) {
  if (!d) return '';
  if (d.work && d.work.id) {
    return BASE + '/works/' + d.work.id + (getIn(d, 'comment.commentNumber') ? '#post-' + getIn(d, 'comment.commentNumber') : '');
  }
  if (d.topic && d.topic.id) {
    const n = Number(getIn(d, 'post.postNumber')) || 0;
    return BASE + '/forum/post/' + d.topic.id + (n > 1 ? '#post-' + n : '');
  }
  const t = d.target || null;
  if (t && t.kind === 'work' && t.workId) {
    return BASE + '/works/' + t.workId + (t.commentNumber ? '#post-' + t.commentNumber : '');
  }
  if (t && t.topicId) {
    const n2 = Number(t.postNumber) || 0;
    return BASE + '/forum/post/' + t.topicId + (n2 > 1 ? '#post-' + n2 : '');
  }
  if (d.content && d.content.id) {
    return d.content.kind === 'WORK' ? BASE + '/works/' + d.content.id : BASE + '/forum/post/' + d.content.id;
  }
  if (d.question && d.question.id) return BASE + '/forum/post/' + d.question.id;
  return '';
}

function tabFor(kind) {
  if (kind === 'reply') return 'reply';
  if (kind === 'mention') return 'mention';
  if (kind === 'like') return 'like';
  return 'system';
}

function normalizeItem(it) {
  if (!it || typeof it !== 'object') return null;
  const d = it.details || {};
  const info = TYPE_INFO[it.type] || { kind: 'other', act: '有新动态' };
  const who = actorOf(d);
  let actor = who.name;
  let action = info.act;
  let excerpt = d.excerpt || getIn(d, 'comment.excerpt') || getIn(d, 'post.excerpt') || '';
  const title = getIn(d, 'topic.title') || getIn(d, 'work.workName') || getIn(d, 'question.title') || '';

  if (it.type === 'USER_MENTIONED') {
    action = Number(getIn(d, 'post.postNumber')) === 1 ? '在帖子中 @了你' : '在评论中 @了你';
  } else if (it.type === 'MANAGEMENT_ACTION') {
    actor = '社区管理';
    action = MGMT_ACTION[d.actionType] || info.act;
    excerpt = d.publicReasonDetail ? '说明：' + d.publicReasonDetail : '';
  } else if (it.type === 'LEVEL_CERTIFICATION') {
    actor = '社区等级系统';
    action = LEVEL_STATUS[getIn(d, 'certification.status')] || info.act;
    excerpt = d.publicReasonDetail || '';
  } else if (it.type === 'TAKEDOWN_APPEAL_DECIDED') {
    actor = '社区管理';
    const art = d.content && d.content.kind === 'WORK' ? '作品' : '帖子';
    action = d.decision === 'REINSTATE' ? ('你的' + art + '申诉已通过，内容已恢复') : ('你的' + art + '申诉未通过，内容保持下架');
    excerpt = d.reply ? '管理员回复：' + d.reply : '';
  } else if (it.type === 'QUESTION_DUPLICATE_REQUEST_DECIDED') {
    actor = '社区管理';
    action = d.decision === 'ACCEPT' ? '你提交的问答重复申请已采纳' : '你提交的问答重复申请已驳回';
    excerpt = d.reply || '';
  }

  const url = targetUrl(d);
  const fallback = BASE + '/notifications?tab=' + tabFor(info.kind);
  const ts = Date.parse(it.createdAt) || 0;

  return {
    id: it.id || '',
    type: it.type || '',
    kind: info.kind,
    actor: actor,
    avatar: who.avatar,
    action: action,
    title: flat(title, 50),
    excerpt: flat(excerpt, 60),
    url: url || fallback,
    read: !(it.readAt === null || typeof it.readAt === 'undefined'),
    ts: ts
  };
}

function arrange(items) {
  if (!Array.isArray(items)) return [];
  const list = items.map(normalizeItem).filter(Boolean);
  const unread = list.filter(function (i) { return !i.read; });
  const read = list.filter(function (i) { return i.read; });
  unread.sort(function (a, b) { return b.ts - a.ts; });
  read.sort(function (a, b) { return b.ts - a.ts; });
  return unread.concat(read);
}

function recentFor(items) {
  return arrange(items).slice(0, 3).map(function (i) {
    return {
      id: i.id, actor: i.actor, avatar: i.avatar, action: i.action,
      title: i.title, excerpt: i.excerpt, url: i.url, kind: i.kind, read: i.read
    };
  });
}

/* ============================================================
   通知文案
   ============================================================ */

/* 同一条内容的多个赞合并成「A、B 等 3 人赞了你的内容」 */
function buildRows(items, groupOn) {
  const out = [];
  const map = {};
  const list = (Array.isArray(items) ? items : []).map(function (x) {
    return x && x.kind ? x : normalizeItem(x);
  }).filter(Boolean);

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (groupOn && it.kind === 'like' && it.url) {
      let g = map[it.url];
      if (!g) {
        g = { actors: [], count: 0, action: it.action, title: it.title, excerpt: '', url: it.url, ts: it.ts };
        map[it.url] = g;
        out.push(g);
      }
      g.actors.push(it.actor || '有人');
      g.count += 1;
      if (it.ts > g.ts) g.ts = it.ts;
      continue;
    }
    out.push({
      actors: [it.actor], count: 1, action: it.action, title: it.title,
      excerpt: it.excerpt, url: it.url, ts: it.ts
    });
  }

  for (let j = 0; j < out.length; j++) {
    const g = out[j];
    const first = g.actors[0] || '有人';
    let names;
    if (g.count === 2) {
      names = g.actors.slice(0, 2).join('、');
    } else if (g.count > 2) {
      names = g.actors.slice(0, 2).join('、') + ' 等 ' + g.count + ' 人';
    } else {
      names = first;
    }
    g.head = names + ' ' + g.action;
  }

  out.sort(function (a, b) { return b.ts - a.ts; });
  return out;
}

function noteFromRows(count, rows) {
  const use = rows.slice(0, 3);

  let title = 'Pickcat 有新消息';
  let message = '';

  if (use.length === 1) {
    const one = use[0];
    title = one.head;
    const parts = [];
    if (one.title) parts.push('《' + one.title + '》');
    if (one.excerpt) parts.push(one.excerpt);
    if (!parts.length) parts.push('你现在有 ' + count + ' 条未读');
    message = parts.join('\n');
  } else if (use.length > 1) {
    title = 'Pickcat · ' + count + ' 条新消息';
    message = use.map(function (g) {
      let line = '· ' + g.head;
      if (g.title) line += '：' + g.title;
      else if (g.excerpt) line += '：' + g.excerpt;
      return line;
    }).join('\n');
    if (count > use.length) message += '\n· 还有 ' + (count - use.length) + ' 条…';
  } else {
    message = '你现在有 ' + count + ' 条未读';
  }

  // 正文里的换行要保留，只压掉多余空格
  return { title: flat(title, 60), message: String(message).replace(/[ \t]+/g, ' ').slice(0, 300) };
}

function noteText(count, items, groupOn) {
  return noteFromRows(count, buildRows(items, groupOn));
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

function typeAllowed(kind, c) {
  if (kind === 'reply') return c.notifyReply !== false;
  if (kind === 'mention') return c.notifyMention !== false;
  if (kind === 'like') return c.notifyLike !== false;
  return c.notifySystem !== false;
}

/* 通知 id → 打开地址，点击时用 */
async function rememberTarget(id, url, kindCount) {
  if (!id || !url) return;
  const got = await pGet('noteTargets').catch(function () { return {}; });
  const map = (got && got.noteTargets) || {};
  map[id] = { url: url, at: Date.now(), kinds: kindCount || '' };
  const keys = Object.keys(map).sort(function (a, b) { return (map[b].at || 0) - (map[a].at || 0); });
  for (let i = 40; i < keys.length; i++) delete map[keys[i]];
  await pSet({ noteTargets: map });
}

async function targetOf(id) {
  const got = await pGet('noteTargets').catch(function () { return {}; });
  const hit = (got && got.noteTargets) ? got.noteTargets[id] : null;
  return hit && hit.url ? hit.url : '';
}

async function forgetTarget(id) {
  const got = await pGet('noteTargets').catch(function () { return {}; });
  const map = (got && got.noteTargets) || {};
  if (!map[id]) return;
  delete map[id];
  await pSet({ noteTargets: map });
}

function kindSummary(items) {
  const counts = {};
  for (let i = 0; i < items.length; i++) {
    const k = items[i].kind || 'other';
    counts[k] = (counts[k] || 0) + 1;
  }
  const bits = [];
  ['reply', 'mention', 'like', 'follow', 'system'].forEach(function (k) {
    if (counts[k]) bits.push(KIND_LABEL[k] + ' ' + counts[k]);
  });
  if (!bits.length && counts.other) bits.push('动态 ' + counts.other);
  return bits.join(' · ');
}

async function showNote(count, items, c) {
  if (!NOTE) return;
  const groupOn = c.groupLikes !== false;
  const rows = buildRows(items, groupOn);
  const text = noteFromRows(count, rows);
  const url = (rows[0] && rows[0].url) || (BASE + '/notifications');
  const id = 'pickcat-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

  await rememberTarget(id, url, kindSummary(items));

  await noteCreate(id, {
    type: 'basic',
    iconUrl: EXT.runtime.getURL(ICON_PATH),
    title: text.title,
    message: text.message,
    contextMessage: 'Pickcat 通知助手 · ' + kindSummary(items) + (c.sound ? '' : ' · 静音'),
    silent: !c.sound,
    priority: 2
  });
}

/* ============================================================
   图标与角标
   ============================================================ */

const ICONS_ON = { '16': 'icons/icon16.png', '32': 'icons/icon32.png', '48': 'icons/icon48.png', '128': 'icons/icon128.png' };
const ICONS_IDLE = { '16': 'icons/idle16.png', '32': 'icons/idle32.png', '48': 'icons/idle48.png', '128': 'icons/idle128.png' };

async function updateBadge(count, c) {
  const has = count > 0;
  await setIcon({ path: has ? ICONS_ON : ICONS_IDLE });

  if (!c.badge) {
    await setBadgeText({ text: '' });
    return;
  }
  await setBadgeBg({ color: '#C8362C' });
  await setBadgeText({ text: has ? (count > 99 ? '99+' : String(count)) : '' });
}

/* ============================================================
   主流程
   ============================================================ */

const FRESH_WINDOW_MS = 6 * 60 * 60 * 1000; // 只提醒 6 小时内产生的消息，避免翻出陈年旧账

function mergeSeen(oldIds, newIds) {
  const out = [];
  const add = function (id) {
    if (!id || out.indexOf(id) >= 0) return;
    out.push(id);
  };
  (oldIds || []).forEach(add);
  (newIds || []).forEach(add);
  while (out.length > 200) out.shift();
  return out;
}

async function poll() {
  const c = await cfg();

  if (!c.enabled) {
    await setBadgeText({ text: '' });
    await setIcon({ path: ICONS_IDLE });
    return { skipped: true };
  }

  try {
    const res = await readUnread();
    const prev = await st();
    const items = Array.isArray(res.items) ? res.items : [];
    const seen = Array.isArray(prev.seen) ? prev.seen : [];
    const fresh = prev.inited ? items.filter(function (i) {
      return i && i.id && seen.indexOf(i.id) < 0;
    }) : [];
    const nextSeen = mergeSeen(seen, items.map(function (i) { return i && i.id; }));

    const recent = recentFor(items);

    await saveSt({
      unread: res.count,
      lastCount: res.count,
      lastCheck: Date.now(),
      via: res.via,
      error: '',
      loggedOut: false,
      recent: recent,
      byType: res.byType || null,
      seen: nextSeen,
      inited: true
    });

    await updateBadge(res.count, c);

    if (prev.inited && c.notify && fresh.length && !inDnd(c)) {
      const now = Date.now();
      const worth = fresh.map(normalizeItem).filter(function (i) {
        return i && typeAllowed(i.kind, c) && i.ts && (now - i.ts) < FRESH_WINDOW_MS;
      });
      if (worth.length) await showNote(res.count, worth, c);
    }

    return { ok: true, count: res.count, via: res.via, fresh: fresh.length };
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

/* ============================================================
   打开链接（尽量复用已经开着的标签页）
   ============================================================ */

async function openUrl(url) {
  if (!url) return;
  try {
    const tabs = await tabsQuery({ url: BASE + '/*' });
    const list = (tabs || []).filter(function (t) { return t && t.id != null; });
    // 完全同址的标签页：直接切过去，不多开
    const same = list.find(function (t) { return t.url === url; });
    if (same) {
      await tabUpdate(same.id, { active: true });
      if (same.windowId != null) await winUpdate(same.windowId, { focused: true });
      return;
    }
  } catch (e) { /* 查询失败就直接新建 */ }
  await tabCreate({ url: url, active: true });
}

/* ============================================================
   事件
   ============================================================ */

if (ALARM) {
  EXT.alarms.onAlarm.addListener(function (alarm) {
    if (alarm && alarm.name === 'pickcat-tick') poll();
  });
}

EXT.runtime.onInstalled.addListener(async function () {
  const got = await pGet(['settings', 'welcomeShown']).catch(function () { return {}; });
  if (!got.settings) await pSet({ settings: DEFAULTS });
  await ensureAlarm();
  poll();

  if (!got.welcomeShown) {
    await pSet({ welcomeShown: true });
    try {
      await winCreate({
        url: EXT.runtime.getURL('welcome.html'),
        type: 'popup',
        width: 780,
        height: 660,
        focused: true
      });
    } catch (e) {
      await tabCreate({ url: EXT.runtime.getURL('welcome.html'), active: true });
    }
    if (NOTE) {
      await rememberTarget('pickcat-welcome-once', BASE + '/notifications', '');
      noteCreate('pickcat-welcome-once', {
        type: 'basic',
        iconUrl: EXT.runtime.getURL(ICON_PATH),
        title: 'Pickcat 通知已开启',
        message: '这是一次性测试通知。以后只在新消息到来时提醒你，点一下就能直达那条内容。',
        contextMessage: '点我试试：会直接打开消息中心',
        priority: 2
      });
    }
  }
});

EXT.runtime.onStartup.addListener(async function () {
  await ensureAlarm();
  poll();
});

if (NOTE) {
  NOTE.onClicked.addListener(async function (id) {
    if (id === 'pickcat-welcome-once') {
      await tabCreate({ url: EXT.runtime.getURL('welcome.html'), active: true });
      return;
    }
    const c = await cfg();
    const url = await targetOf(id);
    if (c.openNotify === false || !url) await openUrl(BASE + '/notifications');
    else await openUrl(url);
    await forgetTarget(id);
    noteClear(id);
  });

  NOTE.onClosed.addListener(function (id) {
    forgetTarget(id);
  });

  if (NOTE.onButtonClicked) {
    NOTE.onButtonClicked.addListener(async function (id, index) {
      const url = await targetOf(id);
      if (url) await openUrl(url);
      await forgetTarget(id);
      noteClear(id);
    });
  }
}

EXT.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;

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
      await pSet({ settings: next });
      await ensureAlarm();
      const s = await st();
      await updateBadge(s.unread || 0, next);
      if (next.enabled) poll();
      sendResponse({ settings: next, state: await st() });
    })();
    return true;
  }

  if (msg.type === 'PC_TEST') {
    (async function () {
      const c = await cfg();
      if (!NOTE) { sendResponse({ ok: false, error: '当前浏览器不支持桌面通知' }); return; }
      const id = 'pickcat-test-' + Date.now();
      await rememberTarget(id, BASE + '/notifications?tab=like', '');
      await noteCreate(id, {
        type: 'basic',
        iconUrl: EXT.runtime.getURL(ICON_PATH),
        title: '测试通知 · 有人赞了你',
        message: '真实通知会写清：谁、做了什么、哪条内容，点一下直达那条帖子。',
        contextMessage: '这是测试，不是真消息',
        silent: !c.sound,
        priority: 2
      });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PC_MARK_READ') {
    (async function () {
      try {
        const r = await markAllRead();
        const s = await poll();
        sendResponse({ ok: true, via: r.via, result: s });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'PC_OPEN_URL') {
    (async function () {
      await openUrl(msg.url || BASE + '/');
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PC_OPEN') {
    tabCreate({ url: BASE + '/', active: true });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_OPTIONS') {
    openOptions();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_OPEN_WELCOME') {
    tabCreate({ url: EXT.runtime.getURL('welcome.html'), active: true });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'PC_CLOSE_HELPER') {
    (async function () {
      const got = await pGet(['helperWindowId', 'helperTabId']).catch(function () { return {}; });
      if (got.helperWindowId != null) await winRemove(got.helperWindowId);
      if (got.helperTabId != null) await tabRemove(got.helperTabId);
      await pSet({ helperWindowId: null, helperTabId: null });
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'PC_DIAG') {
    (async function () {
      const gotHelper = await pGet(['helperWindowId', 'helperTabId']).catch(function () { return {}; });
      sendResponse({
        version: VERSION,
        settings: await cfg(),
        state: await st(),
        alarm: await alarmInfo(),
        helper: gotHelper.helperWindowId || null,
        helperTab: gotHelper.helperTabId || null,
        canNotify: !!NOTE,
        canBadge: !!ACT
      });
    })();
    return true;
  }

  if (msg.type === 'PC_CLOSED_PAGE_TEST') {
    (async function () {
      const tabs = await tabsQuery({ url: BASE + '/*' }).catch(function () { return []; });
      let closed = 0;
      for (let i = 0; i < tabs.length; i++) {
        if (tabs[i] && tabs[i].id != null) {
          try { await tabRemove(tabs[i].id); closed++; } catch (e) { /* 忽略 */ }
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
