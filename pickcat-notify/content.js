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
  document.documentElement.classList.toggle('pcl-skin', skinOn);
  document.documentElement.classList.toggle('pcl-skin-on', skinOn);
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
  const ctas = document.querySelectorAll('[data-pcl-cta]');
  for (let i = 0; i < ctas.length; i++) delete ctas[i].dataset.pclCta;
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
  let loose = null;
  for (let i = 0; i < list.length; i++) {
    if (list[i].closest && list[i].closest(AVA_ROOT)) continue;
    const r = list[i].getBoundingClientRect();
    /* 要里面带链接（论坛/作品/搜索）才是站点顶栏，其它扩展挂的 header 不带这些 */
    if (r.width > 300 && r.height > 40 && r.height < 140 && list[i].querySelector('a[href]')) return list[i];
    /* 登录、空态这种没有链接的页：只按尺寸 + 是否固定/粘在第几条来认，别让顶栏忽然不悬浮 */
    if (!loose && r.width > 240 && r.height > 36 && r.height < 160) {
      const pos = getComputedStyle(list[i]).position;
      if (pos === 'fixed' || pos === 'sticky' || r.top < 40) loose = list[i];
    }
  }
  return loose;
}

/* 图片、头像、封面一律不碰：原站什么样就什么样，这里不做任何圆角改写。 */

