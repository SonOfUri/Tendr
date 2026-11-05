(function () {
  try {
    var key = 'tendr-appearance';
    var pref = localStorage.getItem(key) || 'device';
    if (pref !== 'light' && pref !== 'dark' && pref !== 'device') pref = 'device';
    var dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = pref === 'device' ? (dark ? 'dark' : 'light') : pref;
    document.documentElement.setAttribute('data-appearance', resolved);
    document.documentElement.setAttribute('data-appearance-pref', pref);
  } catch (e) {
    document.documentElement.setAttribute('data-appearance', 'dark');
    document.documentElement.setAttribute('data-appearance-pref', 'device');
  }
})();
