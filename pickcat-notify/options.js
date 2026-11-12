/* 设置页：保存配置 + 后台体检 + 关页验证 */

const MODE_DESC = {
  smart: '智能：先直连接口；读不到时借你已打开的 Pickcat 页面读（不弹窗、不开新页面）',
  direct: '只直连接口：一个页面都不开，最省资源',
  window: '只用后台页面：只借你已打开的 Pickcat 页面读（不弹窗、不开新页面）'
};

const VIA = { direct: '直连接口', window: '后台页面' };

const el = {
  ver: document.getElementById('ver'),
  intervalSeg: document.getElementById('intervalSeg'),
  modeSeg: document.getElementById('modeSeg'),
  modeDesc: document.getElementById('modeDesc'),
  swNotify: document.getElementById('swNotify'),
  swBadge: document.getElementById('swBadge'),
  swSound: document.getElementById('swSound'),
  swOpen: document.getElementById('swOpen'),
  swDnd: document.getElementById('swDnd'),
  swReply: document.getElementById('swReply'),
  swMention: document.getElementById('swMention'),
  swLike: document.getElementById('swLike'),
  swSystem: document.getElementById('swSystem'),
  swGroup: document.getElementById('swGroup'),
  dndBox: document.getElementById('dndBox'),
  dndStart: document.getElementById('dndStart'),
  dndEnd: document.getElementById('dndEnd'),
  diag: document.getElementById('diag'),
  checkNow: document.getElementById('checkNow'),
  test: document.getElementById('test'),
  openSite: document.getElementById('openSite'),
  openWelcome: document.getElementById('openWelcome'),
  closeHelper: document.getElementById('closeHelper'),
  closedTest: document.getElementById('closedTest'),
  readAll: document.getElementById('readAll')
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
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function row(dot, key, value) {
  return '<span class="dot ' + dot + '"></span><span class="k">' + key + '</span>' + value;
}

function markSeg(node, val) {
  if (!node) return;
  Array.prototype.forEach.call(node.children, function (b) {
    b.setAttribute('data-on', String(b.dataset.v) === String(val) ? '1' : '0');
  });
}

function renderSettings(s) {
  settings = s;
  markSeg(el.intervalSeg, s.intervalMin || 1);
  markSeg(el.modeSeg, s.mode || 'smart');
  el.modeDesc.textContent = MODE_DESC[s.mode || 'smart'];
  el.swNotify.classList.toggle('on', !!s.notify);
  el.swBadge.classList.toggle('on', !!s.badge);
  el.swSound.classList.toggle('on', !!s.sound);
  el.swOpen.classList.toggle('on', !!s.openNotify);
  el.swDnd.classList.toggle('on', !!s.dndEnabled);
  el.swReply.classList.toggle('on', s.notifyReply !== false);
  el.swMention.classList.toggle('on', s.notifyMention !== false);
  el.swLike.classList.toggle('on', s.notifyLike !== false);
  el.swSystem.classList.toggle('on', s.notifySystem !== false);
  el.swGroup.classList.toggle('on', s.groupLikes !== false);
  el.dndBox.classList.toggle('show', !!s.dndEnabled);
  el.dndStart.value = s.dndStart || '22:30';
  el.dndEnd.value = s.dndEnd || '07:00';
}

function renderDiag(d) {
  const s = d.state || {};
  const alarm = d.alarm;
  const lines = [];

  if (d.version) el.ver.textContent = 'v' + d.version;

  if (alarm) {
    lines.push(row('ok', '定时任务', '运行中 · 每 ' + Math.round(alarm.period) + ' 分钟 · 下次 ' + clock(alarm.when)));
  } else {
    lines.push(row('bad', '定时任务', '没有注册（总开关可能关着）'));
  }

  if (s.lastCheck) {
    lines.push(row(s.error ? 'bad' : 'ok', '最近检查', clock(s.lastCheck) + ' · 读到 <b>' + (s.unread || 0) + '</b> 条未读'));
    if (s.via) lines.push(row('ok', '读取方式', VIA[s.via] || s.via));
  } else {
    lines.push(row('', '最近检查', '还没检查过'));
  }

  if (s.error) {
    lines.push(row('bad', '错误', s.error));
  }

  if (d.canBadge === false) {
    lines.push(row('bad', '图标角标', '当前浏览器没有 action/ browserAction 接口'));
  }

  if (d.helperTab != null) {
    lines.push(row('ok', '后台页面', '已就绪'));
  } else if (d.helper != null) {
    lines.push(row('ok', '后台页面', '已就绪（窗口 ' + d.helper + '）'));
  }

  el.diag.innerHTML = lines.join('<br>');
}

async function refreshDiag() {
  const d = await send({ type: 'PC_DIAG' });
  if (d.settings) renderSettings(d.settings);
  renderDiag(d);
  return d;
}

async function save(patch) {
  const resp = await send({ type: 'PC_SAVE', patch: patch });
  if (resp.settings) renderSettings(resp.settings);
  await refreshDiag();
}

el.intervalSeg.addEventListener('click', function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  markSeg(el.intervalSeg, b.dataset.v);
  save({ intervalMin: Number(b.dataset.v) });
});

