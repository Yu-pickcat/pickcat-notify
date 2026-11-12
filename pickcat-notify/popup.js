/* 工具栏弹窗：状态 + 最新动态（每条都能点开）+ 常用操作 */

const el = {
  sw: document.getElementById('sw'),
  unread: document.getElementById('unread'),
  tag: document.getElementById('tag'),
  meta: document.getElementById('meta'),
  chips: document.getElementById('chips'),
  err: document.getElementById('err'),
  list: document.getElementById('list'),
  dnd: document.getElementById('dnd'),
  intervalSeg: document.getElementById('intervalSeg'),
  check: document.getElementById('check'),
  readAll: document.getElementById('readAll'),
  more: document.getElementById('more'),
  all: document.getElementById('all'),
  foot: document.getElementById('foot')
};

let settings = null;

function send(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(msg, function (resp) {
      resolve(resp || {});
    });
  });
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

function clock(ms) {
  const d = new Date(ms);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function initial(name) {
  const s = String(name || '').trim();
  return s ? s.slice(0, 1).toUpperCase() : '·';
}

/* 分类统计：把站点的十几个类型收成四类 */
const BY_TYPE = {
  reply: ['REPLY_CREATED', 'WORK_COMMENT_CREATED', 'WORK_COMMENT_REPLY_CREATED'],
  mention: ['USER_MENTIONED', 'WORK_COMMENT_MENTIONED'],
  like: ['POST_LIKED', 'WORK_LIKED', 'WORK_COMMENT_LIKED'],
  follow: ['USER_FOLLOWED']
};
const LABEL = { reply: '回复', mention: '@我', like: '赞', follow: '关注', system: '系统' };

function renderChips(byType) {
  el.chips.innerHTML = '';
  if (!byType || typeof byType !== 'object') return;
  const bits = [];
  let system = 0;
  Object.keys(byType).forEach(function (k) {
    const n = Number(byType[k]) || 0;
    if (!n) return;
    let hit = null;
    Object.keys(BY_TYPE).forEach(function (g) {
      if (BY_TYPE[g].indexOf(k) >= 0) hit = g;
    });
    if (hit && bits.indexOf(hit) < 0) bits.push(hit);
    if (!hit) system += n;
  });
  const fixed = [];
  ['reply', 'mention', 'like', 'follow'].forEach(function (g) {
    if (bits.indexOf(g) < 0) return;
    let sum = 0;
    BY_TYPE[g].forEach(function (t) { sum += Number(byType[t]) || 0; });
    if (sum) fixed.push(LABEL[g] + ' ' + sum);
  });
  if (system) fixed.push(LABEL.system + ' ' + system);
  fixed.forEach(function (t) {
    const c = document.createElement('span');
    c.className = 'chip';
    c.textContent = t;
    el.chips.appendChild(c);
  });
}

function itemRow(it) {
  const row = document.createElement('div');
  row.className = 'feed-item';
  row.title = '打开这条内容';

  const ava = document.createElement('div');
  ava.className = 'ava';
  if (it.avatar) {
    const img = document.createElement('img');
    img.src = it.avatar;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.onerror = function () { ava.textContent = initial(it.actor); };
    ava.appendChild(img);
  } else {
    ava.textContent = initial(it.actor);
  }

  const main = document.createElement('div');
  main.className = 'item-main';

  const t = document.createElement('div');
  t.className = 'item-t';
  if (it.actor) {
    const b = document.createElement('b');
    b.textContent = it.actor;
    t.appendChild(b);
    t.appendChild(document.createTextNode(' ' + (it.action || '有新动态')));
  } else {
    t.textContent = it.action || '有新动态';
  }
  main.appendChild(t);

  const detail = it.title || it.excerpt;
  if (detail) {
    const d = document.createElement('div');
    d.className = 'item-d';
    d.textContent = it.title ? '《' + it.title + '》' + (it.excerpt ? ' · ' + it.excerpt : '') : it.excerpt;
    main.appendChild(d);
  }

  const go = document.createElement('div');
  go.className = 'item-go';
  go.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';

  row.appendChild(ava);
  row.appendChild(main);
  row.appendChild(go);

  row.addEventListener('click', function () {
    if (it.url) send({ type: 'PC_OPEN_URL', url: it.url });
  });

  return row;
}

function markSeg(node, val) {
  if (!node) return;
  Array.prototype.forEach.call(node.children, function (b) {
    b.setAttribute('data-on', String(b.dataset.v) === String(val) ? '1' : '0');
  });
}

function dndActive(s) {
  if (!s || !s.dndEnabled) return false;
  const toMin = function (v) {
    const p = String(v || '').split(':');
    const h = Number(p[0]);
    const m = Number(p[1]);
    if (isNaN(h) || isNaN(m)) return null;
    return h * 60 + m;
  };
  const a = toMin(s.dndStart);
  const b = toMin(s.dndEnd);
  if (a == null || b == null || a === b) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

function render(payload) {
  const s = payload.settings || {};
  const state = payload.state || {};
  settings = s;

  el.sw.classList.toggle('on', !!s.enabled);
  markSeg(el.intervalSeg, s.intervalMin || 1);

  const count = Number(state.unread) || 0;
  el.unread.textContent = count > 99 ? '99+' : String(count);

  el.tag.classList.toggle('bad', !!(state.error || state.loggedOut));
  if (!s.enabled) {
    el.tag.textContent = '已关闭';
  } else if (state.loggedOut) {
    el.tag.textContent = '未登录';
  } else if (state.error) {
    el.tag.textContent = '异常';
  } else if (state.lastCheck) {
    el.tag.textContent = '已连接';
  } else {
    el.tag.textContent = '待检查';
  }

  const bits = [];
  if (state.lastCheck) bits.push('上次 ' + clock(state.lastCheck));
  bits.push('每 ' + (s.intervalMin || 1) + ' 分钟');
  el.meta.textContent = bits.join(' · ');

  renderChips(state.byType);

  el.err.textContent = state.error
    ? (state.loggedOut ? '先在浏览器里登录 Pickcat，再点立即检查' : state.error)
    : '';

  el.dnd.textContent = dndActive(s)
    ? '免打扰时段内：只记未读，不弹通知'
    : (s.dndEnabled ? '免打扰 ' + (s.dndStart || '') + '–' + (s.dndEnd || '') : '');

  const recent = Array.isArray(state.recent) ? state.recent.slice(0, 3) : [];
  el.list.innerHTML = '';
  if (!recent.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.lastCheck && !state.error ? '没有新消息' : '点下面的「立即检查」试一下';
    el.list.appendChild(empty);
  } else {
    recent.forEach(function (it) { el.list.appendChild(itemRow(it)); });
  }
}

async function pull() {
  const resp = await send({ type: 'PC_STATE' });
  render(resp);
}

el.sw.addEventListener('click', async function () {
  const next = !(settings && settings.enabled);
  el.sw.classList.toggle('on', next);
  const resp = await send({ type: 'PC_SAVE', patch: { enabled: next } });
  render(resp);
});

el.intervalSeg.addEventListener('click', async function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  markSeg(el.intervalSeg, b.dataset.v);
  const resp = await send({ type: 'PC_SAVE', patch: { intervalMin: Number(b.dataset.v) } });
  render(resp);
});

el.check.addEventListener('click', async function () {
  el.check.disabled = true;
  el.check.textContent = '检查中…';
  const resp = await send({ type: 'PC_CHECK_NOW' });
  if (resp.state) render({ settings: settings, state: resp.state });
  else await pull();
  el.check.disabled = false;
  el.check.textContent = '立即检查';
});

el.readAll.addEventListener('click', async function () {
  el.readAll.disabled = true;
  el.readAll.textContent = '处理中…';
  const resp = await send({ type: 'PC_MARK_READ' });
  el.readAll.disabled = false;
  if (!resp.ok) {
    el.readAll.textContent = '失败';
    el.err.textContent = resp.error || '标记已读失败';
    setTimeout(function () { el.readAll.textContent = '全部已读'; }, 2200);
    return;
  }
  el.readAll.textContent = '已读';
  setTimeout(function () { el.readAll.textContent = '全部已读'; }, 1600);
  await pull();
});

el.more.addEventListener('click', function () {
  send({ type: 'PC_OPEN_OPTIONS' });
});

el.all.addEventListener('click', function () {
  send({ type: 'PC_OPEN_URL', url: 'https://pickcat.dao3.fun/notifications' });
});

/* 每次打开弹窗顺便检查一次，看到的就是当下状态 */
(async function init() {
  await pull();
  const resp = await send({ type: 'PC_CHECK_NOW' });
  if (resp.state) render({ settings: settings, state: resp.state });
})();
