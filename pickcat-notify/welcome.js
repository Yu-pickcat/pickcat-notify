/* 引导页：显示当前状态，不重复发测试通知 */

const el = {
  status: document.getElementById('status'),
  check: document.getElementById('check'),
  login: document.getElementById('login'),
  close: document.getElementById('close')
};

const VIA = { direct: '直连接口', window: '后台页面' };

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

function line(dot, key, value) {
  return '<span class="dot ' + dot + '"></span><span class="k">' + key + '</span>' + value;
}

function render(d) {
  const s = (d && d.state) || {};
  const alarm = d && d.alarm;
  const lines = [];

  if (!s.lastCheck) {
    lines.push(line('', '检查', '还没有记录'));
  } else if (s.error) {
    lines.push(line('bad', '检查', s.error));
  } else {
    lines.push(line('ok', '检查', clock(s.lastCheck) + ' 正常 · 读到 <b>' + (s.unread || 0) + '</b> 条未读'
      + (s.via ? ' · ' + (VIA[s.via] || s.via) : '')));
  }

  if (alarm) {
    lines.push(line('ok', '定时任务', '运行中 · 每 ' + Math.round(alarm.period) + ' 分钟'));
  } else {
    lines.push(line('bad', '定时任务', '没在运行（总开关可能关着）'));
  }

  el.status.innerHTML = lines.join('<br>');
}

async function pull() {
  const d = await send({ type: 'PC_DIAG' });
  render(d);
}

el.check.addEventListener('click', async function () {
  el.check.disabled = true;
  el.check.textContent = '检查中…';
  const resp = await send({ type: 'PC_CHECK_NOW' });
  render({ state: resp.state, alarm: null });
  await pull();
  el.check.disabled = false;
  el.check.textContent = '立即检查';
});

el.login.addEventListener('click', function () {
  send({ type: 'PC_OPEN' });
});

el.close.addEventListener('click', function () {
  window.close();
});

pull();
setInterval(pull, 4000);
