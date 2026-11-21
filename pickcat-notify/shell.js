/* 页面外壳：弹窗宽度跟屏幕走
   MV3 扩展页的 CSP 不允许内联脚本，所以放这个外部文件，三页共用
   图标本身是 SVG（icons/*.svg），矢量缩放，不需要按像素挑档 */
(function () {
  var s = window.screen;
  var aw = (s && (s.availWidth || s.width)) || 1440;
  var pw = Math.round(aw * 0.21);
  if (pw < 336) pw = 336;
  if (pw > 500) pw = 500;
  document.documentElement.style.setProperty('--pw', pw + 'px');
})();
