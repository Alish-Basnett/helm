// Runs before first paint (classic script) so the saved theme never flashes.
try {
  var t = localStorage.getItem('helm.theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  if (localStorage.getItem('helm.sidebar') === 'collapsed') document.documentElement.setAttribute('data-sidebar', 'collapsed');
} catch (e) { /* storage unavailable */ }
