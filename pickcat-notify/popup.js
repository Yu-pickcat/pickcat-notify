/* 工具栏弹窗：状态 + 最新动态 + 常用操作 */

const el = {
  sw: document.getElementById('sw'),
  ver: document.getElementById('ver'),
  unread: document.getElementById('unread'),
  tag: document.getElementById('tag'),
  meta: document.getElementById('meta'),
  err: document.getElementById('err'),
  list: document.getElementById('list'),
  intervalSeg: document.getElementById('intervalSeg'),
  check: document.getElementById('check'),
  markAll: document.getElementById('markAll'),
  more: document.getElementById('more'),
  all: document.getElementById('all')
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

function itemRow(it) {
  const row = document.createElement('div');
  row.className = 'feed-item';

  const ava = document.createElement('div');
  ava.className = 'ava';
  if (it.avatar) {
    const img = document.createElement('img');
    img.src = it.avatar;
    img.alt = '';
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
  bits.push('每 ' + ((Number(s.intervalMin) || 1) < 1 ? Math.round((Number(s.intervalMin) || 1) * 60) + ' 秒' : (Number(s.intervalMin) || 1) + ' 分钟'));
  el.meta.textContent = bits.join(' · ');

  el.err.textContent = state.error
    ? (state.loggedOut ? '先在浏览器里登录 Pickcat，再点立即检查' : state.error)
    : '';

  const recent = Array.isArray(state.recent) ? state.recent : [];
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
  chrome.tabs.create({ url: 'https://pickcat.dao3.fun/notifications' });
});

if (el.ver) {
  const mf = chrome.runtime.getManifest();
  el.ver.textContent = mf.version_name || ('v' + mf.version);
}

pull();
