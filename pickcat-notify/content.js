/* 运行在 Pickcat 页面里：用页面自身的登录状态读取未读数，供后台取用 */

const SUMMARY_URL = '/api/v1/notification-summary';
const LIST_URL = '/api/v1/notifications?limit=15';
const ALL_URL = '/api/v1/notifications';

async function readUnread() {
  let sumRes = null;
  try {
    sumRes = await fetch(SUMMARY_URL, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store'
    });
  } catch (e) {
    return { ok: false, error: '网络错误：' + String(e) };
  }

  if (!sumRes.ok) {
    return { ok: false, status: sumRes.status };
  }

  let summary = null;
  try {
    summary = await sumRes.json();
  } catch (e) {
    return { ok: false, error: '返回内容不是 JSON' };
  }

  let items = [];
  try {
    const listRes = await fetch(LIST_URL, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store'
    });
    if (listRes.ok) {
      const listJson = await listRes.json();
      items = listJson.items || (listJson.data && listJson.data.items) || [];
    }
  } catch (e) {
    items = [];
  }

  return {
    ok: true,
    count: Number(summary && summary.unreadCount) || 0,
    byType: (summary && summary.unreadCountByType) || null,
    items: items
  };
}

/* 全部标为已读：唯一一个不是 GET 的请求，只在你手动点按钮时才发 */
async function markAllRead() {
  try {
    const res = await fetch(ALL_URL, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ read: true })
    });
    if (!res.ok) return { ok: false, status: res.status };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '网络错误：' + String(e) };
  }
}

/* ---------- 站点皮肤：让 Pickcat 网页自己也穿同一套外观 ----------
   样式在 site-skin.css 里，这里只管何时挂、何时摘。
   设置页「站点外观」的开关关掉，就把这层皮摘掉，页面回到官网原样。 */
const SKIN_ID = 'pcl-skin';
let skinOn = true;

function stripSheets() {
  const list = document.querySelectorAll('.pcl-sheet');
  for (let i = 0; i < list.length; i++) {
    list[i].classList.remove('pcl-sheet', 'pcl-sheet-lg');
    list[i].style.removeProperty('--pcl-ox');
    list[i].style.removeProperty('--pcl-oy');
    list[i].style.removeProperty('--pcl-mx');
    list[i].style.removeProperty('--pcl-my');
  }
}

function applySkin(on) {
  skinOn = !!on;
  const has = document.getElementById(SKIN_ID);
  if (on) {
    if (!has) {
      const link = document.createElement('link');
      link.id = SKIN_ID;
      link.rel = 'stylesheet';
      try {
        link.href = chrome.runtime.getURL('site-skin.css');
        (document.head || document.documentElement).appendChild(link);
      } catch (e) { /* 拿不到扩展地址就只留下面的内联部分 */ }
    }
    paintShell();
    return;
  }
  if (has && has.parentNode) has.parentNode.removeChild(has);
  paintShell(true);
  stripSheets();
}

/* ---------- 结构层：顶栏 / 底栏 ----------
   站点把这两条的几何（top / inset / 圆角 / 底色）写在 Tailwind v4 的 layer 里，
   还带着 !important，从外挂样式表压不过去，落成内联才稳。
   桌面端只做上面那一条，手机端只做下面那一条，各自把对方的内联清干净。 */
const SHELL_PROPS = [
  'top', 'margin', 'border', 'border-radius', 'background', 'background-image',
  'box-shadow', 'left', 'right', 'bottom', 'width',
  '-webkit-backdrop-filter', 'backdrop-filter'
];

function pickHead() {
  const list = document.querySelectorAll('header');
  for (let i = 0; i < list.length; i++) {
    const r = list[i].getBoundingClientRect();
    /* 要里面带链接（论坛/作品/搜索）才是站点顶栏，其它扩展挂的 header 不带这些 */
    if (r.width > 300 && r.height > 40 && r.height < 140 && list[i].querySelector('a[href]')) return list[i];
  }
  return null;
}

function pickBar() {
  const list = document.querySelectorAll('[class*="fixed"][class*="bottom-0"]');
  for (let i = 0; i < list.length; i++) {
    const r = list[i].getBoundingClientRect();
    /* 要里面带导航链接才算站点底栏，别的扩展的悬浮条没有链接，别误伤 */
    if (r.width > 200 && r.height > 30 && r.height < 170 && list[i].querySelector('a[href]')) return list[i];
  }
  return null;
}

function clearShell(el) {
  if (!el) return;
  for (let i = 0; i < SHELL_PROPS.length; i++) el.style.removeProperty(SHELL_PROPS[i]);
}

