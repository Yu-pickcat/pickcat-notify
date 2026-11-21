/* 页面外壳：宽度跟屏幕走、图标按「显示尺寸 × 设备像素比」挑档
   MV3 扩展页的 CSP 不允许内联脚本，所以这些都放这个外部文件，三页共用 */
(function () {
  var SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256];

  /* 弹窗宽度：按屏幕可用宽度算（约屏宽 1/5），最小 336、最大 500 */
  function setWidth() {
    var s = window.screen;
    var aw = (s && (s.availWidth || s.width)) || 1440;
    var pw = Math.round(aw * 0.21);
    if (pw < 336) pw = 336;
    if (pw > 500) pw = 500;
    document.documentElement.style.setProperty('--pw', pw + 'px');
  }

  function dpr() {
    var r = window.devicePixelRatio || 1;
    return r < 1 ? 1 : r;
  }

  /* 挑第一个不小于目标的档：永远不把低清档拉大 */
  function pick(need) {
    for (var i = 0; i < SIZES.length; i++) {
      if (SIZES[i] >= need) return SIZES[i];
    }
    return SIZES[SIZES.length - 1];
  }

  function fitIcons() {
    var imgs = document.querySelectorAll('img[data-icon-size]');
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var css = parseFloat(img.getAttribute('data-icon-size')) || 24;
      var pre = img.getAttribute('data-icon-prefix') || 'icon';
      var size = pick(Math.ceil(css * dpr()));
      var want = 'icons/' + pre + size + '.png';
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    }
  }

  setWidth();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', fitIcons);
  } else {
    fitIcons();
  }
  window.addEventListener('resize', fitIcons);
})();