function pickBar() {
  const list = document.querySelectorAll('[class*="fixed"][class*="bottom-0"]');
  for (let i = 0; i < list.length; i++) {
    if (list[i].closest && list[i].closest(AVA_ROOT)) continue;
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

/* 页面现在是亮底还是暗底：看 body/html 的底色亮度，别只看 html.dark ——
   站点"跟随系统"时可能挂的是别的标记，凭类名会判反。 */
function pageLight() {
  const cands = [document.body, document.documentElement];
  for (let i = 0; i < cands.length; i++) {
    if (!cands[i]) continue;
    const m = String(getComputedStyle(cands[i]).backgroundColor).match(/[\d.]+/g);
    if (!m || m.length < 3) continue;
    const a = m.length > 3 ? Number(m[3]) : 1;
    if (a <= 0.02) continue;
    const lum = (0.299 * Number(m[0]) + 0.587 * Number(m[1]) + 0.114 * Number(m[2])) / 255;
    return lum > 0.55;
  }
  return !document.documentElement.classList.contains('dark');
}

/* 把站点自己的栏底色转成半透明，色相不变、只降不透明度。
   取不到颜色（透明 / 无值）时按页面明暗给一个同色系兜底，绝不用"黑"。 */
function tint(color, alpha, light) {
  const m = String(color).match(/[\d.]+/g);
  const a0 = m && m.length > 3 ? Number(m[3]) : (m && m.length === 3 ? 1 : 0);
  if (!m || m.length < 3 || a0 <= 0.02) {
    return light ? 'rgba(255, 255, 255, ' + alpha + ')' : 'rgba(24, 25, 29, ' + alpha + ')';
  }
  const r = Number(m[0]), g = Number(m[1]), b = Number(m[2]);
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + (alpha * a0).toFixed(2) + ')';
}

/* 顶栏悬浮要的那 10px，得从内容上边补回来，否则会压住第一张卡 */
function padTop(el, extra) {
  if (!el) return;
  if (el.dataset.pclPad0 == null) {
    const cur = parseFloat(getComputedStyle(el).paddingTop) || 0;
    el.dataset.pclPad0 = String(cur);
    el.dataset.pclPadWas = el.style.paddingTop;
  }
  const base = Number(el.dataset.pclPad0) || 0;
  if (extra) el.style.setProperty('padding-top', (base + extra) + 'px', 'important');
  else el.style.removeProperty('padding-top');
}

function scrollBox(head) {
  const box = document.querySelector('.v3-scroll-body');
  if (box) return box;
  const main = document.querySelector('main');
  return main ? main.parentElement : null;
}

/* 站点关于头像的一切（圆角、尺寸、容器）都不碰，原样放着。
   这里只留一份「其它扩展注入的界面」名单，用来避免抢它们的顶栏/弹窗/过渡。 */
const AVA_ROOT = '#pickcat-plus-root, .pickcat-plus, .pickcat-ws, [class*="pickscribe"], [class^="pcr-"], [class^="pcai-"], [class^="pco-"], [class^="pcg-"], [class^="pch-"], [class^="pcs-"]';


/* 「分享你的想法」这类整条 CTA：只按文字认出这一条打标，圆角交给 site-skin.css。
   其它按钮一概不碰；换页后 DOM 重建，靠下面的合并定时器补标。 */
function markCta() {
  const list = document.querySelectorAll('main a[class*="rounded"], main button[class*="rounded"]');
  for (let i = 0; i < list.length; i++) {
    const el = list[i];
    if (el.dataset.pclCta) continue;
    if (el.closest && el.closest(AVA_ROOT)) continue;
    const t = (el.textContent || '').trim();
    if (t.length > 12 || t.indexOf('分享你的想法') < 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 30 || r.height > 80) continue;
    el.dataset.pclCta = '1';
  }
}

function paintShell(off) {
  off = off || !skinOn;
  const head = pickHead();
  const bar = pickBar();
  const light = pageLight();
  /* 手机上一律不浮：宽度到手机档，或站点自己的底栏真的显示了，就都算手机布局。
     个人主页这种没有底栏的手机页也不能浮——上面保持站点原样。 */
  const narrow = window.innerWidth <= 767 || (!!bar && (function () {
    const r = bar.getBoundingClientRect();
    return r.width > 120 && r.height > 24 && r.height <= 200;
  })());
  const box = scrollBox();

  if (head) {
    if (off || narrow) {
      clearShell(head);
      head.removeAttribute('data-pcl-float');
      padTop(box, 0);
    } else {
      const cs = getComputedStyle(head);
      const theme = light ? 'l' : 'd';
      if (!head.dataset.pclBase || head.dataset.pclTheme !== theme) {
        head.dataset.pclBase = cs.backgroundColor;
        head.dataset.pclTheme = theme;
      }
      const base = tint(head.dataset.pclBase, .82, light);
      const blur = cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : 'blur(24px) saturate(1.25)';
      head.setAttribute('data-pcl-float', 'head');
      head.style.setProperty('top', '10px', 'important');
      head.style.setProperty('margin', '0 10px', 'important');
      head.style.setProperty('border', '0', 'important');
      head.style.setProperty('background', base, 'important');
      head.style.setProperty('background-image', 'none', 'important');
      head.style.setProperty('-webkit-backdrop-filter', blur, 'important');
      head.style.setProperty('backdrop-filter', blur, 'important');
      head.style.setProperty('box-shadow', light
        ? '0 10px 26px -22px rgba(19, 21, 30, .38)'
        : '0 12px 30px -24px rgba(0, 0, 0, .9)', 'important');
      padTop(box, 10);
    }
  }

  /* 手机底栏：一律不动，原站怎么放就怎么放（连历史版本可能落下的内联也清掉） */
  if (bar) {
    clearShell(bar);
    bar.removeAttribute('data-pcl-float');
  }
}

let shellTimer = 0;
function scheduleShell(delay) {
  window.clearTimeout(shellTimer);
  shellTimer = window.setTimeout(function () { paintShell(); markCta(); }, delay == null ? 140 : delay);
}

window.addEventListener('resize', function () {
  /* 窗口一变小，立刻按新宽度重算：哪条该浮、哪条该回原位，不在中间态停留 */
  paintShell();
  scheduleShell(160);
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
    /* 别的扩展（PICKCAT Plus / PickScribe）自己弹的窗口，别套本站的动效 */
    if (node.closest && node.closest(AVA_ROOT)) return;
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
    /* 换页会把顶栏/底栏整段重建，悬浮几何跟着丢了，这里补回来（合并 200ms） */
    scheduleShell(200);
  });

  try {
    ob.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) { /* 页面结构异常就不管 */ }
}

paintMotion();

/* 页签 / 筛选切换：内容淡一下（不位移）。只在同页换列表时用，跳路由的交给站点。 */
function paintSoft() {
  document.addEventListener('click', function (e) {
    if (!skinOn) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const hit = t.closest('[role="tab"], button[data-state], [data-pcl-soft]');
    if (!hit) return;
    if (hit.closest('a[href]')) return;
    const b = document.body;
    if (!b) return;
    b.classList.remove('pcl-soft');
    void b.offsetWidth;
    b.classList.add('pcl-soft');
    window.setTimeout(function () { b.classList.remove('pcl-soft'); }, 300);
  }, true);
}

paintSoft();

/* ---------- 页面过渡：首页卡片点开，平滑过渡到帖子页 ----------
   站点是 SPA，点帖子/作品链接不整页刷新；用 View Transitions API 包一层，
   截住旧页面，把被点的卡片放大到帖子页标题，再让新页面淡入。
   头像、名字、标签这些是别的链接，不在这里拦。 */
let bridgeBusy = false;
const BRIDGE_LINK = 'a[href*="/forum/post/"], a[href*="/works/"], a[href*="/work/"]';

function bridgeGo(a, card) {
  if (bridgeBusy) return false;
  if (!document.startViewTransition) return false;
  bridgeBusy = true;
  const name = 'postcard';
  if (card && card.style) card.style.setProperty('view-transition-name', name);
  const oldPath = window.location.pathname;
  /* 长文帖子（卡片本身比一屏还高）：放大过渡会拖一会儿，把时长压短，别让人觉得卡住 */
  const root = document.documentElement;
  const tall = !!(card && card.getBoundingClientRect && card.getBoundingClientRect().height > window.innerHeight * 1.2);
  root.classList.toggle('pcl-vt-fast', tall);

  const vt = document.startViewTransition(function () {
    a.click();
    return new Promise(function (resolve) {
      let n = 0;
      const iv = window.setInterval(function () {
        n += 1;
        const changed = window.location.pathname !== oldPath;
        if (changed) {
          /* 等帖子页把标题/正文容器渲染出来再定格，共享元素才有落点 */
          const target = document.querySelector('article h1, main h1, h1, article');
          if (target) target.style.setProperty('view-transition-name', name);
          if (target || n > 30) {
            window.clearInterval(iv);
            resolve();
          }
        } else if (n > 50) {
          window.clearInterval(iv);
          resolve();
        }
      }, 50);
    });
  });

  vt.finished.then(function () {
    bridgeBusy = false;
    document.documentElement.classList.remove('pcl-vt-fast');
    if (card && card.style) card.style.removeProperty('view-transition-name');
    const target = document.querySelector('article h1, main h1, h1, article');
    if (target) target.style.removeProperty('view-transition-name');
  }).catch(function () {
    bridgeBusy = false;
    document.documentElement.classList.remove('pcl-vt-fast');
  });
  return true;
}

function paintBridge() {
  document.addEventListener('click', function (e) {
    if (bridgeBusy) return;
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    if (!t || !t.closest) return;
    const a = t.closest(BRIDGE_LINK);
    if (!a || !a.href) return;
    /* 别的扩展的浮层预览里点链接，交给它们自己处理，别再套一层共享元素过渡 */
    if (a.closest && a.closest(AVA_ROOT)) return;
    e.preventDefault();
    const card = a.closest('article, [class*="bg-(--ui-card-translucent)"]') || a;
    bridgeGo(a, card);
  }, true);
}

paintBridge();

/* 圆角档位与开关：只动圆角和一个"关动效"类，不碰任何颜色 */
let skinStyle = { radius: 28, square: false, motion: true };

function applySkinStyle(st) {
  skinStyle = Object.assign({ radius: 28, square: false, motion: true }, st || {});
  if ([24, 28, 32].indexOf(Number(skinStyle.radius)) < 0) skinStyle.radius = 28;
  const root = document.documentElement;
  root.classList.remove('pcl-r24', 'pcl-r28', 'pcl-r32');
  root.classList.add('pcl-r' + skinStyle.radius);
  root.classList.toggle('pcl-square', !!skinStyle.square);
  root.classList.toggle('pcl-noanim', skinStyle.motion === false);
}

/* ---------- 返回：不拦事件，等路由自己换完再补一下入场 ----------
   浏览器后退 / 手势返回 / 站内返回箭头都走 popstate；这里只读不拦：
   完全交给站点换视图，换完再给 main 补一个 0.24s 的"从下面落上来"，
   所以不会出现"点了返回却停在原地"那种卡死。 */
window.addEventListener('popstate', function () {
  if (!skinOn) return;
  window.setTimeout(function () { paintShell(); }, 220);
  const b = document.body;
  if (!b) return;
  b.classList.remove('pcl-back-in');
  void b.offsetWidth;
  b.classList.add('pcl-back-in');
  window.setTimeout(function () { b.classList.remove('pcl-back-in'); }, 380);
}, false);

/* 先按「开着」挂上，再读设置覆盖，中间不会闪一下没样式 */
applySkin(true);

try {
  chrome.storage.local.get(['settings'], function (g) {
    const st = (g && g.settings) || {};
    applySkinStyle(st.siteSkinStyle);
    applySkin(st.siteSkin !== false);
  });
  chrome.storage.onChanged.addListener(function (ch) {
    if (ch.settings && ch.settings.newValue) {
      applySkinStyle(ch.settings.newValue.siteSkinStyle);
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
