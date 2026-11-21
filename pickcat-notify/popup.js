/* 工具栏弹窗：状态 + 最新动态 + 常用操作 */

const el = {
  sw: document.getElementById('sw'),
  ver: document.getElementById('ver'),
  unread: document.getElementById('unread'),
  tag: document.getElementById('tag'),
  meta: document.getElementById('meta'),
  err: document.getElementById('err'),
  list: document.getElementById('list'),
  chips: document.getElementById('chips'),
  intervalSeg: document.getElementById('intervalSeg'),
  check: document.getElementById('check'),
  markAll: document.getElementById('markAll'),
  more: document.getElementById('more'),
  all: document.getElementById('all'),
  updText: document.getElementById('updText'),
  updDo: document.getElementById('updDo')
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

const CAT_NAME = { mention: '@我', reply: '回复', like: '赞', system: '系统' };

/* 最近一次拿到的动态 + 当前筛选（重开弹窗还记着上次选的分类） */
let lastRecent = [];
let lastEmptyTip = '点下面的「立即检查」试一下';
let filter = 'all';
try { filter = localStorage.getItem('pcFilter') || 'all'; } catch (e) { filter = 'all'; }

function markChips() {
  if (!el.chips) return;
  const n = { all: lastRecent.length };
  lastRecent.forEach(function (it) {
    if (it.category) n[it.category] = (n[it.category] || 0) + 1;
  });
  Array.prototype.forEach.call(el.chips.children, function (b) {
    const f = b.dataset.f;
    b.classList.toggle('on', f === filter);
    const label = b.dataset.label || f;
    /* 分类按钮后面跟一条数量，0 就不显示，免得一排都是 0 */
    b.textContent = (f !== 'all' && n[f]) ? label + ' ' + n[f] : label;
  });
}

/* 打开站内消息中心，能带上分类 tab 就直接带过去 */
function openCenter(f) {
  let url = 'https://pickcat.dao3.fun/notifications';
  if (f && f !== 'all') url += '?tab=' + f;
  chrome.tabs.create({ url: url });
}

function paintFeed() {
  if (!el.list) return;
  const src = lastRecent || [];
  const shown = filter === 'all' ? src : src.filter(function (it) { return it.category === filter; });
  el.list.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = src.length
      ? '最近 ' + src.length + ' 条里没有「' + (CAT_NAME[filter] || filter) + '」这类消息'
      : lastEmptyTip;
    if (src.length) {
      const go = document.createElement('button');
      go.className = 'go';
      go.textContent = '去消息中心看全部 →';
      go.addEventListener('click', function () { openCenter(filter); });
      empty.appendChild(document.createElement('br'));
      empty.appendChild(go);
    }
    el.list.appendChild(empty);
    return;
  }
  shown.forEach(function (it) { el.list.appendChild(itemRow(it)); });
}

