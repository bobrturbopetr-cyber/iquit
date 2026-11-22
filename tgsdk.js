/* IQuit — локальный слой совместимости с Telegram WebApp.
   Использует внедрённый клиентом window.Telegram.WebApp, если он есть.
   Если клиент Telegram не внедрил API (например, telegram.org заблокирован),
   создаёт минимальный эмулятор:
     - initData / initDataUnsafe.user из URL-параметра tgWebAppData (стандарт открытия мини-аппа);
     - CloudStorage поверх localStorage (чтобы прогресс не терялся);
     - no-op методы ready/expand/цвета/MainButton/Haptic. */
(function () {
  'use strict';

  if (window.Telegram && window.Telegram.WebApp) {
    return; // клиент уже внедрил API — используем как есть
  }

  // --- парсинг tgWebAppData из URL ---
  function parseInitData() {
    var raw = '';
    try {
      var p = new URLSearchParams(window.location.search);
      raw = p.get('tgWebAppData') || '';
    } catch (e) { raw = ''; }
    return raw;
  }

  function parseUnsafe(initData) {
    var unsafe = { query_id: '', user: null, auth_date: '', hash: '' };
    if (!initData) return unsafe;
    try {
      var p = new URLSearchParams(initData);
      if (p.get('user')) unsafe.user = JSON.parse(p.get('user'));
      unsafe.query_id = p.get('query_id') || '';
      unsafe.auth_date = p.get('auth_date') || '';
      unsafe.hash = p.get('hash') || '';
    } catch (e) { /* ignore */ }
    return unsafe;
  }

  var initData = parseInitData();
  var initDataUnsafe = parseUnsafe(initData);

  // --- CloudStorage поверх localStorage ---
  var store = {
    getItem: function (key, cb) {
      var v = null;
      try { v = localStorage.getItem(key); } catch (e) {}
      if (typeof cb === 'function') cb(null, v);
    },
    setItem: function (key, val, cb) {
      try { localStorage.setItem(key, val); } catch (e) {}
      if (typeof cb === 'function') cb(null);
    }
  };

  function noop() {}

  var MainButton = {
    setParams: noop,
    onClick: noop,
    hide: noop,
    show: noop
  };
  var HapticFeedback = {
    impactOccurred: noop,
    notificationOccurred: noop,
    selectionChanged: noop
  };

  window.Telegram = {
    WebApp: {
      initData: initData,
      initDataUnsafe: initDataUnsafe,
      colorScheme: 'dark',
      themeParams: {},
      version: '6.0',
      platform: 'unknown',
      ready: noop,
      expand: noop,
      setHeaderColor: noop,
      setBackgroundColor: noop,
      close: noop,
      enableClosingConfirmation: noop,
      disableClosingConfirmation: noop,
      MainButton: MainButton,
      HapticFeedback: HapticFeedback,
      CloudStorage: store
    }
  };
})();