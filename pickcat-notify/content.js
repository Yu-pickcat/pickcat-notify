/* 运行在 Pickcat 页面里：用页面自身的登录状态读取未读数，供后台取用 */

const SUMMARY_URL = '/api/v1/notification-summary';
const LIST_URL = '/api/v1/notifications?limit=5';
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