function paintShell(off) {
  /* 不传 off 时按当前开关走：关着就只做清理，别把顶栏又套回去 */
  off = off || !skinOn;
  const head = pickHead();
  const bar = pickBar();
  const dark = document.documentElement.classList.contains('dark');
  const narrow = window.innerWidth <= 1023;
  const blur = dark ? 'blur(34px) saturate(1.3)' : 'blur(30px) saturate(1.6)';
  const bgBar = dark ? 'rgba(46, 47, 50, .74)' : 'rgba(255, 255, 255, .80)';
  const ring = dark ? 'inset 0 0 0 1px rgba(255, 255, 255, .10)' : 'inset 0 0 0 1px rgba(17, 19, 26, .08)';

  if (head) {
    if (off || narrow) {
      clearShell(head);
    } else {
      head.style.setProperty('top', '10px', 'important');
      head.style.setProperty('margin', '10px 10px 0', 'important');
      head.style.setProperty('border', '0', 'important');
      head.style.setProperty('border-radius', '18px', 'important');
      head.style.setProperty('background', bgBar, 'important');
      head.style.setProperty('background-image', 'none', 'important');
      head.style.setProperty('-webkit-backdrop-filter', blur, 'important');
      head.style.setProperty('backdrop-filter', blur, 'important');
      head.style.setProperty('box-shadow', ring + (dark
        ? ', 0 14px 36px -22px rgba(0, 0, 0, .95)'
        : ', 0 8px 20px -18px rgba(19, 21, 30, .45)'), 'important');
    }
  }

  if (bar) {
    if (off || !narrow) {
      clearShell(bar);
    } else {
      bar.style.setProperty('left', '10px', 'important');
      bar.style.setProperty('right', '10px', 'important');
      bar.style.setProperty('bottom', '10px', 'important');
      bar.style.setProperty('width', 'auto', 'important');
      bar.style.setProperty('border-radius', '22px', 'important');
      bar.style.setProperty('background', bgBar, 'important');
      bar.style.setProperty('background-image', 'none', 'important');
      bar.style.setProperty('-webkit-backdrop-filter', blur, 'important');
      bar.style.setProperty('backdrop-filter', blur, 'important');
      bar.style.setProperty('box-shadow', ring + (dark
        ? ', 0 -14px 36px -22px rgba(0, 0, 0, .95)'
        : ', 0 -14px 30px -22px rgba(19, 21, 30, .35)'), 'important');
    }
  }
}

let shellTimer = 0;
window.addEventListener('resize', function () {
  window.clearTimeout(shellTimer);
  shellTimer = window.setTimeout(function () { paintShell(); }, 180);
}, false);

/* ---------- 站点浮层：跟扩展面板同一套 MagicOS 弹出动作 ----------
   扩展里 .sheet 是从按钮位置长出来的，网页里没有按钮引用，就退一步：
   记下最后一次按下的坐标，等浮层出现时把「缩放原点 + 位移」算好写进去。
   只加 scale / translate / opacity，不接管站点自己的 transform，居中浮层不会被顶歪。 */
