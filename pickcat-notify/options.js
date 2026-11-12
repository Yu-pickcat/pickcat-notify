/* 设置页：保存配置 + 后台体检 + 关页验证 */

const MODE_DESC = {
  smart: '智能：自动挑最省的办法——你先开着 Pickcat 页面就直接读它；没开就直连接口（一个页面都不开）；直连还读不到才建一个最小化的后台页兜底；兜底也不成，就报错告诉你原因',
  page: '只读已开页面：只读你自己打开的那个 Pickcat 页面，一个页面都不新建；没开就直接报错',
  direct: '只直连：什么页面都不开，最省资源；读不到（比如跨站 Cookie 带不上）就报未登录',
  window: '后台页兜底：一直在最小化的后台页里读，最稳，但会占一个后台小窗'
};

const VIA = { page: '已打开的页面', direct: '直连接口', window: '后台页面' };

const MODE_NAME = { smart: '智能', page: '只读已开页面', direct: '只直连', window: '后台页兜底' };
const MODE_SHORT = { page: '只读已开页面', direct: '只直连', window: '后台页' };

const el = {
  ver: document.getElementById('ver'),
  notifyDeps: document.getElementById('notifyDeps'),
  intervalSeg: document.getElementById('intervalSeg'),
  modeSeg: document.getElementById('modeSeg'),
  modeOther: document.getElementById('modeOther'),
  modeMask: document.getElementById('modeMask'),
  modeBack: document.getElementById('modeBack'),
  modeApply: document.getElementById('modeApply'),
  modeDesc: document.getElementById('modeDesc'),
  maxSeg: document.getElementById('maxSeg'),
  swNotify: document.getElementById('swNotify'),
  swBadge: document.getElementById('swBadge'),
  swSound: document.getElementById('swSound'),
  swMention: document.getElementById('swMention'),
  swReply: document.getElementById('swReply'),
  swLike: document.getElementById('swLike'),
  swSystem: document.getElementById('swSystem'),
  swDnd: document.getElementById('swDnd'),
  dndBox: document.getElementById('dndBox'),
  dndStart: document.getElementById('dndStart'),
  dndEnd: document.getElementById('dndEnd'),
  diag: document.getElementById('diag'),
  checkNow: document.getElementById('checkNow'),
  test: document.getElementById('test'),
  openSite: document.getElementById('openSite'),
  openWelcome: document.getElementById('openWelcome'),
  closeHelper: document.getElementById('closeHelper'),
  closedTest: document.getElementById('closedTest')
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

function stepText(min) {
  const m = Number(min) || 1;
  return m < 1 ? Math.round(m * 60) + ' 秒' : Math.round(m) + ' 分钟';
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
  const mode = s.mode || 'smart';
  const chain = (Array.isArray(s.chain) && s.chain.length) ? s.chain : ['page', 'direct', 'window'];
  markSeg(el.modeSeg, mode === 'smart' ? 'smart' : '');
  el.modeOther.textContent = mode === 'smart'
    ? '其他方式…'
    : (mode === 'custom' ? '自定义：' + chain.map(function (k) { return MODE_SHORT[k] || k; }).join(' → ') + ' · 改' : MODE_NAME[mode] + ' · 改');
  markSeg(el.maxSeg, s.notifyMax || 3);
  el.modeDesc.textContent = mode === 'custom'
    ? '自定义顺序：' + chain.map(function (k, i) { return (i + 1) + '. ' + MODE_NAME[k]; }).join('　') + '；前一步没成就试下一步'
    : MODE_DESC[mode];
  el.notifyDeps.classList.toggle('off', !s.notify);
  el.swNotify.classList.toggle('on', !!s.notify);
  el.swBadge.classList.toggle('on', !!s.badge);
  el.swSound.classList.toggle('on', !!s.sound);
  const nt = Object.assign({ mention: true, reply: true, like: true, system: true }, s.notifyTypes || {});
  el.swMention.classList.toggle('on', nt.mention !== false);
  el.swReply.classList.toggle('on', nt.reply !== false);
  el.swLike.classList.toggle('on', nt.like !== false);
  el.swSystem.classList.toggle('on', nt.system !== false);
  el.swDnd.classList.toggle('on', !!s.dndEnabled);
  el.dndBox.classList.toggle('show', !!s.dndEnabled);
  el.dndStart.value = s.dndStart || '22:30';
  el.dndEnd.value = s.dndEnd || '07:00';
}

function renderDiag(d) {
  const s = d.state || {};
  const alarm = d.alarm;
  const lines = [];

  if (alarm) {
    const want = Number(alarm.want) || Number(alarm.period);
    const fast = want < Number(alarm.period);
    const eff = fast ? want : Number(alarm.period);
    lines.push(row('ok', '定时任务', '运行中 · 每 ' + stepText(eff)
      + (fast ? '（计时器执行，闹钟 ' + stepText(alarm.period) + ' 兜底）' : '')
      + ' · 下次 ' + clock(alarm.when)));
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

  if (d.helperTab != null) {
    lines.push(row('ok', '后台页面', '兜底页已建好（最小化，不进标签栏）'));
  } else if (d.helper != null) {
    lines.push(row('ok', '后台页面', '兜底页已建好（窗口 ' + d.helper + '，最小化）'));
  } else {
    lines.push(row('', '后台页面', '还没建过（只有直连读不到时才会建）'));
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

/* 快捷档 */
el.intervalSeg.addEventListener('click', function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  markSeg(el.intervalSeg, b.dataset.v);
  save({ intervalMin: Number(b.dataset.v) });
});

/* 检查方式：默认「智能」，其他方式收在弹窗里，可以勾几个、按勾的先后排顺序 */
el.modeSeg.addEventListener('click', function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  save({ mode: b.dataset.v });
});

let pick = [];

function renderPick() {
  Array.prototype.forEach.call(el.modeMask.querySelectorAll('.pick'), function (b) {
    const idx = pick.indexOf(b.dataset.v);
    b.classList.toggle('on', idx >= 0);
    const ord = b.querySelector('.ord');
    if (ord) ord.textContent = idx >= 0 ? String(idx + 1) : '';
  });
  el.modeApply.textContent = pick.length === 3 ? '全勾了，就是智能' : (pick.length ? '用这套顺序' : '先勾一个');
}

function openMask() {
  const s = settings || {};
  const mode = s.mode || 'smart';
  if (mode === 'custom' && Array.isArray(s.chain)) pick = s.chain.slice();
  else if (mode === 'smart') pick = ['page', 'direct', 'window'];
  else pick = [mode];
  renderPick();
  el.modeMask.classList.add('show');
}
function closeMask() { el.modeMask.classList.remove('show'); }

el.modeOther.addEventListener('click', openMask);
el.modeMask.addEventListener('click', function (e) {
  if (e.target === el.modeMask) { closeMask(); return; }
  const b = e.target.closest('.pick');
  if (!b) return;
  const v = b.dataset.v;
  const i = pick.indexOf(v);
  if (i >= 0) pick.splice(i, 1); else pick.push(v);
  renderPick();
});
el.modeApply.addEventListener('click', function () {
  if (!pick.length) return;
  const chain = pick.slice();
  closeMask();
  save({ chain: chain });
});
el.modeBack.addEventListener('click', function () {
  closeMask();
  save({ mode: 'smart' });
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeMask();
});

el.maxSeg.addEventListener('click', function (e) {
  const b = e.target.closest('button');
  if (!b || !b.dataset.v) return;
  markSeg(el.maxSeg, b.dataset.v);
  save({ notifyMax: Number(b.dataset.v) });
});

[['swNotify', 'notify'], ['swBadge', 'badge'], ['swSound', 'sound']]
  .forEach(function (pair) {
    const node = el[pair[0]];
    node.addEventListener('click', function () {
      const next = !node.classList.contains('on');
      node.classList.toggle('on', next);
      const patch = {};
      patch[pair[1]] = next;
      save(patch);
    });
  });

/* 四类消息单独开 / 关 */
[['swMention', 'mention'], ['swReply', 'reply'], ['swLike', 'like'], ['swSystem', 'system']]
  .forEach(function (pair) {
    const node = el[pair[0]];
    node.addEventListener('click', function () {
      const next = !node.classList.contains('on');
      node.classList.toggle('on', next);
      const nt = Object.assign({ mention: true, reply: true, like: true, system: true }, (settings && settings.notifyTypes) || {});
      nt[pair[1]] = next;
      save({ notifyTypes: nt });
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

const mf = chrome.runtime.getManifest();
el.ver.textContent = mf.version_name || ('v' + mf.version);

refreshDiag();
setInterval(refreshDiag, 5000);