el.modeSeg.addEventListener('click', function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  markSeg(el.modeSeg, b.dataset.v);
  save({ mode: b.dataset.v });
});

[['swNotify', 'notify'], ['swBadge', 'badge'], ['swSound', 'sound'], ['swOpen', 'openNotify'],
 ['swReply', 'notifyReply'], ['swMention', 'notifyMention'], ['swLike', 'notifyLike'],
 ['swSystem', 'notifySystem'], ['swGroup', 'groupLikes']]
  .forEach(function (pair) {
    const node = el[pair[0]];
    if (!node) return;
    node.addEventListener('click', function () {
      const next = !node.classList.contains('on');
      node.classList.toggle('on', next);
      const patch = {};
      patch[pair[1]] = next;
      save(patch);
    });
  });

el.swDnd.addEventListener('click', function () {
  const next = !el.swDnd.classList.contains('on');
  el.swDnd.classList.toggle('on', next);
  el.dndBox.classList.toggle('show', next);
  save({ dndEnabled: next });
});

el.dndStart.addEventListener('change', function () { save({ dndStart: el.dndStart.value }); });
el.dndEnd.addEventListener('change', function () { save({ dndEnd: el.dndEnd.value }); });

el.checkNow.addEventListener('click', async function () {
  el.checkNow.disabled = true;
  el.checkNow.textContent = '检查中…';
  await send({ type: 'PC_CHECK_NOW' });
  await refreshDiag();
  el.checkNow.disabled = false;
  el.checkNow.textContent = '立即检查';
});

el.test.addEventListener('click', function () { send({ type: 'PC_TEST' }); });
el.openSite.addEventListener('click', function () { send({ type: 'PC_OPEN' }); });
el.openWelcome.addEventListener('click', function () { send({ type: 'PC_OPEN_WELCOME' }); });

el.closeHelper.addEventListener('click', async function () {
  await send({ type: 'PC_CLOSE_HELPER' });
  await refreshDiag();
});

el.readAll.addEventListener('click', async function () {
  el.readAll.disabled = true;
  el.readAll.textContent = '处理中…';
  const resp = await send({ type: 'PC_MARK_READ' });
  el.readAll.disabled = false;
  el.readAll.textContent = resp.ok ? '已标为已读' : '失败：' + (resp.error || '未知原因');
  setTimeout(function () { el.readAll.textContent = '全部标为已读'; }, 2400);
  await refreshDiag();
});

el.closedTest.addEventListener('click', async function () {
  el.closedTest.disabled = true;
  el.closedTest.textContent = '关页并检查中…';
  const resp = await send({ type: 'PC_CLOSED_PAGE_TEST' });
  el.closedTest.disabled = false;
  el.closedTest.textContent = '关掉所有 Pickcat 页面后测试';

  const r = resp.result || {};
  const head = row('', '关掉页面', '已关闭 <b>' + (resp.closed || 0) + '</b> 个 Pickcat 页面');
  const body = r.ok
    ? row('ok', '结果', '照常读到 <b>' + (r.count || 0) + '</b> 条未读 · 方式：' + (VIA[r.via] || r.via || '—'))
    : row('bad', '结果', r.error || '未知原因');
  el.diag.innerHTML = head + '<br>' + body;
  setTimeout(refreshDiag, 6000);
});

refreshDiag();
setInterval(refreshDiag, 5000);
