// Runs before first paint (classic script) so saved appearance settings never flash.
// Mirrors prefs.js: defaults leave the attribute off. Keys: helm.theme / accent / fs / density / code / codestyle.
try {
  var root = document.documentElement;
  var pick = function (key, allowed) {
    var v = localStorage.getItem(key);
    return allowed.indexOf(v) >= 0 ? v : null;
  };
  var t = pick('helm.theme', ['light', 'dark']);
  if (t) root.setAttribute('data-theme', t);
  var a = pick('helm.accent', ['blue', 'indigo', 'green', 'orange', 'pink']);
  if (a) root.setAttribute('data-accent', a);
  var f = pick('helm.fs', ['s', 'l']);
  if (f) root.setAttribute('data-fs', f);
  if (pick('helm.density', ['compact'])) root.setAttribute('data-density', 'compact');
  if (pick('helm.code', ['on'])) root.setAttribute('data-code', 'on');
  root.setAttribute('data-codestyle', pick('helm.codestyle', ['js', 'ts', 'py']) || 'js');
  if (localStorage.getItem('helm.sidebar') === 'collapsed') root.setAttribute('data-sidebar', 'collapsed');
} catch (e) { /* storage unavailable */ }
