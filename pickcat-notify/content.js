/* 运行在 Pickcat 页面里：用页面自身的登录状态读取未读数和消息列表，供后台取用
   v2.4.0 起还负责「全部标为已读」——只有用户手动点才会执行，后台不会自己写。 */

(function () {
  const SUMMARY_URL = '/api/v1/notification-summary';
  const LIST_URL = '/api/v1/notifications?limit=8';

  function jsonFetch(url, options) {
    return fetch(url, options).then(function (res) {
      if (!res.ok) return { ok: false, status: res.status };
      if (res.status === 204) return { ok: true, status: 204, data: null };
      return res.json().then(function (data) {
        return { ok: true, status: res.status, data: data };
      }, function () {
        return { ok: false, status: res.status, error: '返回内容不是 JSON' };
      });
    });
  }

  async function readUnread() {
    let sum;
    try {
      sum = await jsonFetch(SUMMARY_URL, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store'
      });
    } catch (e) {
      return { ok: false, error: '网络错误：' + String(e) };
    }

    if (!sum.ok) return { ok: false, status: sum.status };

    let items = [];
    try {
      const list = await jsonFetch(LIST_URL, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store'
      });
      if (list.ok && list.data) {
        items = list.data.items || (list.data.data && list.data.data.items) || [];
      }
    } catch (e) {
      items = [];
    }

    return {
      ok: true,
      count: Number(sum.data && sum.data.unreadCount) || 0,
      byType: (sum.data && sum.data.unreadCountByType) || null,
      items: items
    };
  }

  async function markRead() {
    try {
      const res = await fetch('/api/v1/notifications', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ read: true })
      });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, status: res.status };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'PC_READ_UNREAD') {
      readUnread().then(function (r) { sendResponse(r); }).catch(function (e) {
        sendResponse({ ok: false, error: String(e) });
      });
      return true;
    }

    if (msg.type === 'PC_MARK_READ') {
      markRead().then(function (r) { sendResponse(r); }).catch(function (e) {
        sendResponse({ ok: false, error: String(e) });
      });
      return true;
    }

    return false;
  });
})();