function paintMotion() {
  /* 只认站点自己的 Reka 浮层，别去动其它扩展挂出来的 dialog / 菜单。
     站点这套浮层类名都带 --reka- 或 reka- 前缀，原生 <dialog> 不碰。 */
  const SHEET = '[class*="--reka-"], [class*="reka-dialog"], [class*="reka-popover"], [class*="reka-dropdown"], [data-radix-popper-content-wrapper]';
  let px = 0;
  let py = 0;
  let has = false;

  function aim(el, attempt) {
    if (!skinOn) return;
    const n = attempt || 0;
    const r = el.getBoundingClientRect();
    if ((r.width < 8 || r.height < 8) && n < 3) {
      window.requestAnimationFrame(function () { aim(el, n + 1); });
      return;
    }
    let ox = 50;
    let oy = 40;
    let mx = 0;
    let my = 0;
    const huge = (r.width * r.height) > window.innerWidth * window.innerHeight * 0.55 || r.height > window.innerHeight * 0.8;
    if (huge) {
      /* 占掉半屏以上的大模态（等级成长、设置面板）：别跟着点击点从角落张开，那是错位感的主要来源 */
      el.classList.add('pcl-sheet-lg');
    } else if (has && r.width > 0 && r.height > 0) {
      const narrow = window.innerWidth <= 1023;
      /* 移动端：贴底的窗口一律从底边往上长；桌面端：贴底抽屉同样 */
      const isDrawer = narrow
        ? (r.height < window.innerHeight * 0.92 && r.bottom > window.innerHeight * 0.66)
        : (r.bottom >= window.innerHeight - 80 && r.height < window.innerHeight * 0.9);
      if (isDrawer) {
        ox = 50;
        oy = 100;
      } else {
        ox = Math.max(6, Math.min(94, (px - r.left) / r.width * 100));
        oy = Math.max(6, Math.min(94, (py - r.top) / r.height * 100));
        mx = Math.max(-r.width * 0.3, Math.min(r.width * 0.3, px - (r.left + r.width / 2)));
        my = Math.max(-r.height * 0.26, Math.min(r.height * 0.26, py - (r.top + r.height / 2)));
      }
    }
    el.style.setProperty('--pcl-ox', ox.toFixed(1) + '%');
    el.style.setProperty('--pcl-oy', oy.toFixed(1) + '%');
    el.style.setProperty('--pcl-mx', mx.toFixed(1) + 'px');
    el.style.setProperty('--pcl-my', my.toFixed(1) + 'px');
    if (!el.classList.contains('pcl-sheet')) el.classList.add('pcl-sheet');
  }

  function scan(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches && node.matches(SHEET)) {
      if (!node.dataset.pclDone) {
        node.dataset.pclDone = '1';
        aim(node);
      }
      return;
    }
    if (!node.querySelectorAll) return;
    const list = node.querySelectorAll(SHEET);
    for (let i = 0; i < list.length; i++) {
      if (list[i].dataset.pclDone) continue;
      list[i].dataset.pclDone = '1';
      aim(list[i]);
    }
  }

  /* 复用的窗口（等级页那种自己开自己关的），DOM 没新增节点就不会被 observer 抓到。
     点一下之后按时间扫两遍，谁刚露脸就给谁按这次的点击点重新定位。 */
  function sweep() {
    let list;
    try {
      list = document.querySelectorAll(SHEET);
    } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (el.dataset.pclDone) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      el.dataset.pclDone = '1';
      aim(el);
    }
  }

  document.addEventListener('pointerdown', function (e) {
    px = e.clientX;
    py = e.clientY;
    has = true;
    /* 上一次露过脸的层先解开，这一下点击之后它再出现时要按新位置重算 */
    const olds = document.querySelectorAll('[data-pcl-done]');
    for (let i = 0; i < olds.length; i++) olds[i].dataset.pclDone = '';
    window.setTimeout(sweep, 200);
    window.setTimeout(sweep, 460);
  }, true);

  const ob = new MutationObserver(function (list) {
    for (let i = 0; i < list.length; i++) {
      const added = list[i].addedNodes;
      for (let j = 0; j < added.length; j++) scan(added[j]);
    }
    /* 换页会把顶栏/底栏整段重建，内联样式跟着没了，这里补回来（合并 180ms） */
    window.clearTimeout(shellTimer);
    shellTimer = window.setTimeout(function () { paintShell(); }, 180);
  });

  try {
    ob.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 页面结构异常就不管 */ }
}

paintMotion();

/* ---------- 页面过渡：全站 SPA 导航都走一层优雅的过场 ----------
   站点是 SPA，点站内链接不整页刷新；用 View Transitions API 包一层：
   帖子 / 作品卡片 → 共享元素放大到详情页；其余站内导航 → 旧页淡出、新页淡入。
   外链、_blank、下载、修饰键点击一律放行，不拦。 */
let bridgeBusy = false;
let bridgeToken = 0;
const BRIDGE_LINK = 'a[href*="/forum/post/"], a[href*="/works/"], a[href*="/work/"]';
const VT_NAME = 'postcard';

/* 只接管"站内、当前窗口、普通左键"的链接 */
function sameOriginLink(a) {
  if (!a || !a.href) return false;
  if (a.target && a.target !== '_self') return false;
  if (a.hasAttribute('download')) return false;
  var raw = a.getAttribute('href') || '';
  if (!raw || raw.charAt(0) === '#') return false;
  if (/^(mailto|tel|javascript):/i.test(raw)) return false;
  var u;
  try { u = new URL(a.href, location.href); } catch (e) { return false; }
  return u.origin === location.origin;
}

function cardOf(a) {
  return a.closest('article, [class*="bg-(--ui-card-translucent)"]');
}

