(function () {
  try {
    var key = 'tendr-appearance';
    var pref = localStorage.getItem(key) || 'device';
    if (pref !== 'light' && pref !== 'dark' && pref !== 'device') pref = 'device';
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = pref === 'device' ? (dark ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-appearance', resolved);
    document.documentElement.setAttribute('data-appearance-pref', pref);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#ffffff' : '#070707');
  } catch (e) {
    document.documentElement.setAttribute('data-appearance', 'dark');
    document.documentElement.setAttribute('data-appearance-pref', 'device');
    var fallback = document.querySelector('meta[name="theme-color"]');
    if (fallback) fallback.setAttribute('content', '#070707');
  }
})();