function itemRow(it) {
  const row = document.createElement('div');
  row.className = 'feed-item';

  /* 有帖子标识的动态，整行可点，直达对应帖子那一楼 */
  if (it.topicId) {
    row.className = 'feed-item clickable';
    row.title = '查看帖子' + (it.floor ? '第 ' + it.floor + ' 楼' : '');
    row.addEventListener('click', function () {
      send({ type: 'PC_OPEN_POST', topicId: it.topicId, floor: it.floor });
    });
  }

  const ava = document.createElement('div');
  ava.className = 'ava';
  if (it.avatar) {
    const img = document.createElement('img');
    img.alt = '';
    let settled = false;
    const fallback = function () {
      if (settled) return;
      settled = true;
      ava.textContent = initial(it.actor);
    };
    img.onerror = fallback;
    ava.appendChild(img);
    /* 头像被站点 CORP 限制跨源直连，由后台抓成 data URL 再渲染 */
    send({ type: 'PC_AVATAR', url: it.avatar }).then(function (r) {
      if (settled) return;
      if (r && r.data) {
        img.src = r.data;
      } else {
        fallback();
      }
    }).catch(fallback);
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
  if (it.category && CAT_NAME[it.category]) {
    const tag = document.createElement('span');
    tag.className = 'cat';
    tag.textContent = CAT_NAME[it.category];
    t.appendChild(tag);
  }

  main.appendChild(t);

  const topic = it.topicTitle || it.excerpt;
  if (topic) {
    const d = document.createElement('div');
    d.className = 'item-d';
    d.textContent = topic;
    main.appendChild(d);
  }

  const metaBits = [];
  if (it.floor) metaBits.push('第 ' + it.floor + ' 楼');
  if (it.ts) metaBits.push(clock(it.ts));
  if (metaBits.length) {
    const m = document.createElement('div');
    m.className = 'item-meta';
    m.textContent = metaBits.join(' · ');
    main.appendChild(m);
  }

  row.appendChild(ava);
  row.appendChild(main);
  return row;
}

function markSeg(node, val) {
  if (!node) return;
  Array.prototype.forEach.call(node.children, function (b) {
    b.setAttribute('data-on', String(b.dataset.v) === String(val) ? '1' : '0');
  });
}

function render(payload) {
  const s = payload.settings || {};
  const state = payload.state || {};
  settings = s;

  el.sw.classList.toggle('on', !!s.enabled);
  markSeg(el.intervalSeg, s.intervalMin || 1);

  const count = Number(state.unread) || 0;
  el.unread.textContent = count > 99 ? '99+' : String(count);
  el.unread.classList.toggle('hot', count > 0);

  el.tag.className = 'stat-tag';
  if (!s.enabled) {
    el.tag.textContent = '已关闭';
  } else if (state.loggedOut) {
    el.tag.textContent = '未登录';
    el.tag.classList.add('warn');
  } else if (state.error) {
    el.tag.textContent = '异常';
    el.tag.classList.add('warn');
  } else if (state.lastCheck) {
    el.tag.textContent = '已连接';
    el.tag.classList.add('ok');
  } else {
    el.tag.textContent = '待检查';
  }

  const bits = [];
  if (state.lastCheck) bits.push('上次 ' + clock(state.lastCheck));
  bits.push('每 ' + ((Number(s.intervalMin) || 1) < 1 ? Math.round((Number(s.intervalMin) || 1) * 60) + ' 秒' : (Number(s.intervalMin) || 1) + ' 分钟'));
  el.meta.textContent = bits.join(' · ');

  el.err.textContent = state.error
    ? (state.loggedOut ? '先在浏览器里登录 Pickcat，再点立即检查' : state.error)
    : '';

  const recent = Array.isArray(state.recent) ? state.recent : [];
  lastRecent = recent;
  lastEmptyTip = (state.lastCheck && !state.error) ? '没有新消息' : '点下面的「立即检查」试一下';
  markChips();
  paintFeed();
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

/* 按类型筛选最近几条，纯前端过滤，不额外请求站点 */
if (el.chips) {
  el.chips.addEventListener('click', function (e) {
    const b = e.target.closest('button');
    if (!b || !b.dataset.f) return;
    filter = b.dataset.f;
    try { localStorage.setItem('pcFilter', filter); } catch (err) {}
    markChips();
    paintFeed();
  });
}

el.check.addEventListener('click', async function () {
  el.check.disabled = true;
  el.check.textContent = '检查中…';
  await send({ type: 'PC_CHECK_NOW' });
  await pull();
  el.check.disabled = false;
  el.check.textContent = '立即检查';
});

el.markAll.addEventListener('click', async function () {
  el.markAll.disabled = true;
  el.markAll.textContent = '标记中…';
  const r = await send({ type: 'PC_MARK_ALL_READ' });
  el.markAll.disabled = false;
  el.markAll.textContent = r && r.ok ? '已全部已读' : '全部已读';
  await pull();
  if (!r || !r.ok) el.err.textContent = (r && r.error) || '标记失败，先登录 Pickcat 试试';
  setTimeout(function () { el.markAll.textContent = '全部已读'; }, 2200);
});

el.more.addEventListener('click', function () {
  send({ type: 'PC_OPEN_OPTIONS' });
});

el.all.addEventListener('click', function () {
  openCenter(filter);
});

if (el.ver) {
  const mf = chrome.runtime.getManifest();
  el.ver.textContent = mf.version_name || ('v' + mf.version);
}

/* 弹窗底部一行：查有没有新版本，有新版本直接给「去下载」 */
let updLatest = null;

if (el.updDo) {
  el.updDo.addEventListener('click', async function () {
    if (updLatest) {
      chrome.tabs.create({ url: updLatest });
      return;
    }
    el.updDo.textContent = '检查中…';
    const r = await send({ type: 'PC_CHECK_UPDATE' });
    if (!r || !r.local) {
      el.updDo.textContent = '检查失败，点重试';
      return;
    }
    if (r.hasNew) {
      updLatest = r.url || ('https://github.com/Yu-pickcat/pickcat-notify/releases/tag/v' + r.latest + '-beta');
      el.updDo.textContent = '有新版 v' + r.latest + ' · 去下载';
      el.updDo.classList.add('new');
      return;
    }
    el.updDo.textContent = '已是最新（v' + r.local + '）';
    setTimeout(function () { el.updDo.textContent = '检查更新'; }, 2200);
  });
}

pull();