function bridgeGo(a, card) {
  if (bridgeBusy) return false;
  if (!document.startViewTransition) return false;
  bridgeBusy = true;
  bridgeToken += 1;
  var token = bridgeToken;
  var oldHref = location.href;
  var oldPath = location.pathname;
  /* 只有帖子 / 作品卡才做共享元素，其余走整页交叉淡入 */
  var share = !!(card && card.style && a.closest(BRIDGE_LINK));
  if (share) card.style.setProperty('view-transition-name', VT_NAME);

  var vt = null;
  /* 保险丝：真出意外 3 秒后强制解锁，绝不把整站点击锁死 */
  var unlock = window.setTimeout(function () {
    if (bridgeToken === token) bridgeBusy = false;
  }, 3000);
  try {
    vt = document.startViewTransition(function () {
      a.click();
      return new Promise(function (resolve) {
        var n = 0;
        var iv = window.setInterval(function () {
          n += 1;
          var moved = location.href !== oldHref;
          /* 最多等 1.6 秒，页面再慢也不让过场吊在那里 */
          if (moved || n > 40) {
            window.clearInterval(iv);
            if (share && location.pathname !== oldPath) {
              /* 等详情页把标题容器渲染出来，共享元素才有落点 */
              var target = document.querySelector('article h1, main h1, h1');
              if (target) target.style.setProperty('view-transition-name', VT_NAME);
            }
            resolve();
          }
        }, 40);
      });
    });
  } catch (err) {
    /* 过渡起步就失败：立刻解锁，让调用方走普通跳转 */
    window.clearTimeout(unlock);
    if (bridgeToken === token) bridgeBusy = false;
    if (share) card.style.removeProperty('view-transition-name');
    return false;
  }
  if (!vt) {
    window.clearTimeout(unlock);
    if (bridgeToken === token) bridgeBusy = false;
    if (share) card.style.removeProperty('view-transition-name');
    return false;
  }

  vt.finished.then(function () {
    window.clearTimeout(unlock);
    if (bridgeToken === token) bridgeBusy = false;
    if (share) card.style.removeProperty('view-transition-name');
    var target = document.querySelector('article h1, main h1, h1');
    if (target) target.style.removeProperty('view-transition-name');
  }).catch(function () {
    /* 过渡被跳过 / 取消也要解锁，否则整站点击都会失灵 */
    window.clearTimeout(unlock);
    if (bridgeToken === token) bridgeBusy = false;
    if (share) card.style.removeProperty('view-transition-name');
    var target = document.querySelector('article h1, main h1, h1');
    if (target) target.style.removeProperty('view-transition-name');
  });
  return true;
}

function paintBridge() {
  document.addEventListener('click', function (e) {
    if (bridgeBusy) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest('a[href]');
    if (!sameOriginLink(a)) return;
    /* 没有过渡能力就完全放行，绝不吞掉点击 */
    if (!document.startViewTransition) return;
    if (!bridgeGo(a, cardOf(a))) return;
    /* 拦下这一次，交给 a.click() 重新派发，避免站点自己也跳一遍 */
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

paintBridge();

/* 整块可点：帖子卡、作品卡这一整片都能点进去，不用非得点中那行标题字。
   只在"没点在任何可交互元素上、也没在选文本"时接管，所以按钮、点赞、输入框都不受影响。 */
function paintHit() {
  /* 帖子页、作品页这种详情页里，正文常常引用别的帖子链接，
     整卡接管会把"点正文"误跳成别的帖子，所以详情页不接管。 */
  const p = window.location.pathname;
  if (/\/(forum\/post|works|work)\//.test(p)) return;

  const CARD = 'article, [class*="bg-(--ui-card-translucent)"]';
  const LINK = 'a[href*="/forum/post/"], a[href*="/works/"], a[href*="/work/"]';

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('a, button, input, textarea, select, label, [role="button"], [role="menuitem"], [contenteditable="true"]')) return;
    /* 顶栏、侧栏、底栏、弹层里一律不接管 */
    if (t.closest('header, nav, aside, footer, [role="dialog"], [role="menu"]')) return;
    const sel = window.getSelection();
    if (sel && String(sel).length > 0) return;

    /* 只认点到的那一张卡，绝不往外扩到列表容器——否则点页面空白都会跳 */
    const card = t.closest(CARD);
    if (!card) return;
    const a = card.querySelector(LINK);
    if (!a || !a.href) return;
    if (bridgeGo(a, card)) return;
    a.click();
  }, false);
}

paintHit();

/* 先按「开着」挂上，再读设置覆盖，中间不会闪一下没样式 */
applySkin(true);

try {
  chrome.storage.local.get(['settings'], function (g) {
    const st = (g && g.settings) || {};
    applySkin(st.siteSkin !== false);
  });
  chrome.storage.onChanged.addListener(function (ch) {
    if (ch.settings && ch.settings.newValue) {
      applySkin(ch.settings.newValue.siteSkin !== false);
    }
  });
} catch (e) {
  /* 不是扩展环境就不管，页面照旧 */
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'PC_READ_UNREAD') {
    readUnread().then(function (r) { sendResponse(r); }).catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  if (msg && msg.type === 'PC_MARK_ALL_READ') {
    markAllRead().then(function (r) { sendResponse(r); }).catch(function (e) {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }
  return false;
});
