/* 血压管家 — 应用控制层：路由、数据加载、交互、图表、提醒、启动 */
(function () {
  'use strict';
  window.BP = window.BP || {};
  var U = BP.util;
  var api = BP.api;
  var st = BP.state;

  var appEl = null;
  var reminderTimer = null;
  var TOAST_MS = 3200;

  function $(id) { return document.getElementById(id); }
  function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  /* ================================================================== */
  /* 渲染                                                                */
  /* ================================================================== */
  function destroyCharts() {
    Object.keys(st.charts).forEach(function (k) {
      try { st.charts[k].destroy(); } catch (e) { /* ignore */ }
    });
    st.charts = {};
  }

  function render(opts) {
    opts = opts || {};
    if (!appEl) appEl = $('app');
    if (!appEl) return;
    destroyCharts();
    var html;
    if (!st.authChecked) {
      html = '<div class="splash">' +
        '<div class="splash-logo">' + BP.icons.logo(84, { uid: 'splash' }) + '</div>' +
        '<h1>血压管家</h1><p>正在打开…</p>' +
        '<div class="splash-bar"><i></i></div></div>';
    } else if (!st.auth.authenticated) {
      html = BP.views.auth();
    } else {
      html = BP.views.shell();
    }
    var y = window.scrollY;
    appEl.innerHTML = html;
    appEl.setAttribute('data-route', st.route);
    if (opts.scrollTop) window.scrollTo(0, 0);
    else if (y) window.scrollTo(0, y);
    document.title = (st.auth.authenticated
      ? ({ home: '首页', records: '记录', meds: '吃药', settings: '设置' }[st.route] || '首页') + ' · 血压管家'
      : '血压管家');
    requestAnimationFrame(function () { setTimeout(afterRender, 0); });
  }

  function afterRender() {
    initChartDefaults();
    if (!st.auth.authenticated) return;
    if (st.route === 'home') {
      buildHomeChart();
      ensureHomeChartLater();
    }
    if (st.route === 'records') buildRecordsChart();
    maybeApplyChannelDeepLink();
  }

  // 兜底：若首页图表初始化时容器尚未完成布局（尺寸为 0），稍后重建一次
  function ensureHomeChartLater() {
    if (st._homeChartGuard) return;
    st._homeChartGuard = true;
    setTimeout(function () {
      if (st.route !== 'home' || !st.homeStats) return;
      var chart = st.charts.home;
      if (!chart || !chart.canvas || !chart.canvas.isConnected || chart.width < 40) {
        destroyCharts();
        buildHomeChart();
      }
    }, 700);
  }

  /* 深链接 open=channel：展开指定通知通道并滚动到可见位置（便于截图/直达） */
  var channelScrolled = false;
  function maybeApplyChannelDeepLink() {
    var params = new URLSearchParams(location.search);
    if (params.get('open') !== 'channel') return;
    if (st.route !== 'settings' || !st.loaded.settings) return;
    var key = params.get('channel') || 'ntfy';
    var el = document.querySelector('.chan[data-channel="' + key + '"]');
    if (!el) return;
    el.open = true;
    if (!channelScrolled) {
      channelScrolled = true;
      setTimeout(function () {
        try { el.scrollIntoView({ block: 'center' }); }
        catch (e) { try { el.scrollIntoView(); } catch (e2) { } }
      }, 160);
    }
  }

  function rebuildCharts() {
    if (!st.auth.authenticated) return;
    destroyCharts();
    if (st.route === 'home') buildHomeChart();
    if (st.route === 'records') buildRecordsChart();
  }
  window.addEventListener('resize', U.debounce(rebuildCharts, 250));

  /* ================================================================== */
  /* 图表                                                                */
  /* ================================================================== */
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  var chartDefaultsReady = false;
  function initChartDefaults() {
    if (typeof Chart === 'undefined' || chartDefaultsReady) return;
    chartDefaultsReady = true;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = cssVar('--muted') || '#5d7b80';
  }

  function chartColors() {
    return {
      text: cssVar('--muted') || '#5d7b80',
      grid: cssVar('--chart-grid') || 'rgba(14,159,138,.12)',
      primary: cssVar('--primary') || '#0E9F8A',
      accent: cssVar('--accent') || '#F08A3C',
      pulse: cssVar('--violet') || '#7C6CE0',
      tooltipBg: cssVar('--tooltip-bg') || '#16333a',
      tooltipText: cssVar('--tooltip-text') || '#ffffff'
    };
  }

  function daySeries(series, days, measurements) {
    var labels = [], sys = [], dia = [], pulse = [], hasData = false;
    for (var i = days - 1; i >= 0; i--) {
      var ds = U.dateStr(U.addDays(new Date(), -i));
      var found = null;
      for (var j = 0; j < (series || []).length; j++) {
        if (String(series[j].date || '').slice(0, 10) === ds) { found = series[j]; break; }
      }
      labels.push(U.shortDate(ds + 'T12:00:00'));
      sys.push(found && found.avg_sys != null ? found.avg_sys : null);
      dia.push(found && found.avg_dia != null ? found.avg_dia : null);
      // 契约 stats.series 不含 avg_pulse，脉率用记录明细的当天平均值兜底
      if (found && found.avg_pulse != null) {
        pulse.push(found.avg_pulse);
      } else if (measurements && measurements.length) {
        var sum = 0, n = 0;
        for (var k = 0; k < measurements.length; k++) {
          var m = measurements[k];
          if (String(m.measured_at || '').slice(0, 10) === ds && m.pulse) { sum += m.pulse; n++; }
        }
        pulse.push(n ? Math.round(sum / n * 10) / 10 : null);
      } else {
        pulse.push(null);
      }
      if (found) hasData = true;
    }
    return { labels: labels, sys: sys, dia: dia, pulse: pulse, hasData: hasData };
  }

  function makeChart(canvas, config) {
    if (!canvas || typeof Chart === 'undefined') return null;
    try {
      return new Chart(canvas.getContext('2d'), config);
    } catch (e) {
      console.warn('chart render failed', e);
      return null;
    }
  }

  function showChartFallback(canvasId, message) {
    var canvas = $(canvasId);
    if (!canvas) return;
    var wrap = canvas.parentNode;
    if (wrap) wrap.innerHTML = '<div class="chart-empty">' + U.esc(message) + '</div>';
  }

  function buildHomeChart() {
    try {
      buildHomeChartInner();
    } catch (e) {
      console.error('首页趋势图渲染失败', e);
      showChartFallback('chart-home', '趋势图暂时显示不出来，可到「记录」页查看');
    }
  }

  function buildHomeChartInner() {
    var canvas = $('chart-home');
    if (!canvas || !st.homeStats) return;
    var c = chartColors();
    var d = daySeries(st.homeStats.series, 7);
    if (!d.hasData) {
      var wrap = canvas.parentNode;
      if (wrap) wrap.innerHTML = '<div class="chart-empty">还没有足够的记录，坚持测量 3 天就能看到趋势</div>';
      return;
    }
    var h = canvas.parentNode ? canvas.parentNode.clientHeight || 130 : 130;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(14,159,138,.26)');
    grad.addColorStop(1, 'rgba(14,159,138,0)');
    st.charts.home = makeChart(canvas, {
      type: 'line',
      data: {
        labels: d.labels,
        datasets: [
          {
            label: '收缩压', data: d.sys, borderColor: c.primary, backgroundColor: grad, fill: true,
            tension: 0.38, borderWidth: 3, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: c.primary,
            pointBorderColor: 'transparent', spanGaps: true, unit: 'mmHg'
          },
          {
            label: '舒张压', data: d.dia, borderColor: c.accent, backgroundColor: 'transparent', fill: false,
            tension: 0.38, borderWidth: 2.5, pointRadius: 2.5, pointHoverRadius: 5, pointBackgroundColor: c.accent,
            pointBorderColor: 'transparent', spanGaps: true, unit: 'mmHg'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, resizeDelay: 0,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 6, right: 4, bottom: 0, left: 0 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.tooltipBg, titleColor: c.tooltipText, bodyColor: c.tooltipText,
            padding: 10, cornerRadius: 10, displayColors: true,
            callbacks: {
              title: function (items) { return items[0].label; },
              label: function (item) {
                if (item.parsed.y == null) return null;
                return item.dataset.label + '  ' + item.parsed.y + ' mmHg';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: { color: c.text, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 4 }
          },
          y: { display: false, suggestedMin: 50, suggestedMax: 170 }
        }
      }
    });
    var chart = st.charts.home;
    if (!chart || chart.width < 40 || chart.height < 20) {
      showChartFallback('chart-home', '趋势图暂时显示不出来，可到「记录」页查看');
    }
  }

  function buildRecordsChart() {
    try {
      buildRecordsChartInner();
    } catch (e) {
      console.error('记录趋势图渲染失败', e);
      showChartFallback('chart-records', '趋势图暂时显示不出来，请刷新重试');
    }
  }

  function buildRecordsChartInner() {
    var canvas = $('chart-records');
    if (!canvas || !st.stats) return;
    var c = chartColors();
    var d = daySeries(st.stats.series, st.statsDays, st.measurements);
    if (!d.hasData) {
      var wrap = canvas.parentNode;
      if (wrap) wrap.innerHTML = '<div class="chart-empty">这段时间还没有记录</div>';
      return;
    }
    var h = canvas.parentNode ? canvas.parentNode.clientHeight || 210 : 210;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(14,159,138,.22)');
    grad.addColorStop(1, 'rgba(14,159,138,0)');
    var maxTicks = window.innerWidth < 520 ? 5 : 9;
    st.charts.records = makeChart(canvas, {
      type: 'line',
      data: {
        labels: d.labels,
        datasets: [
          {
            label: '收缩压', data: d.sys, borderColor: c.primary, backgroundColor: grad, fill: true,
            tension: 0.36, borderWidth: 3, pointRadius: 3, pointHoverRadius: 6, pointBackgroundColor: c.primary,
            pointBorderColor: 'transparent', spanGaps: true, hidden: !st.series.sys, unit: 'mmHg', yAxisID: 'y'
          },
          {
            label: '舒张压', data: d.dia, borderColor: c.accent, backgroundColor: 'transparent', fill: false,
            tension: 0.36, borderWidth: 2.6, pointRadius: 2.6, pointHoverRadius: 5, pointBackgroundColor: c.accent,
            pointBorderColor: 'transparent', spanGaps: true, hidden: !st.series.dia, unit: 'mmHg', yAxisID: 'y'
          },
          {
            label: '脉率', data: d.pulse, borderColor: c.pulse, backgroundColor: 'transparent', fill: false,
            tension: 0.36, borderWidth: 2.2, borderDash: [6, 5], pointRadius: 2.4, pointHoverRadius: 5,
            pointBackgroundColor: c.pulse, pointBorderColor: 'transparent', spanGaps: true,
            hidden: !st.series.pulse, unit: '次/分', yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, resizeDelay: 0,
        animation: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 8, right: 2, bottom: 0, left: 0 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: c.tooltipBg, titleColor: c.tooltipText, bodyColor: c.tooltipText,
            padding: 11, cornerRadius: 11, displayColors: true, boxPadding: 4,
            callbacks: {
              title: function (items) { return items[0].label; },
              label: function (item) {
                if (item.parsed.y == null) return null;
                return item.dataset.label + '  ' + item.parsed.y + ' ' + (item.dataset.unit || '');
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false }, border: { display: false },
            ticks: { color: c.text, font: { size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: maxTicks }
          },
          y: {
            position: 'left', suggestedMin: 50, suggestedMax: 170,
            grid: { color: c.grid, drawTicks: false }, border: { display: false },
            ticks: { color: c.text, font: { size: 11 }, padding: 6, maxTicksLimit: 6 }
          },
          y1: {
            position: 'right', display: !!st.series.pulse, suggestedMin: 40, suggestedMax: 130,
            grid: { display: false }, border: { display: false },
            ticks: { color: c.pulse, font: { size: 11 }, padding: 4, maxTicksLimit: 4 }
          }
        }
      }
    });
    var chart = st.charts.records;
    if (!chart || chart.width < 40 || chart.height < 20) {
      showChartFallback('chart-records', '趋势图暂时显示不出来，请刷新重试');
    }
  }

  /* ================================================================== */
  /* 路由                                                                */
  /* ================================================================== */
  var ROUTES = ['home', 'records', 'meds', 'settings', 'admin'];
  function parseRoute() {
    var h = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return ROUTES.indexOf(h) >= 0 ? h : 'home';
  }

  function go(route) {
    if (ROUTES.indexOf(route) < 0) return;
    if (route === 'admin' && !BP.role.isAdmin()) {
      BP.ui.toast('只有管理员可以打开用户管理', 'error', 3000);
      return;
    }
    if (route !== 'settings') st.openChannel = null;
    if (route === st.route) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    st.route = route;
    try { history.pushState(null, '', '#/' + route); } catch (e) { location.hash = '#/' + route; }
    render({ scrollTop: true });
    ensureRoute(route);
  }

  window.addEventListener('popstate', function () {
    var r = parseRoute();
    st.route = r;
    render({ scrollTop: true });
    if (st.auth.authenticated) ensureRoute(r);
  });

  function ensureRoute(route, force) {
    if (!st.auth.authenticated) return;
    if (st.loading[route]) return;
    // 医生未绑定患者：不请求数据接口，直接展示提示
    if (BP.role.isDoctor() && !st.viewPatientId) {
      st.loaded[route] = true;
      st.loading[route] = false;
      render();
      return;
    }
    // 非管理员不加载用户管理数据
    if (route === 'admin' && !BP.role.isAdmin()) {
      st.loaded[route] = true;
      st.loading[route] = false;
      render();
      return;
    }
    if (st.loaded[route] && !force) {
      // 深链接：已加载的设置页上直接展开指定通知通道
      if (route === 'settings' && st.pendingOpenChannel) {
        st.openChannel = st.pendingOpenChannel;
        st.pendingOpenChannel = null;
        render();
        st.openChannel = null;
      }
      return;
    }
    st.loading[route] = true;
    render();
    var loader = route === 'home' ? loadHome
      : route === 'records' ? loadRecords
        : route === 'meds' ? loadMeds
          : route === 'admin' ? loadAdminUsers
            : loadSettings;
    Promise.resolve()
      .then(loader)
      .then(function () {
        st.loaded[route] = true;
        st.loading[route] = false;
        if (route === 'settings' && st.pendingOpenChannel) {
          st.openChannel = st.pendingOpenChannel;
          st.pendingOpenChannel = null;
        }
        render();
        st.openChannel = null;
        if (route === 'home' && BP.role.canWrite()) announceReminders(st.reminders, true);
      })
      .catch(function (err) {
        st.loading[route] = false;
        handleError(err);
        render();
      });
  }

  function handleError(err) {
    if (!err) return;
    if (err.status === 401) return;
    BP.ui.toast(err.message || '操作失败，请稍后再试', 'error', 4000);
  }

  /* ================================================================== */
  /* 数据加载                                                            */
  /* ================================================================== */
  async function loadSettingsIfNeeded() {
    if (st.settings) return;
    try { st.settings = await api.getSettings(); } catch (e) { /* 个别页面不依赖 settings */ }
  }

  async function loadHome() {
    var d = await api.dashboard(U.todayStr());
    st.dashboard = d;
    st.reminders = BP.role.canWrite() ? (d.reminders || []) : [];
    await loadSettingsIfNeeded();
    try { st.homeStats = await api.stats(7); } catch (e) { st.homeStats = null; }
  }

  async function loadRecords() {
    var from = U.dateStr(U.addDays(new Date(), -29));
    var to = U.todayStr();
    var res = await api.measurements({ from: from, to: to, limit: 500 });
    st.measurements = (res.items || []).slice().sort(function (a, b) {
      return String(b.measured_at || '').localeCompare(String(a.measured_at || ''));
    });
    st.recordsTotal = typeof res.total === 'number' ? res.total : st.measurements.length;
    st.stats = await api.stats(st.statsDays);
    await loadSettingsIfNeeded();
  }

  async function loadMeds() {
    var today = U.todayStr();
    var medsRes = await api.medications(true);
    var logsRes = await api.medlogs(today);
    st.meds = medsRes.items || [];
    st.medlogsToday = logsRes.items || [];
    // 近 7 天依从率：契约无专用接口，按 /api/medlogs?date= 逐日汇总
    var days = [];
    for (var i = 6; i >= 0; i--) days.push(U.dateStr(U.addDays(new Date(), -i)));
    var results = await Promise.all(days.map(function (d) {
      return api.medlogs(d).catch(function () { return { items: [] }; });
    }));
    var taken = 0, skipped = 0, missed = 0, pendingToday = 0;
    results.forEach(function (r, idx) {
      var isToday = idx === results.length - 1;
      (r.items || []).forEach(function (log) {
        if (log.status === 'taken') taken++;
        else if (log.status === 'skipped') skipped++;
        else if (isToday) pendingToday++;
        else missed++;
      });
    });
    st.adherence = { taken: taken, skipped: skipped, missed: missed, pendingToday: pendingToday, total: taken + skipped + missed };
  }

  async function loadSettings() {
    st.settings = await api.getSettings();
    // APK 版本才显示蓝牙自动同步卡片；只读模式不读取/不请求
    if (bleBridge() && !BP.role.isReadOnly()) {
      try { await loadBleConfig(); } catch (e) { /* 卡片内展示错误 */ }
    }
  }

  async function loadAdminUsers() {
    var res = await api.adminUsersList();
    st.adminUsers = res.items || [];
    st.adminLoaded = true;
  }

  /* 加载医生/管理员的患者上下文；医生默认选中第一个绑定患者 */
  async function loadRoleContext() {
    st.patients = [];
    st.adminUsers = [];
    st.adminLoaded = false;
    st.viewPatientId = null;
    var r = BP.role.current();
    if (r === 'doctor' || r === 'admin') {
      try {
        var res = await api.patients();
        st.patients = res.items || [];
      } catch (e) {
        st.patients = [];
      }
    }
    if (r === 'doctor' && st.patients.length) {
      st.viewPatientId = st.patients[0].id;
    }
  }

  async function reloadCurrent() {
    var route = st.route;
    if (!st.auth.authenticated) return;
    try {
      if (route === 'home') await loadHome();
      else if (route === 'records') await loadRecords();
      else if (route === 'meds') await loadMeds();
      else if (route === 'settings') await loadSettings();
      else if (route === 'admin' && BP.role.isAdmin()) await loadAdminUsers();
      st.loaded[route] = true;
    } catch (e) { handleError(e); }
    render();
  }

  /* ================================================================== */
  /* 提醒                                                                */
  /* ================================================================== */
  function stopReminderPolling() {
    if (reminderTimer) { clearInterval(reminderTimer); reminderTimer = null; }
  }
  function startReminderPolling() {
    stopReminderPolling();
    if (!BP.role.canWrite()) return; // 医生/管理员查看患者时为只读，不轮询提醒
    fetchReminders(true);
    reminderTimer = setInterval(function () { fetchReminders(false); }, 60000);
  }

  async function fetchReminders(isInit) {
    if (!st.auth.authenticated || !BP.role.canWrite()) return;
    try {
      var r = await api.reminders();
      var next = r.items || [];
      var prevKeys = st.reminders.map(function (x) { return x.key; }).join('|');
      st.reminders = next;
      if (!isInit) {
        var keys = next.map(function (x) { return x.key; }).join('|');
        if (keys !== prevKeys) render();
      }
      announceReminders(next, isInit);
    } catch (e) { /* 提醒轮询失败静默 */ }
  }

  function announceReminders(items, isInitial) {
    if (!items || !items.length) return;
    var fresh = items.filter(function (r) { return !st.seenReminderKeys[r.key]; });
    if (!fresh.length) return;
    fresh.forEach(function (r) { st.seenReminderKeys[r.key] = true; });
    // 深链接打开弹层/指定页面时不弹 toast（避免遮挡截图与弹层内容），横幅仍然显示
    var hasDeepLink = !!new URLSearchParams(location.search).get('open');
    if (hasDeepLink || st.modals.length) return;
    var first = fresh[0];
    var message = first.title + '：' + first.body;
    if (isInitial) {
      // 首次进入页面时延后提示：顶部横幅已经足够醒目，避免一进来就遮挡内容/截图
      setTimeout(function () {
        if (st.modals.length) return;
        BP.ui.toast(message, 'info', 4200);
      }, 5600);
    } else {
      BP.ui.toast(message, 'info', 4200);
    }
    notifyBrowser(fresh);
  }

  /* APK（WebView 壳）注入的原生通知桥；浏览器环境返回 null */
  function nativeNotify() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPNativeNotify : null;
      if (b && typeof b.isSupported === 'function' && b.isSupported()) return b;
      return null;
    } catch (e) { return null; }
  }

  function notifyBrowser(items) {
    try {
      var bridge = nativeNotify();
      if (bridge && typeof bridge.notify === 'function') {
        (items || []).forEach(function (r) {
          try { bridge.notify(r.title || '血压管家', r.body || ''); } catch (e) { /* 静默 */ }
        });
        return;
      }
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      items.slice(0, 2).forEach(function (r) {
        try {
          new Notification(r.title || '血压管家', {
            body: r.body || '',
            tag: r.key,
            icon: 'icons/icon-192.png',
            badge: 'icons/icon-192.png'
          });
        } catch (e) { /* 静默 */ }
      });
    } catch (e) { /* 静默 */ }
  }

  /* 监听 APK 原生通知权限变化事件（启动时绑定一次） */
  function bindNativeNotifyEvents() {
    if (st._nativeNotifyBound) return;
    st._nativeNotifyBound = true;
    try {
      window.addEventListener('bp-native-notify-permission', function () {
        BP.ui.toast('通知权限状态已更新', 'info', 2600);
        if (st.auth.authenticated && st.route === 'settings' && !st.modals.length) render();
      });
    } catch (e) { /* 静默 */ }
  }

  /* ================================================================== */
  /* 血压记录弹层                                                         */
  /* ================================================================== */
  function openRecordModal(opts) {
    if (BP.role.isReadOnly()) {
      BP.ui.toast('只读模式，无法记录血压', 'error', 3000);
      return;
    }
    opts = opts || {};
    var data = { record: opts.record || null };
    if (opts.presetSlot) {
      var slot = findSlot(opts.presetSlot);
      if (slot) {
        data.presetTime = slot.target_time;
        data.presetAt = slotDate(slot.target_time);
      }
    }
    if (opts.presetAt) data.presetAt = opts.presetAt;
    BP.ui.openModal('record', data);
  }

  function findSlot(key) {
    var slots = (st.dashboard && st.dashboard.slots) || [];
    for (var i = 0; i < slots.length; i++) if (slots[i].key === key) return slots[i];
    return null;
  }

  function slotDate(hhmm) {
    var d = new Date();
    if (!hhmm || hhmm.indexOf(':') < 0) return d;
    var parts = hhmm.split(':');
    d.setHours(parseInt(parts[0], 10) || 0, parseInt(parts[1], 10) || 0, 0, 0);
    return d;
  }

  function openOcrModal() {
    if (BP.role.isReadOnly()) {
      BP.ui.toast('只读模式，无法上传识别', 'error', 3000);
      return;
    }
    var hasRecord = st.modals.some(function (m) { return m.name === 'record'; });
    if (!hasRecord) openRecordModal({});
    BP.ui.openModal('ocr', {});
  }

  function readRecordForm() {
    var v = {
      measured_at: U.combineDateTime(
        ($('f-measured-date') || {}).value,
        ($('f-measured-time') || {}).value
      ),
      systolic: parseInt(($('f-sys') || {}).value, 10),
      diastolic: parseInt(($('f-dia') || {}).value, 10),
      pulse: ($('f-pulse') || {}).value ? parseInt($('f-pulse').value, 10) : null,
      arm: ($('f-arm') || {}).value || 'left',
      position: ($('f-position') || {}).value || 'sitting',
      note: (($('f-note') || {}).value || '').trim()
    };
    return v;
  }

  function recordFormError(msg) {
    var el = $('f-error');
    if (el) { el.textContent = msg; el.hidden = false; el.classList.add('show'); }
    var box = $('modal-root');
    if (box) {
      var sheet = box.querySelector('.sheet-body');
      if (sheet) sheet.scrollTop = 0;
      var ov = box.querySelector('.overlay:last-child .sheet');
      if (ov) ov.scrollTop = 0;
    }
    BP.ui.toast(msg, 'error');
  }

  async function submitRecord() {
    if (BP.role.isReadOnly()) { BP.ui.toast('只读模式，无法保存记录', 'error'); return; }
    var v = readRecordForm();
    if (!v.measured_at) return recordFormError('请填写测量日期（如 2026-10-29）和时间（如 16:40）');
    if (!v.systolic || v.systolic < 60 || v.systolic > 260) return recordFormError('收缩压请填写 60–260 之间的数值');
    if (!v.diastolic || v.diastolic < 30 || v.diastolic > 180) return recordFormError('舒张压请填写 30–180 之间的数值');
    if (v.systolic <= v.diastolic) return recordFormError('收缩压应高于舒张压，请检查是否填反');
    if (v.pulse !== null && v.pulse !== '' && (isNaN(v.pulse) || v.pulse < 30 || v.pulse > 220)) return recordFormError('脉率请填写 30–220 之间的数值');
    var payload = {
      measured_at: v.measured_at,
      systolic: v.systolic,
      diastolic: v.diastolic,
      pulse: v.pulse || null,
      arm: v.arm,
      position: v.position,
      note: v.note
    };
    var entry = st.modals[st.modals.length - 1];
    var editing = entry && entry.name === 'record' && entry.data.record;
    if (!editing) {
      for (var i = st.modals.length - 1; i >= 0; i--) {
        if (st.modals[i].name === 'record') { editing = st.modals[i].data.record; break; }
      }
    }
    var btn = document.querySelector('form[data-form="record"] button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      if (editing) {
        await api.updateMeasurement(editing.id, payload);
      } else {
        await api.createMeasurement(payload);
      }
      BP.ui.closeAllModals();
      BP.ui.toast(editing ? '修改已保存' : '血压已记录，继续保持', 'success');
      st.loaded.home = false;
      st.loaded.records = false;
      await reloadCurrent();
      fetchReminders(false);
    } catch (err) {
      handleError(err);
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  async function deleteRecord(id) {
    var ok = await BP.ui.confirm({
      title: '删除这条记录？', message: '删除后无法恢复。', confirmText: '删除', danger: true
    });
    if (!ok) return;
    try {
      await api.deleteMeasurement(id);
      BP.ui.closeAllModals();
      BP.ui.toast('记录已删除', 'success');
      st.loaded.home = false;
      st.loaded.records = false;
      await reloadCurrent();
    } catch (err) { handleError(err); }
  }

  /* ================================================================== */
  /* OCR                                                                 */
  /* ================================================================== */
  function topModal() { return st.modals[st.modals.length - 1]; }

  async function handleOcrFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { BP.ui.toast('请选择图片文件（jpg / png）', 'error'); return; }
    if (file.size > 15 * 1024 * 1024) { BP.ui.toast('图片超过 15MB，请压缩后再试', 'error'); return; }
    var entry = topModal();
    if (!entry || entry.name !== 'ocr') return;
    entry.data.file = file;
    entry.data.previewUrl = URL.createObjectURL(file);
    entry.data.loading = true;
    entry.data.result = null;
    entry.data.error = null;
    entry.data.demo = false;
    BP.ui.refreshModals();
    try {
      var res = await api.ocrUpload(file);
      entry.data.loading = false;
      entry.data.result = res;
      BP.ui.refreshModals();
      if (res && res.candidates && res.candidates.length) {
        BP.ui.toast('识别到 ' + res.candidates.length + ' 条数值，请核对', 'success');
      } else {
        BP.ui.toast((res && res.message) || '没有识别到血压数值', 'error', 4200);
      }
    } catch (err) {
      entry.data.loading = false;
      entry.data.error = err.status === 503 || err.status === 404
        ? '服务器的拍照识别组件未安装或未启动，可以先手动输入。'
        : (err.message || '识别失败，请重试');
      BP.ui.refreshModals();
    }
  }

  function resetOcr() {
    var entry = topModal();
    if (!entry || entry.name !== 'ocr') return;
    entry.data = { fromRecord: entry.data.fromRecord };
    BP.ui.refreshModals();
  }

  function useCandidate(cand, demo) {
    if (!cand) return;
    var sysEl = $('f-sys'), diaEl = $('f-dia'), pulseEl = $('f-pulse');
    var dateEl = $('f-measured-date'), timeEl = $('f-measured-time');
    if (!sysEl || !diaEl) { BP.ui.toast('记录表单已关闭，请重新打开', 'error'); return; }
    sysEl.value = cand.systolic || '';
    diaEl.value = cand.diastolic || '';
    if (cand.pulse && pulseEl) pulseEl.value = cand.pulse;
    if (cand.measured_at && dateEl && timeEl) {
      var lv = U.localInputValue(cand.measured_at);
      dateEl.value = lv.slice(0, 10);
      timeEl.value = lv.slice(11, 16);
    }
    var entry = topModal();
    if (entry && entry.name === 'ocr') {
      entry.data.result = null;
      entry.data.previewUrl = null;
      entry.data.demo = false;
      BP.ui.closeModal();
    }
    var errEl = $('f-error'); if (errEl) errEl.hidden = true;
    BP.ui.toast('已填入识别结果，请核对后保存', 'success');
  }

  /* ================================================================== */
  /* 药品                                                                */
  /* ================================================================== */
  function collectMedForm() {
    var times = qsa('[id^="m-time-"]').map(function (el) { return el.value; }).filter(Boolean);
    return {
      name: (($('m-name') || {}).value || '').trim(),
      dose: parseFloat(($('m-dose') || {}).value),
      unit: ($('m-unit') || {}).value || '片',
      times: times,
      start_date: ($('m-start') || {}).value || U.todayStr(),
      end_date: ($('m-end') || {}).value || null,
      note: (($('m-note') || {}).value || '').trim()
    };
  }

  function openMedForm(med) {
    if (BP.role.isReadOnly()) {
      BP.ui.toast('只读模式，无法修改药品', 'error', 3000);
      return;
    }
    BP.ui.openModal('med', med ? { med: med } : {});
  }

  function timeAdd() {
    var entry = topModal();
    if (!entry || entry.name !== 'med') return;
    var form = collectMedForm();
    var last = U.normalizeTime(form.times[form.times.length - 1] || '08:00');
    if (!U.isValidTime(last)) last = '08:00';
    var hh = parseInt(last.slice(0, 2), 10) || 8;
    var next = U.pad((hh + 12) % 24) + ':00';
    form.times.push(next);
    entry.data.form = form;
    BP.ui.refreshModals();
  }

  function timeRemove(index) {
    var entry = topModal();
    if (!entry || entry.name !== 'med') return;
    var form = collectMedForm();
    if (form.times.length <= 1) return;
    form.times.splice(index, 1);
    entry.data.form = form;
    BP.ui.refreshModals();
  }

  async function submitMed() {
    if (BP.role.isReadOnly()) { BP.ui.toast('只读模式，无法保存药品', 'error'); return; }
    var entry = topModal();
    var form = collectMedForm();
    function fail(msg) {
      if (entry) entry.data.error = msg;
      BP.ui.refreshModals();
      BP.ui.toast(msg, 'error');
    }
    if (!form.name) return fail('请填写药品名称');
    if (!form.dose || isNaN(form.dose) || form.dose <= 0 || form.dose > 100) return fail('请填写正确的每次剂量');
    form.times = (form.times || []).map(function (t) { return U.normalizeTime(t); });
    if (!form.times.length) return fail('请至少添加一个服药时间');
    for (var i = 0; i < form.times.length; i++) {
      if (!U.isValidTime(form.times[i])) return fail('服药时间请用 24 小时制填写，如 08:00');
    }
    form.start_date = U.normalizeDate(form.start_date || U.todayStr());
    form.end_date = form.end_date ? U.normalizeDate(form.end_date) : '';
    if (!U.isValidDate(form.start_date)) return fail('开始日期格式应为 2026-10-01');
    if (form.end_date && !U.isValidDate(form.end_date)) return fail('结束日期格式应为 2026-12-31');
    if (form.end_date && form.start_date && form.end_date < form.start_date) return fail('结束日期不能早于开始日期');
    var payload = {
      name: form.name, dose: form.dose, unit: form.unit, times: form.times,
      start_date: form.start_date, end_date: form.end_date || null, note: form.note
    };
    try {
      if (entry && entry.name === 'med' && entry.data.med) {
        await api.updateMedication(entry.data.med.id, payload);
      } else {
        await api.createMedication(payload);
      }
      BP.ui.closeAllModals();
      BP.ui.toast(entry && entry.data.med ? '药品已更新' : '药品已添加，明天开始按时提醒', 'success');
      st.loaded.meds = false;
      st.loaded.home = false;
      await reloadCurrent();
    } catch (err) { handleError(err); }
  }

  async function stopMed(id) {
    var ok = await BP.ui.confirm({
      title: '停用这个药品？',
      message: '停用后不再生成每天的服药任务，历史服药记录会保留。',
      confirmText: '停用', danger: false
    });
    if (!ok) return;
    try {
      await api.updateMedication(id, { active: false });
      BP.ui.toast('药品已停用', 'success');
      st.loaded.meds = false;
      st.loaded.home = false;
      await reloadCurrent();
    } catch (err) { handleError(err); }
  }

  async function deleteMed(id) {
    var ok = await BP.ui.confirm({
      title: '删除这个药品？',
      message: '删除后不可恢复，历史服药记录会保留。', confirmText: '删除', danger: true
    });
    if (!ok) return;
    try {
      await api.deleteMedication(id);
      BP.ui.closeAllModals();
      BP.ui.toast('药品已删除', 'success');
      st.loaded.meds = false;
      st.loaded.home = false;
      await reloadCurrent();
    } catch (err) { handleError(err); }
  }

  async function medTaskAction(action, id) {
    if (BP.role.isReadOnly()) { BP.ui.toast('只读模式，无法修改服药记录', 'error'); return; }
    try {
      await api.medlogAction(id, action);
      var msg = action === 'take' ? '已打卡，记得按时吃药' : action === 'skip' ? '已标记跳过' : '已撤销打卡';
      BP.ui.toast(msg, 'success', 2200);
      st.loaded.meds = false;
      st.loaded.home = false;
      var route = st.route;
      if (route === 'meds') await loadMeds();
      else if (route === 'home') await loadHome();
      render();
      fetchReminders(false);
    } catch (err) {
      handleError(err);
    }
  }

  /* ================================================================== */
  /* 设置                                                                */
  /* ================================================================== */
  async function withButtonBusy(btn, fn) {
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try { return await fn(); }
    finally { if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); } }
  }

  function parseChannelForm(key) {
    var c = { enabled: !!($('ch-' + key + '-enabled') || {}).checked };
    if (key === 'ntfy') {
      c.server = (($('ch-ntfy-server') || {}).value || '').trim();
      c.topic = (($('ch-ntfy-topic') || {}).value || '').trim();
      c.token = (($('ch-ntfy-token') || {}).value || '').trim();
    } else if (key === 'pushplus') {
      c.token = (($('ch-pushplus-token') || {}).value || '').trim();
    } else if (key === 'email') {
      c.smtp_host = (($('ch-email-host') || {}).value || '').trim();
      c.smtp_port = parseInt(($('ch-email-port') || {}).value, 10) || 465;
      c.ssl = !!($('ch-email-ssl') || {}).checked;
      c.username = (($('ch-email-username') || {}).value || '').trim();
      c.password = (($('ch-email-password') || {}).value || '');
      c.to = (($('ch-email-to') || {}).value || '').trim();
    } else if (key === 'webhook') {
      c.url = (($('ch-webhook-url') || {}).value || '').trim();
      c.method = (($('ch-webhook-method') || {}).value || 'POST');
    }
    return c;
  }

  async function saveChannel(btn, key) {
    var c = parseChannelForm(key);
    if (c.enabled) {
      if (key === 'ntfy' && (!c.server || !c.topic)) return BP.ui.toast('请填写 ntfy 服务器和主题', 'error');
      if (key === 'pushplus' && !c.token) return BP.ui.toast('请填写 PushPlus Token', 'error');
      if (key === 'email' && (!c.smtp_host || !c.username || !c.password || !c.to)) return BP.ui.toast('请完整填写邮件通道', 'error');
      if (key === 'webhook' && !c.url) return BP.ui.toast('请填写 Webhook 地址', 'error');
    }
    await withButtonBusy(btn, async function () {
      var channels = Object.assign({}, st.settings.channels || {});
      channels[key] = c;
      try {
        st.settings = await api.putSettings({ channels: channels });
        BP.ui.toast('通知通道已保存', 'success');
        render();
      } catch (err) { handleError(err); }
    });
  }

  async function testChannel(btn, key) {
    await withButtonBusy(btn, async function () {
      try {
        var res = await api.testChannel(key);
        BP.ui.toast((res && res.message) || (res && res.ok ? '测试消息已发送' : '测试失败'), res && res.ok ? 'success' : 'error', 4200);
      } catch (err) { handleError(err); }
    });
  }

  async function saveSlots(btn) {
    var times = {};
    var invalid = false;
    ['morning', 'forenoon', 'afternoon', 'bedtime'].forEach(function (k) {
      var el = $('set-slot-' + k);
      if (!el) { invalid = true; return; }
      var v = U.normalizeTime(el.value);
      if (!U.isValidTime(v)) { invalid = true; return; }
      el.value = v;
      times[k] = v;
    });
    if (invalid) return BP.ui.toast('时段格式应为 24 小时制，如 06:30', 'error');
    await withButtonBusy(btn, async function () {
      try {
        st.settings = await api.putSettings({ slot_times: times });
        BP.ui.toast('测量时段已保存', 'success');
        st.loaded.home = false;
        render();
      } catch (err) { handleError(err); }
    });
  }

  async function saveTargets(btn) {
    var sys = parseInt(($('set-target-sys') || {}).value, 10);
    var dia = parseInt(($('set-target-dia') || {}).value, 10);
    if (!sys || sys < 80 || sys > 220) return BP.ui.toast('收缩压阈值请填写 80–220', 'error');
    if (!dia || dia < 40 || dia > 140) return BP.ui.toast('舒张压阈值请填写 40–140', 'error');
    if (sys <= dia) return BP.ui.toast('收缩压阈值应高于舒张压阈值', 'error');
    await withButtonBusy(btn, async function () {
      try {
        st.settings = await api.putSettings({ target_sys: sys, target_dia: dia });
        BP.ui.toast('判定阈值已保存', 'success');
        st.loaded.home = false;
        render();
      } catch (err) { handleError(err); }
    });
  }

  async function toggleReminder(input) {
    try {
      st.settings = await api.putSettings({ reminder_enabled: !!input.checked });
      BP.ui.toast(input.checked ? '提醒已开启' : '提醒已关闭', 'success', 2200);
    } catch (err) {
      input.checked = !input.checked;
      handleError(err);
    }
  }

  function enableNotifications() {
    // 1) APK 原生通知桥优先
    var bridge = nativeNotify();
    if (bridge) {
      try {
        var r = bridge.requestPermission();
        if (r === 'granted') {
          try { bridge.notify('血压管家', '系统通知已开启，提醒会显示在通知栏'); } catch (e2) { /* 静默 */ }
          BP.ui.toast('已开启系统通知', 'success');
          render();
        } else if (r === 'requesting') {
          BP.ui.toast('已请求通知权限，请在系统弹窗中允许', 'info', 4200);
        } else {
          BP.ui.toast('系统通知被关闭，请在手机系统设置里允许血压管家通知', 'error', 5000);
          render();
        }
      } catch (e) {
        BP.ui.toast('通知权限请求失败，请在手机系统设置中开启', 'error', 4500);
      }
      return;
    }
    // 2) 桥存在但 isSupported() 返回 false：APK 系统通知关闭
    try {
      if (typeof window !== 'undefined' && window.BPNativeNotify) {
        BP.ui.toast('系统通知被关闭，请在手机系统设置里允许血压管家通知', 'error', 5000);
        render();
        return;
      }
    } catch (e) { /* ignore */ }
    // 3) 浏览器 Notification
    if (typeof Notification === 'undefined') {
      return BP.ui.toast('当前环境不支持系统通知；请用血压管家 App，或使用日历/PushPlus 提醒', 'error', 4800);
    }
    try {
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') { BP.ui.toast('已开启系统通知', 'success'); notifyBrowser(st.reminders); }
        else if (p === 'denied') BP.ui.toast('通知权限被拒绝，可在浏览器设置里重新允许', 'error', 4000);
        else BP.ui.toast('未授权通知', 'info');
        render();
      }).catch(function () { BP.ui.toast('无法请求通知权限，请用浏览器设置开启', 'error'); });
    } catch (e) { /* 静默 */ }
  }

  /* ================================================================== */
  /* 导出                                                                */
  /* ================================================================== */
  function exportRangeFromModal() {
    var fromEl = $('x-from'), toEl = $('x-to');
    var from = U.normalizeDate(fromEl ? fromEl.value : '');
    var to = U.normalizeDate(toEl ? toEl.value : '');
    if (!U.isValidDate(from) || !U.isValidDate(to)) {
      BP.ui.toast('日期格式应为 2026-10-01（年-月-日）', 'error');
      return null;
    }
    if (fromEl) fromEl.value = from;
    if (toEl) toEl.value = to;
    if (to < from) { BP.ui.toast('结束日期不能早于开始日期', 'error'); return null; }
    return { from: from, to: to };
  }

  async function doExport(kind) {
    var range;
    if (kind === 'backup') range = { from: U.dateStr(U.addDays(new Date(), -29)), to: U.todayStr() };
    else {
      range = exportRangeFromModal();
      if (!range) return;
    }
    try {
      if (kind === 'xlsx') { BP.ui.toast('正在生成 Excel…'); await api.exportXlsx(range.from, range.to); }
      else if (kind === 'csv') { BP.ui.toast('正在生成 CSV…'); await api.exportCsv('bp', range.from, range.to); }
      else { BP.ui.toast('正在打包备份…'); await api.exportBackup(); }
      BP.ui.toast('文件已开始下载', 'success', 2600);
    } catch (err) { handleError(err); }
  }

  async function quickExport(kind) {
    var range = { from: U.dateStr(U.addDays(new Date(), -29)), to: U.todayStr() };
    try {
      if (kind === 'xlsx') { BP.ui.toast('正在生成 Excel…'); await api.exportXlsx(range.from, range.to); }
      else if (kind === 'csv') { BP.ui.toast('正在生成 CSV…'); await api.exportCsv('bp', range.from, range.to); }
      else { BP.ui.toast('正在打包备份…'); await api.exportBackup(); }
      BP.ui.toast('文件已开始下载', 'success', 2600);
    } catch (err) { handleError(err); }
  }

  // 日历提醒导出：/api/export/calendar.ics（Content-Type: text/calendar）
  async function exportCalendar() {
    try {
      await api.exportCalendar();
      BP.ui.toast('已导出日历提醒文件，用手机日历打开导入即可', 'success', 4200);
    } catch (err) { handleError(err); }
  }

  // 打印 / PDF 报告：新标签页打开后端 A4 报告（页面内自带打印 / 另存为 PDF 按钮）
  function exportReport() {
    if (BP.isMock) {
      BP.ui.toast('演示模式：连接真实服务后可生成报告', 'info', 4200);
      return;
    }
    var url = api.reportUrl(30);
    // APK v1.5：WebView 不支持 window.open / window.print；同页打开报告，由原生 BPPrint 打印
    var printBridge = (typeof window !== 'undefined') ? window.BPPrint : null;
    if (printBridge && typeof printBridge.print === 'function') {
      window.location.href = url;
      return;
    }
    var win = null;
    try {
      // 先开空白标签拿到窗口句柄以便识别弹窗拦截，再立即断开 opener 并导航（等价 noopener 语义）
      win = window.open('', '_blank');
      if (win) {
        try { win.opener = null; } catch (e) { /* 跨域时忽略 */ }
        win.location.href = url;
      }
    } catch (e) { win = null; }
    if (!win) {
      // 旧版 APK WebView 会拦截弹窗：退化为当前页打开，至少能看到报告；打印请升级到 v1.5
      BP.ui.toast('当前 App 不支持弹窗，已在当前页打开报告；App 内打印请更新到 v1.5', 'info', 5200);
      window.location.href = url;
    }
  }

  /* ================================================================== */
  /* App 原生日历同步（APK 注入 window.BPCalendarSync）                    */
  /* ================================================================== */
  function calendarSyncBridge() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPCalendarSync : null;
      if (b && typeof b.isSupported === 'function' && b.isSupported()) return b;
      return null;
    } catch (e) { return null; }
  }

  var CAL_SLOT_LABELS = { morning: '早上', forenoon: '上午', afternoon: '下午', bedtime: '睡前' };

  // 4 个测量时段事件（取设置里的目标时间）
  function buildCalendarEvents(settings) {
    var events = [];
    var slotTimes = (settings && settings.slot_times) || {};
    var windows = (settings && settings.slot_windows) || {};
    ['morning', 'forenoon', 'afternoon', 'bedtime'].forEach(function (k) {
      var time = slotTimes[k];
      if (!time) return;
      var label = CAL_SLOT_LABELS[k] || k;
      var win = windows[k] || [];
      var desc = '血压管家提醒：' + label + '时段' + (win.length ? '（' + win.join('–') + '）' : '') + '测量血压';
      events.push({ title: '测血压 · ' + label, time: time, duration: 20, until: null, description: desc });
    });
    return events;
  }

  // 药品服药时间事件（每种药每个 times 一条）
  function buildMedCalendarEvents(medications) {
    var events = [];
    (medications || []).forEach(function (med) {
      var doseText = (med.dose != null ? med.dose : '') + (med.unit || '');
      (med.times || []).forEach(function (t) {
        var desc = '血压管家提醒：' + (med.name || '服药') + ' 每次 ' + doseText;
        if (med.note) desc += '；备注：' + med.note;
        events.push({
          title: '吃药 · ' + (med.name || '') + ' ' + doseText,
          time: t,
          duration: 10,
          until: med.end_date || null,
          description: desc
        });
      });
    });
    return events;
  }

  function handleCalendarSyncResult(result) {
    var r = String(result == null ? '' : result);
    if (r === 'requesting') {
      BP.ui.toast('已请求日历权限，请在系统弹窗中允许', 'info', 4500);
      return;
    }
    if (r.indexOf('ok:') === 0) {
      var rest = r.slice(3);
      var sep = rest.indexOf(':');
      var count = sep >= 0 ? rest.slice(0, sep) : rest;
      var cal = sep >= 0 ? rest.slice(sep + 1) : '';
      st._calendarResultAt = Date.now(); // 若随后原生桥再回传事件，避免重复 toast
      BP.ui.toast('已写入 ' + (count || '0') + ' 条日历提醒（日历：' + (cal || '手机日历') + '）', 'success', 4500);
      if (st.route === 'settings' && !st.modals.length) render();
      return;
    }
    if (r.indexOf('error:') === 0) {
      BP.ui.toast(r.slice(6) || '日历同步失败，请重试', 'error', 4800);
      if (st.route === 'settings' && !st.modals.length) render();
      return;
    }
    BP.ui.toast('日历同步完成：' + r, 'success', 3600);
  }

  async function syncCalendar() {
    if (BP.role.isReadOnly()) {
      BP.ui.toast('只读模式，无法同步日历', 'error', 3200);
      return;
    }
    var bridge = calendarSyncBridge();
    if (!bridge) {
      BP.ui.toast('当前环境不支持一键同步，请使用「日历提醒 (.ics)」导入', 'error', 4500);
      return;
    }
    var settings = st.settings;
    if (!settings) {
      try { settings = await api.getSettings(); st.settings = settings; }
      catch (err) { handleError(err); return; }
    }
    var events = buildCalendarEvents(settings);
    var medsRes;
    try { medsRes = await api.medications(); }
    catch (err) { handleError(err); return; }
    events = events.concat(buildMedCalendarEvents((medsRes && medsRes.items) || []));
    var result;
    try { result = bridge.sync(JSON.stringify(events)); }
    catch (e) {
      BP.ui.toast('日历同步失败：' + ((e && e.message) || e), 'error', 4800);
      return;
    }
    handleCalendarSyncResult(result);
  }

  function clearCalendar() {
    if (BP.role.isReadOnly()) {
      BP.ui.toast('只读模式，无法清除日历提醒', 'error', 3200);
      return;
    }
    var bridge = calendarSyncBridge();
    if (!bridge || typeof bridge.clear !== 'function') {
      BP.ui.toast('当前环境不支持清除日历提醒', 'error', 4200);
      return;
    }
    var result;
    try { result = bridge.clear(); }
    catch (e) {
      BP.ui.toast('清除失败：' + ((e && e.message) || e), 'error', 4500);
      return;
    }
    var r = String(result == null ? '' : result);
    if (r.indexOf('ok:') === 0) {
      BP.ui.toast('已清除 ' + (r.slice(3) || '0') + ' 条本应用写入的日历提醒', 'success', 4200);
      if (st.route === 'settings' && !st.modals.length) render();
    } else if (r.indexOf('error:') === 0) {
      BP.ui.toast(r.slice(6) || '清除失败，请重试', 'error', 4800);
    } else {
      BP.ui.toast('清除完成：' + r, 'success', 3600);
    }
  }

  /* 监听 APK 原生日历同步/权限结果事件（启动时绑定一次） */
  function bindCalendarSyncEvents() {
    if (st._calendarSyncBound) return;
    st._calendarSyncBound = true;
    try {
      window.addEventListener('bp-calendar-sync-result', function (ev) {
        var d = (ev && ev.detail) || {};
        var recentDirect = st._calendarResultAt && (Date.now() - st._calendarResultAt < 2500);
        if (d && d.ok) {
          if (!recentDirect) {
            var count = d.count != null ? d.count : '若干';
            BP.ui.toast('已写入 ' + count + ' 条日历提醒（日历：' + (d.calendar || '手机日历') + '）', 'success', 4500);
          }
        } else if (!recentDirect) {
          BP.ui.toast((d && d.error) || '日历同步失败，请重试', 'error', 4800);
        }
        if (st.auth.authenticated && st.route === 'settings' && !st.modals.length) render();
      });
    } catch (e) { /* 静默 */ }
  }

  /* ================================================================== */
  /* App 蓝牙自动同步（APK v1.4 注入 window.BPBleSync）                   */
  /* ================================================================== */
  // 注意：bindkey 只保存在内存闭包中，绝不可写入 state/DOM/日志
  var bleBindkey = '';

  st.bleConfig = null;      // {configured, mac, enabled, unavailable?}（不含 bindkey）
  st.bleError = null;
  st.bleLoading = false;
  st._bleImporting = false;
  st._bleManualRequest = false;

  function bleBridge() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPBleSync : null;
      if (b && typeof b.configure === 'function' && typeof b.start === 'function') return b;
      return null;
    } catch (e) { return null; }
  }

  function renderSettingsIfNeeded() {
    if (st.auth.authenticated && st.route === 'settings' && !st.modals.length) render();
  }

  // GET /api/ble/config → state（bindkey 留在内存闭包）
  async function loadBleConfig() {
    st.bleLoading = true;
    st.bleError = null;
    try {
      var cfg = await BP.api.request('/api/ble/config');
      if (cfg && cfg.configured) {
        st.bleConfig = { configured: true, mac: cfg.mac || '', enabled: !!cfg.enabled };
        if (cfg.bindkey) bleBindkey = String(cfg.bindkey);
        var b = bleBridge();
        if (b && bleBindkey) {
          try { b.configure(st.bleConfig.mac, bleBindkey); } catch (e) { /* 静默 */ }
        }
      } else {
        st.bleConfig = { configured: false };
        bleBindkey = '';
      }
    } catch (err) {
      // 旧后端无该接口：隐藏卡片；其他错误在卡片内提示
      if (err && (err.status === 404 || err.status === 405)) {
        st.bleConfig = { unavailable: true };
      } else {
        st.bleError = (err && err.message) || '蓝牙配置加载失败';
      }
    } finally {
      st.bleLoading = false;
    }
    return st.bleConfig;
  }

  // 用户主动开启/关闭蓝牙同步
  async function setBleEnabled(enabled) {
    if (BP.role.isReadOnly()) { BP.ui.toast('只读模式，无法修改蓝牙设置', 'error', 3200); return; }
    var b = bleBridge();
    if (!b) { BP.ui.toast('当前环境不支持蓝牙自动同步', 'error', 4200); return; }
    var cfg = st.bleConfig;
    if (!cfg || !cfg.configured) { BP.ui.toast('服务器尚未配置蓝牙设备', 'error', 4200); return; }
    if (!bleBindkey) { BP.ui.toast('蓝牙配置不完整，请稍后重试', 'error', 4200); return; }
    try {
      var res = await BP.api.request('/api/ble/config', {
        method: 'PUT',
        body: { mac: cfg.mac, bindkey: bleBindkey, enabled: !!enabled }
      });
      st.bleConfig = {
        configured: true,
        mac: (res && res.mac) || cfg.mac,
        enabled: !!(res && res.enabled !== undefined ? res.enabled : enabled)
      };
      if (res && res.bindkey) bleBindkey = String(res.bindkey);
    } catch (err) {
      BP.ui.toast((err && err.message) || '保存蓝牙配置失败', 'error', 4500);
      renderSettingsIfNeeded();
      return;
    }
    try {
      if (st.bleConfig.enabled) {
        b.configure(st.bleConfig.mac, bleBindkey);
        var r = String(b.start() || '');
        if (r === 'started') {
          st._bleManualRequest = false;
          BP.ui.toast('蓝牙自动同步已开启', 'success', 3000);
        } else if (r === 'requesting') {
          st._bleManualRequest = true;
          BP.ui.toast('请允许附近设备权限', 'info', 4800);
        } else {
          BP.ui.toast(r.indexOf('error:') === 0 ? r.slice(6) : '蓝牙同步启动失败，请重试', 'error', 4800);
        }
      } else {
        try { b.stop(); } catch (e) { /* 静默 */ }
        st._bleManualRequest = false;
        if (enabled) BP.ui.toast('蓝牙同步未能开启，请稍后重试', 'error', 4200);
        else BP.ui.toast('蓝牙自动同步已关闭', 'info', 2600);
      }
    } catch (e) {
      BP.ui.toast('蓝牙操作失败，请重试', 'error', 4200);
    }
    renderSettingsIfNeeded();
  }

  // "2026-10-30T01:20:00"（无时区）→ 带本地偏移的 ISO8601
  function bleMeasuredAt(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return v;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (isNaN(d.getTime())) return v;
    return U.toIso(U.localInputValue(d));
  }

  // 启动时导入桥里待处理的测量记录（失败保留 pending）
  async function bleImportPending() {
    var b = bleBridge();
    if (!b || BP.role.isReadOnly()) return 0;
    if (st._bleImporting) return 0;
    if (!st.bleConfig || !st.bleConfig.configured || !st.bleConfig.enabled) return 0;
    var raw;
    try { raw = b.getPending(); } catch (e) { return 0; }
    var list;
    try { list = JSON.parse(raw || '[]'); } catch (e) { return 0; }
    if (!Array.isArray(list) || !list.length) return 0;
    st._bleImporting = true;
    var okIds = [];
    var count = 0;
    try {
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        if (!it || it.id == null) continue;
        var measuredAt = bleMeasuredAt(it.measured_at);
        var sys = Number(it.systolic);
        var dia = Number(it.diastolic);
        if (!measuredAt || !sys || !dia) continue;
        try {
          await api.createMeasurement({
            measured_at: measuredAt,
            systolic: sys,
            diastolic: dia,
            pulse: it.pulse != null ? Number(it.pulse) : null,
            source: 'ble',
            note: '蓝牙自动同步'
          });
          okIds.push(it.id);
          count++;
        } catch (e) { /* 单条失败：保留 pending，下次再试 */ }
      }
      if (okIds.length) {
        try { b.clearPending(JSON.stringify(okIds)); } catch (e) { /* 静默 */ }
        st.dashboard = null; st.homeStats = null; st.measurements = null; st.stats = null;
        st.loaded = {};
        try { await reloadCurrent(); } catch (e) { /* 静默 */ }
        BP.ui.toast('已自动导入 ' + count + ' 条蓝牙血压记录', 'success', 4500);
      }
    } finally {
      st._bleImporting = false;
    }
    return count;
  }

  // 启动自动初始化/导入：不主动弹权限（requesting 静默等待事件）
  async function initBleAutoSync() {
    var b = bleBridge();
    if (!b || BP.role.isReadOnly()) return;
    await loadBleConfig();
    if (!st.bleConfig || !st.bleConfig.configured) return;
    try { b.configure(st.bleConfig.mac, bleBindkey); } catch (e) { /* 静默 */ }
    if (st.bleConfig.enabled) {
      try {
        var running = false;
        if (typeof b.isRunning === 'function') running = !!b.isRunning();
        if (!running) b.start(); // requesting/error 都静默，等权限事件
      } catch (e) { /* 静默 */ }
      await bleImportPending();
    }
  }

  function scheduleBleAutoSync() {
    if (!bleBridge() || BP.role.isReadOnly()) return;
    setTimeout(function () { initBleAutoSync(); }, 700);
  }

  /* 监听 APK 附近设备权限事件：授权后自动重试 start */
  function bindBleEvents() {
    if (st._bleBound) return;
    st._bleBound = true;
    try {
      window.addEventListener('bp-ble-sync-permission', function () {
        var b = bleBridge();
        if (!b) return;
        if (!(st.bleConfig && st.bleConfig.configured && st.bleConfig.enabled)) return;
        try {
          var r = String(b.start() || '');
          if (r === 'started') {
            if (st._bleManualRequest) {
              st._bleManualRequest = false;
              BP.ui.toast('附近设备权限已授权，蓝牙同步已开启', 'success', 3600);
              renderSettingsIfNeeded();
            }
          }
        } catch (e) { /* 静默 */ }
      });
    } catch (e) { /* 静默 */ }
  }

  /* ---------- 从备份恢复（POST /api/import/backup，覆盖模式） ---------- */
  function handleBackupFile(file) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      BP.ui.toast('备份文件不能超过 20MB', 'error', 4200);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var data = null;
      try {
        data = JSON.parse(String(reader.result || ''));
      } catch (e) {
        BP.ui.toast('备份文件格式不正确', 'error', 4200);
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        BP.ui.toast('备份文件格式不正确', 'error', 4200);
        return;
      }
      confirmRestoreBackup(data);
    };
    reader.onerror = function () {
      BP.ui.toast('读取备份文件失败，请重试', 'error', 4200);
    };
    reader.readAsText(file);
  }

  async function confirmRestoreBackup(backup) {
    var ok = await BP.ui.confirm({
      title: '从备份恢复',
      message: '恢复会覆盖当前所有测量与药品数据，确定继续？',
      confirmText: '恢复',
      cancelText: '取消',
      danger: true
    });
    if (!ok) return;
    try {
      var res = await api.restoreBackup(backup);
      var imported = (res && res.imported) || {};
      var m = imported.measurements != null ? imported.measurements : 0;
      var med = imported.medications != null ? imported.medications : 0;
      var logs = imported.med_logs != null ? imported.med_logs : 0;
      BP.ui.toast('已恢复：血压 ' + m + ' 条、药品 ' + med + ' 种、服药记录 ' + logs + ' 条', 'success', 5200);
      // 失效缓存并重新拉取当前页面数据
      st.dashboard = null;
      st.measurements = null;
      st.recordsTotal = 0;
      st.stats = null;
      st.homeStats = null;
      st.meds = null;
      st.medlogsToday = null;
      st.adherence = null;
      st.settings = null;
      st.loaded = {};
      st.loading = {};
      await reloadCurrent();
      fetchReminders(false);
    } catch (err) {
      handleError(err);
    }
  }

  function chooseBackupFile() {
    var input = $('backup-file');
    if (!input) {
      BP.ui.toast('请先回到「设置」页再试', 'error', 3000);
      return;
    }
    try { input.click(); } catch (e) { BP.ui.toast('无法打开文件选择器', 'error', 3000); }
  }

  /* ================================================================== */
  /* 角色 / 患者切换                                                      */
  /* ================================================================== */
  function switchPatient(idStr) {
    var id = (idStr === '' || idStr == null) ? null : Number(idStr);
    if (BP.role.isDoctor() && !id) {
      BP.ui.toast('请选择要查看的患者', 'error', 3000);
      return;
    }
    if (id != null && isNaN(id)) id = null;
    if (id === st.viewPatientId) return;
    st.viewPatientId = id;
    st.dashboard = null;
    st.measurements = null;
    st.recordsTotal = 0;
    st.stats = null;
    st.homeStats = null;
    st.meds = null;
    st.medlogsToday = null;
    st.adherence = null;
    st.settings = null;
    st.reminders = [];
    st.loaded = {};
    st.loading = {};
    stopReminderPolling();
    render();
    ensureRoute(st.route, true);
    startReminderPolling();
    if (BP.role.canWrite()) scheduleBleAutoSync(); // 返回自己的数据后恢复蓝牙同步
    var name = id ? BP.role.patientName(id) : '';
    BP.ui.toast(id ? '正在查看 ' + name + ' 的数据（只读）' : '已返回我的数据', 'info', 2800);
  }

  function switchSelf() { switchPatient(null); }

  /* ================================================================== */
  /* 用户管理（仅管理员）                                                  */
  /* ================================================================== */
  function openAdminUserModal(user) {
    var users = st.adminUsers || [];
    BP.ui.openModal('adminUser', {
      user: user || null,
      doctors: users.filter(function (u) { return u.role === 'doctor'; }),
      patients: users.filter(function (u) { return u.role === 'user'; })
    });
  }

  function bindCheckboxValues(kind) {
    return qsa('[data-bind="' + kind + '"]').filter(function (el) { return el.checked; })
      .map(function (el) { return Number(el.value); });
  }

  async function submitAdminUser() {
    var entry = st.modals[st.modals.length - 1];
    if (!entry || entry.name !== 'adminUser') return;
    var editing = entry.data.user;
    var usernameEl = $('ad-username');
    var displayEl = $('ad-display');
    var roleEl = $('ad-role');
    var passEl = $('ad-password');
    var username = editing ? editing.username : ((usernameEl || {}).value || '').trim();
    var display = ((displayEl || {}).value || '').trim();
    var role = (roleEl || {}).value || (editing ? editing.role : 'user');
    var password = (passEl || {}).value || '';
    function fail(msg) {
      entry.data.error = msg;
      BP.ui.refreshModals();
      BP.ui.toast(msg, 'error');
    }
    if (!editing) {
      if (!username) return fail('请填写用户名');
      if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return fail('用户名 2-32 位，可用字母、数字、_ . -');
      if (password.length < 6) return fail('密码至少 6 位');
    } else if (password && password.length < 6) {
      return fail('新密码至少 6 位');
    }
    if (['admin', 'user', 'doctor'].indexOf(role) < 0) return fail('角色不正确');
    var desiredDoctors = (editing && role === 'user') ? bindCheckboxValues('doctor') : null;
    var desiredPatients = (editing && role === 'doctor') ? bindCheckboxValues('patient') : null;
    try {
      var saved;
      if (!editing) {
        saved = await api.adminCreateUser({ username: username, password: password, display_name: display, role: role });
        BP.ui.closeAllModals();
        BP.ui.toast('已创建用户 ' + (display || username), 'success', 3200);
      } else {
        var patch = { display_name: display };
        var roleChanged = editing.role !== role;
        if (!(roleEl && roleEl.disabled)) patch.role = role;
        if (password) patch.password = password;
        saved = await api.adminUpdateUser(editing.id, patch);
        // 角色变更时先清理不再适用的旧绑定，再按新角色重建
        if (roleChanged) {
          var oldDocs = (editing.doctor_ids || []).slice();
          var oldPats = (editing.patient_ids || []).slice();
          for (var od = 0; od < oldDocs.length; od++) await api.adminUnlink(oldDocs[od], editing.id);
          for (var op = 0; op < oldPats.length; op++) await api.adminUnlink(editing.id, oldPats[op]);
          editing.doctor_ids = [];
          editing.patient_ids = [];
        }
        // 绑定关系按角色做 diff
        if (role === 'user' && desiredDoctors) {
          var curDoc = (editing.doctor_ids || []).map(Number);
          for (var di = 0; di < curDoc.length; di++) {
            if (desiredDoctors.indexOf(curDoc[di]) < 0) await api.adminUnlink(curDoc[di], editing.id);
          }
          for (var ai = 0; ai < desiredDoctors.length; ai++) {
            if (curDoc.indexOf(desiredDoctors[ai]) < 0) await api.adminLink(desiredDoctors[ai], editing.id);
          }
        } else if (role === 'doctor' && desiredPatients) {
          var curPat = (editing.patient_ids || []).map(Number);
          for (var pi = 0; pi < curPat.length; pi++) {
            if (desiredPatients.indexOf(curPat[pi]) < 0) await api.adminUnlink(editing.id, curPat[pi]);
          }
          for (var pj = 0; pj < desiredPatients.length; pj++) {
            if (curPat.indexOf(desiredPatients[pj]) < 0) await api.adminLink(editing.id, desiredPatients[pj]);
          }
        }
        BP.ui.closeAllModals();
        BP.ui.toast('用户已更新', 'success', 3000);
      }
      st.adminLoaded = false;
      await loadAdminUsers();
      if (saved && st.user && Number(saved.id) === Number(st.user.id) && saved.display_name != null) {
        st.user.display_name = saved.display_name;
      }
      render();
    } catch (err) {
      entry.data.error = err.message || '保存失败';
      BP.ui.refreshModals();
      handleError(err);
    }
  }

  async function deleteAdminUser(id) {
    var u = (st.adminUsers || []).filter(function (x) { return Number(x.id) === Number(id); })[0];
    var name = u ? (u.display_name || u.username) : ('#' + id);
    var ok = await BP.ui.confirm({
      title: '删除用户？',
      message: '将删除「' + name + '」及其全部健康数据，且不可恢复。',
      confirmText: '删除', danger: true
    });
    if (!ok) return;
    try {
      await api.adminDeleteUser(id);
      BP.ui.toast('用户已删除', 'success', 3000);
      if (Number(st.viewPatientId) === Number(id)) {
        st.viewPatientId = null;
        st.dashboard = null; st.measurements = null; st.stats = null; st.homeStats = null;
        st.meds = null; st.medlogsToday = null; st.settings = null;
        st.loading = {};
      }
      st.adminLoaded = false;
      await loadAdminUsers();
      render();
    } catch (err) { handleError(err); }
  }


  /* ================================================================== */
  /* 提醒操作                                                            */
  /* ================================================================== */
  async function snoozeReminder(key) {
    if (!key) return;
    try {
      await api.snooze(key, 10);
      st.reminders = st.reminders.filter(function (r) { return r.key !== key; });
      st.seenReminderKeys[key] = true;
      BP.ui.toast('好，10 分钟后再提醒', 'success', 2400);
      render();
      BP.ui.refreshModals();
    } catch (err) { handleError(err); }
  }

  function reminderDo(key) {
    var r = null;
    for (var i = 0; i < st.reminders.length; i++) if (st.reminders[i].key === key) { r = st.reminders[i]; break; }
    BP.ui.closeAllModals();
    if (!r) return;
    if (r.kind === 'med') {
      go('meds');
      return;
    }
    openRecordModal({ presetSlot: r.slot, presetAt: new Date() });
  }

  /* ================================================================== */
  /* 认证                                                                */
  /* ================================================================== */
  function showAuthError(msg) {
    var el = $('auth-error');
    if (el) { el.textContent = msg; el.hidden = false; el.classList.add('show'); }
    BP.ui.toast(msg, 'error', 3800);
  }

  async function refreshCaptcha() {
    if (st.auth.authenticated || st.authView === 'setup') return;
    st.captcha = { status: 'loading', id: null, image: null };
    render();
    try {
      var res = await api.captcha();
      if (!res || !res.image) throw new (U.ApiError)('验证码数据异常', 500);
      st.captcha = { status: 'ready', id: res.id, image: res.image, expiresIn: res.expires_in };
    } catch (err) {
      if (err && err.status === 404) {
        // 旧后端没有验证码接口：隐藏验证码区域，按旧方式登录
        st.captcha = { status: 'unavailable' };
      } else {
        st.captcha = { status: 'error', error: (err && err.message) || '验证码加载失败' };
      }
    }
    render();
  }

  async function gotoAuthenticated() {
    st.authChecked = true;
    st.captcha = null;
    st.lastLoginUsername = null;
    await loadRoleContext(); // 医生/管理员的患者上下文需先就绪，避免首屏 403
    applyPatientParam();
    st.route = parseRoute();
    if (st.route === 'admin' && !BP.role.isAdmin()) st.route = 'home';
    try { history.replaceState(null, '', '#/' + st.route); } catch (e) { }
    render({ scrollTop: true });
    ensureRoute(st.route);
    startReminderPolling();
    scheduleBleAutoSync();
  }

  function readLoginUsername() {
    var el = $('login-username');
    return el ? String(el.value || '').trim() : '';
  }

  async function doLogin() {
    var input = $('login-password');
    var pw = input ? input.value : '';
    var username = readLoginUsername();
    if (!username) return showAuthError('请输入用户名');
    if (!pw) return showAuthError('请输入密码');
    st.lastLoginUsername = username;
    var captchaId = null;
    var captchaCode = '';
    if (st.captcha && st.captcha.status === 'ready') {
      captchaId = st.captcha.id;
      var capInput = $('login-captcha');
      captchaCode = capInput ? String(capInput.value || '').trim() : '';
      if (!captchaCode) return showAuthError('请输入验证码');
    } else if (st.captcha && st.captcha.status === 'loading') {
      return showAuthError('验证码加载中，请稍候');
    } else if (st.captcha && st.captcha.status === 'error') {
      return showAuthError('验证码加载失败，请点击「换一张」重试');
    }
    var btn = document.querySelector('form[data-form="login"] button[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      await api.login(username, pw, captchaId, captchaCode);
      var status = await api.authStatus();
      if (!status.authenticated) throw new (U.ApiError)('登录状态未生效，请重试', 401);
      st.auth = status;
      st.user = status.user || null;
      U.storageSet('bp_last_username', username);
      BP.ui.toast('欢迎回来，' + ((status.user && (status.user.display_name || status.user.username)) || username), 'success', 1800);
      await gotoAuthenticated();
    } catch (err) {
      var loginMsg;
      if (err && err.status === 401) loginMsg = '用户名或密码不正确';
      else if (err && err.status === 423) loginMsg = err.message || '账号已锁定，请稍后再试';
      else loginMsg = (err && err.message) || '登录失败';
      // 任何原因失败都刷新验证码并清空输入（重新渲染会生成空输入框）
      await refreshCaptcha();
      showAuthError(loginMsg);
      var btn2 = document.querySelector('form[data-form="login"] button[type="submit"]');
      if (btn2) { btn2.disabled = false; btn2.classList.remove('is-busy'); }
    }
  }

  async function doSetup() {
    var username = (($('setup-username') || {}).value || '').trim() || 'admin';
    var pw = ($('setup-password') || {}).value || '';
    var pw2 = ($('setup-password2') || {}).value || '';
    var btn = document.querySelector('form[data-form="setup"] button[type="submit"]');
    if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return showAuthError('用户名 2-32 位，可用字母、数字、_ . -');
    if (pw.length < 6) return showAuthError('密码至少 6 位');
    if (pw !== pw2) return showAuthError('两次输入的密码不一致');
    if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
    try {
      await api.setup(pw, username);
      var status = await api.authStatus();
      st.auth = status;
      st.user = status.user || null;
      U.storageSet('bp_last_username', username);
      if (status.authenticated) {
        // setup 会建立会话（契约），无需再走带验证码的登录
        BP.ui.toast('设置成功，欢迎使用血压管家', 'success', 2600);
        await gotoAuthenticated();
      } else {
        st.authView = 'login';
        st.authChecked = true;
        st.captcha = null;
        render();
        await refreshCaptcha();
        BP.ui.toast('账号已创建，请登录', 'success');
      }
    } catch (err) {
      showAuthError(err.message || '设置失败');
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  async function updateDisplayName() {
    var input = $('profile-display');
    var errEl = $('profile-error');
    var value = ((input || {}).value || '').trim();
    var btn = document.querySelector('form[data-form="profile"] button[type="submit"]');
    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; errEl.classList.add('show'); }
      BP.ui.toast(msg, 'error');
    }
    if (value.length > 32) return fail('显示名称最多 32 个字符');
    try {
      if (btn) { btn.disabled = true; btn.classList.add('is-busy'); }
      var result = await api.updateProfile(value);
      if (result && result.user) {
        st.user = result.user;
        if (st.auth) st.auth.user = result.user;
      }
      if (errEl) { errEl.hidden = true; errEl.classList.remove('show'); }
      BP.ui.toast('显示名称已更新', 'success');
      await reloadCurrent();
    } catch (err) {
      fail(err.message || '显示名称修改失败');
    } finally {
      if (btn) { btn.disabled = false; btn.classList.remove('is-busy'); }
    }
  }

  async function changePassword() {
    var oldPw = ($('pw-old') || {}).value || '';
    var newPw = ($('pw-new') || {}).value || '';
    var newPw2 = ($('pw-new2') || {}).value || '';
    var errEl = $('pw-error');
    function fail(msg) {
      if (errEl) { errEl.textContent = msg; errEl.hidden = false; errEl.classList.add('show'); }
      BP.ui.toast(msg, 'error');
    }
    if (!oldPw) return fail('请输入当前密码');
    if (newPw.length < 6) return fail('新密码至少 6 位');
    if (newPw !== newPw2) return fail('两次输入的新密码不一致');
    try {
      await api.changePassword(oldPw, newPw);
      if (errEl) errEl.hidden = true;
      ['pw-old', 'pw-new', 'pw-new2'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
      BP.ui.toast('密码已修改', 'success');
    } catch (err) { fail(err.message || '修改失败'); }
  }

  async function doLogout() {
    var ok = await BP.ui.confirm({ title: '退出登录？', message: '退出后需要重新输入密码才能查看记录。', confirmText: '退出', danger: false });
    if (!ok) return;
    try { await api.logout(); } catch (e) { /* ignore */ }
    stopReminderPolling();
    st.auth = { initialized: true, authenticated: false };
    st.user = null;
    st.patients = [];
    st.viewPatientId = null;
    st.adminUsers = [];
    st.adminLoaded = false;
    st.authView = 'login';
    st.authChecked = true;
    st.dashboard = null; st.measurements = null; st.meds = null; st.medlogsToday = null;
    st.settings = null; st.stats = null; st.homeStats = null; st.adherence = null;
    st.loaded = {}; st.loading = {}; st.reminders = []; st.seenReminderKeys = {};
    st.captcha = null;
    st.lastLoginUsername = null;
    bleBindkey = '';
    st.bleConfig = null; st.bleError = null; st._bleManualRequest = false;
    BP.ui.closeAllModals();
    render({ scrollTop: true });
    refreshCaptcha();
    BP.ui.toast('已退出登录', 'info', 2000);
  }

  /* ================================================================== */
  /* 事件委托                                                            */
  /* ================================================================== */
  function bindEvents() {
    document.addEventListener('click', function (ev) {
      var a = ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!a) return;
      var action = a.getAttribute('data-action');
      if (action === 'overlay-close') {
        if (ev.target === a) BP.ui.closeModal();
        return;
      }
      ev.preventDefault();
      handleAction(action, a, ev);
    });

    document.addEventListener('submit', function (ev) {
      var form = ev.target.closest ? ev.target.closest('form[data-form]') : null;
      if (!form) return;
      ev.preventDefault();
      var name = form.getAttribute('data-form');
      if (name === 'login') doLogin();
      else if (name === 'setup') doSetup();
      else if (name === 'record') submitRecord();
      else if (name === 'med') submitMed();
      else if (name === 'password') changePassword();
      else if (name === 'profile') updateDisplayName();
      else if (name === 'adminUser') submitAdminUser();
    });

    document.addEventListener('change', function (ev) {
      var t = ev.target;
      if (!t) return;
      // OCR 两个入口共用同一上传/识别逻辑：拍照（capture）与相册选择（普通文件选择）
      if (t.id === 'ocr-file-camera' || t.id === 'ocr-file-gallery') {
        handleOcrFile(t.files && t.files[0]);
        t.value = ''; // 允许再次选择同一张图片
        return;
      }
      if (t.id === 'backup-file') {
        handleBackupFile(t.files && t.files[0]);
        t.value = ''; // 允许再次选择同一个文件
        return;
      }
      if (t.id === 'set-reminder') { toggleReminder(t); return; }
      if (t.id === 'ble-enabled') { setBleEnabled(t.checked); return; }
      if (t.id === 'patient-switch') { switchPatient(t.value); return; }
      if (t.id === 'ad-role') {
        var isDoc = t.value === 'doctor';
        var isUser = t.value === 'user';
        var bindDoc = $('ad-bind-doctors');
        var bindPat = $('ad-bind-patients');
        if (bindDoc) bindDoc.hidden = !isUser;
        if (bindPat) bindPat.hidden = !isDoc;
        return;
      }
    });

    // 24 小时制时间 / 日期文本输入：输入时自动补分隔符，失焦时规范化
    document.addEventListener('input', function (ev) {
      var t = ev.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-time-input]')) {
        var td = t.value.replace(/\D/g, '').slice(0, 4);
        t.value = td.length > 2 ? td.slice(0, 2) + ':' + td.slice(2) : td;
      } else if (t.matches('[data-date-input]')) {
        var dd = t.value.replace(/\D/g, '').slice(0, 8);
        var out = dd;
        if (dd.length > 4) out = dd.slice(0, 4) + '-' + dd.slice(4);
        if (dd.length > 6) out = dd.slice(0, 4) + '-' + dd.slice(4, 6) + '-' + dd.slice(6);
        t.value = out;
      }
    });
    document.addEventListener('focusout', function (ev) {
      var t = ev.target;
      if (!t || !t.matches) return;
      if (t.matches('[data-time-input]') && t.value.trim()) t.value = U.normalizeTime(t.value);
      if (t.matches('[data-date-input]') && t.value.trim()) t.value = U.normalizeDate(t.value);
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && st.modals.length) { BP.ui.closeModal(); }
    });

    // 表单里回车提交（避免浏览器原生提交导致刷新）
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter' || !ev.target) return;
      var tag = (ev.target.tagName || '').toLowerCase();
      if (tag === 'textarea') return;
      var form = ev.target.closest ? ev.target.closest('form[data-form]') : null;
      if (!form) return;
      if (ev.target.tagName === 'BUTTON') return;
      ev.preventDefault();
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
    });
  }

  var WRITE_ACTIONS = {
    'new-record': 1, 'open-record': 1, 'open-ocr': 1, 'edit-record': 1, 'delete-record': 1,
    'open-med-form': 1, 'edit-med': 1, 'stop-med': 1, 'delete-med': 1,
    'med-time-add': 1, 'med-time-remove': 1,
    'med-take': 1, 'med-skip': 1, 'med-undo': 1, 'med-toggle': 1,
    'save-slots': 1, 'save-targets': 1, 'save-channel': 1, 'test-channel': 1,
    'restore-backup': 1, 'export-backup': 1, 'snooze': 1, 'reminder-do': 1,
    'sync-calendar': 1, 'clear-calendar': 1
  };

  function handleAction(action, a, ev) {
    // 只读模式（医生 / 管理员查看患者）下拦截写操作
    if (BP.role.isReadOnly() && WRITE_ACTIONS[action]) {
      BP.ui.toast('只读模式，无法修改数据', 'error', 3200);
      return;
    }
    var route, el, id;
    switch (action) {
      case 'go': go(a.getAttribute('data-route')); break;
      case 'reload':
        route = a.getAttribute('data-route') || st.route;
        st.loaded[route] = false;
        ensureRoute(route, true);
        break;
      case 'new-record': openRecordModal({ presetSlot: a.getAttribute('data-slot') || null }); break;
      case 'open-record': openRecordModal({}); break;
      case 'edit-record':
        id = Number(a.getAttribute('data-id'));
        var rec = findRecord(id);
        if (rec) openRecordModal({ record: rec }); else BP.ui.toast('记录不存在，请刷新后重试', 'error');
        break;
      case 'delete-record': deleteRecord(Number(a.getAttribute('data-id'))); break;
      case 'open-ocr': openOcrModal(); break;
      case 'open-diagnostics': window.location.href = '/bt-test.html'; break;
      case 'open-med-form': openMedForm(null); break;
      case 'edit-med':
        id = Number(a.getAttribute('data-id'));
        var med = (st.meds || []).filter(function (m) { return m.id === id; })[0];
        if (med) openMedForm(med); else BP.ui.toast('药品不存在，请刷新后重试', 'error');
        break;
      case 'stop-med': stopMed(Number(a.getAttribute('data-id'))); break;
      case 'delete-med': deleteMed(Number(a.getAttribute('data-id'))); break;
      case 'med-time-add': timeAdd(); break;
      case 'med-time-remove': timeRemove(Number(a.getAttribute('data-index'))); break;
      case 'med-take': medTaskAction('take', Number(a.getAttribute('data-id'))); break;
      case 'med-skip': medTaskAction('skip', Number(a.getAttribute('data-id'))); break;
      case 'med-undo': medTaskAction('undo', Number(a.getAttribute('data-id'))); break;
      case 'med-toggle':
        id = Number(a.getAttribute('data-id'));
        var status = a.getAttribute('data-status');
        medTaskAction(status === 'pending' ? 'take' : 'undo', id);
        break;
      case 'modal-close': BP.ui.closeModal(); break;
      case 'confirm-ok':
        var entry = st.modals[st.modals.length - 1];
        if (entry && entry.name === 'confirm') {
          var resolve = entry.data.resolve;
          BP.ui.closeModal();
          if (resolve) resolve(true);
        }
        break;
      case 'confirm-cancel':
        var entry2 = st.modals[st.modals.length - 1];
        if (entry2 && entry2.name === 'confirm') {
          var r2 = entry2.data.resolve;
          BP.ui.closeModal();
          if (r2) r2(false);
        }
        break;
      case 'pick-option': {
        var group = a.getAttribute('data-group');
        var value = a.getAttribute('data-value');
        var hidden = $(group);
        if (hidden) hidden.value = value;
        var groupEl = a.closest('.seg-seg');
        if (groupEl) {
          Array.prototype.forEach.call(groupEl.querySelectorAll('.seg-opt'), function (b) {
            b.classList.toggle('active', b === a);
          });
        }
        break;
      }
      case 'toggle-pw': {
        var target = $(a.getAttribute('data-target'));
        if (target) {
          var show = target.type === 'password';
          target.type = show ? 'text' : 'password';
          a.innerHTML = BP.icons.icon(show ? 'eye-off' : 'eye', 21);
        }
        break;
      }
      case 'stats-days': {
        var days = Number(a.getAttribute('data-days')) || 7;
        if (days === st.statsDays) break;
        st.statsDays = days;
        render();
        api.stats(days).then(function (s) {
          st.stats = s;
          render();
        }).catch(handleError);
        break;
      }
      case 'toggle-series': {
        var series = a.getAttribute('data-series');
        st.series[series] = !st.series[series];
        render();
        break;
      }
      case 'open-export': BP.ui.openModal('export', {}); break;
      case 'export-range': {
        var daysAttr = a.getAttribute('data-days');
        var now = new Date();
        var fromD = new Date(now.getTime());
        if (daysAttr === 'month') {
          fromD = new Date(now.getFullYear(), now.getMonth(), 1);
        } else {
          fromD.setDate(fromD.getDate() - ((parseInt(daysAttr, 10) || 30) - 1));
        }
        var fEl = $('x-from'), tEl = $('x-to');
        if (fEl) fEl.value = U.dateStr(fromD);
        if (tEl) tEl.value = U.dateStr(now);
        var wrap = a.parentNode;
        if (wrap) {
          Array.prototype.forEach.call(wrap.querySelectorAll('.chip-btn'), function (b) {
            b.classList.toggle('on', b === a);
          });
        }
        break;
      }
      case 'set-now': {
        var dateEl = $('f-measured-date'), timeEl = $('f-measured-time');
        if (dateEl) dateEl.value = U.nowDateInput();
        if (timeEl) timeEl.value = U.nowTimeInput();
        break;
      }
      case 'toast-close': BP.ui.dismissToast(a.closest('.toast')); break;
      case 'do-export-xlsx': doExport('xlsx'); break;
      case 'do-export-csv': doExport('csv'); break;
      case 'do-export-backup': doExport('backup'); break;
      case 'export-xlsx': quickExport('xlsx'); break;
      case 'export-csv': quickExport('csv'); break;
      case 'export-backup': quickExport('backup'); break;
      case 'export-calendar': exportCalendar(); break;
      case 'export-report': exportReport(); break;
      case 'sync-calendar': syncCalendar(); break;
      case 'clear-calendar': clearCalendar(); break;
      case 'restore-backup': chooseBackupFile(); break;
      case 'go-admin': go('admin'); break;
      case 'ble-retry':
        loadBleConfig().then(function () { renderSettingsIfNeeded(); });
        break;
      case 'refresh-captcha': refreshCaptcha(); break;
      case 'switch-self': switchSelf(); break;
      case 'admin-new-user': openAdminUserModal(null); break;
      case 'admin-edit-user': {
        var target = (st.adminUsers || []).filter(function (u) { return Number(u.id) === Number(a.getAttribute('data-id')); })[0];
        if (target) openAdminUserModal(target);
        else BP.ui.toast('用户不存在，请刷新后重试', 'error');
        break;
      }
      case 'admin-delete-user': deleteAdminUser(Number(a.getAttribute('data-id'))); break;
      case 'open-reminders': BP.ui.openModal('reminders', {}); break;
      case 'snooze': snoozeReminder(a.getAttribute('data-key')); break;
      case 'reminder-do': reminderDo(a.getAttribute('data-key')); break;
      case 'save-slots': saveSlots(a); break;
      case 'save-targets': saveTargets(a); break;
      case 'save-channel': saveChannel(a, a.getAttribute('data-channel')); break;
      case 'test-channel': testChannel(a, a.getAttribute('data-channel')); break;
      case 'enable-notifications': enableNotifications(); break;
      case 'stepper': {
        var input = $(a.getAttribute('data-target'));
        if (!input) break;
        var delta = Number(a.getAttribute('data-delta')) || 0;
        var val = Number(input.value) || 0;
        var min = Number(input.getAttribute('min')) || 0;
        var max = Number(input.getAttribute('data-max')) || (Number(input.getAttribute('max')) || 999);
        input.value = Math.max(min, Math.min(max, val + delta));
        break;
      }
      case 'logout': doLogout(); break;
      case 'ocr-reset': resetOcr(); break;
      case 'ocr-manual': {
        var top = topModal();
        if (top && top.name === 'ocr') BP.ui.closeModal();
        var hasRec = st.modals.some(function (m) { return m.name === 'record'; });
        if (!hasRec) openRecordModal({});
        BP.ui.toast('请手动填写血压数值', 'info', 2400);
        break;
      }
      case 'use-candidate': {
        var topOcr = topModal();
        if (!topOcr || topOcr.name !== 'ocr' || !topOcr.data.result) break;
        var idx = Number(a.getAttribute('data-index')) || 0;
        useCandidate((topOcr.data.result.candidates || [])[idx]);
        break;
      }
      case 'use-candidate-demo': useCandidate({ systolic: 152, diastolic: 93, pulse: 78 }, true); break;
      default: break;
    }
  }

  function findRecord(id) {
    var pools = [st.measurements, (st.dashboard && st.dashboard.measurements_today) || []];
    for (var i = 0; i < pools.length; i++) {
      for (var j = 0; j < (pools[i] || []).length; j++) {
        if (Number(pools[i][j].id) === id) return pools[i][j];
      }
    }
    return null;
  }

  /* ================================================================== */
  /* 深链接（方便截图与直接打开功能）                                      */
  /* 支持 ?mock=1&open=record|record-edit|ocr|ocr-result|med|med-edit|     */
  /*      export|reminders|channel|home|records|meds|settings             */
  /* ================================================================== */
  function applyChannelDeepLink(key) {
    if (st.route === 'settings' && st.loaded.settings) {
      st.openChannel = key;
      render();
      st.openChannel = null;
      return;
    }
    st.pendingOpenChannel = key;
    go('settings');
  }

  async function applyMedEditDeepLink() {
    try {
      if (!st.meds || !st.meds.length) {
        var res = await api.medications(true);
        st.meds = res.items || [];
      }
      openMedForm(st.meds.length ? st.meds[0] : null);
    } catch (e) {
      openMedForm(null);
    }
  }

  function applyDeepLink() {
    var params = new URLSearchParams(location.search);
    var open = params.get('open');
    if (!open) return;
    // 只读模式下不为写操作弹层做深链接
    var writeOpens = ['record', 'record-edit', 'ocr', 'ocr-result', 'med', 'med-edit'];
    if (BP.role.isReadOnly() && writeOpens.indexOf(open) >= 0) {
      BP.ui.toast('只读模式，无法修改数据', 'info', 3000);
      return;
    }
    if (ROUTES.indexOf(open) >= 0) { go(open); return; }
    if (open === 'record') { openRecordModal({}); return; }
    if (open === 'record-edit') {
      var rec = (st.dashboard && st.dashboard.latest) || (st.measurements || [])[0] || null;
      openRecordModal(rec ? { record: rec } : {});
      return;
    }
    if (open === 'ocr') { openOcrModal(); return; }
    if (open === 'ocr-result') {
      openRecordModal({});
      BP.ui.openModal('ocr', {
        demo: true,
        result: {
          engine: 'rapidocr',
          image_type: 'monitor',
          candidates: [{ systolic: 152, diastolic: 93, pulse: 78, measured_at: null, confidence: 0.93, evidence: '152 93 78' }],
          raw_text: ['152', '93', '78', 'mmHg', 'PULSE'],
          upload_id: 7,
          message: '识别到 1 条测量记录（演示数据）'
        }
      });
      return;
    }
    if (open === 'export') { BP.ui.openModal('export', {}); return; }
    if (open === 'med') { openMedForm(null); return; }
    if (open === 'med-edit') { applyMedEditDeepLink(); return; }
    if (open === 'reminders') { BP.ui.openModal('reminders', {}); return; }
    if (open === 'channel') { applyChannelDeepLink(params.get('channel') || 'ntfy'); return; }
  }

  /* 深链接 ?patient=<id>：管理员/医生直接查看指定患者（截图/分享用） */
  function applyPatientParam() {
    var pid = Number(new URLSearchParams(location.search).get('patient'));
    if (!pid || isNaN(pid)) return;
    if (!BP.role.isAdmin() && !BP.role.isDoctor()) return;
    if ((st.patients || []).some(function (p) { return Number(p.id) === pid; })) {
      st.viewPatientId = pid;
    }
  }

  /* ================================================================== */
  /* Service Worker                                                      */
  /* ================================================================== */
  function registerSW() {
    try {
      if (!('serviceWorker' in navigator)) return;
      if (!(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '[::1]')) return;
      navigator.serviceWorker.register('sw.js').catch(function () { /* HTTP 环境静默降级 */ });
    } catch (e) { /* 静默 */ }
  }

  /* ================================================================== */
  /* 启动                                                                */
  /* ================================================================== */
  async function boot() {
    appEl = $('app');
    if (!appEl) return;
    // 初始化默认图表样式；先渲染 splash
    render();
    var status = null;
    try {
      status = await api.authStatus();
    } catch (err) {
      status = { initialized: true, authenticated: false };
      setTimeout(function () { BP.ui.toast(err.message || '无法连接服务器', 'error', 4200); }, 400);
    }
    st.auth = status;
    st.user = status.user || null;
    st.authChecked = true;
    if (st.auth.authenticated) {
      await loadRoleContext();
      applyPatientParam();
      st.route = parseRoute();
      if (st.route === 'admin' && !BP.role.isAdmin()) st.route = 'home';
      try { history.replaceState(null, '', '#/' + st.route); } catch (e) { }
      render({ scrollTop: true });
      ensureRoute(st.route);
      startReminderPolling();
      scheduleBleAutoSync();
      setTimeout(applyDeepLink, 420);
    } else {
      st.authView = st.auth.initialized ? 'login' : 'setup';
      st.captcha = null;
      render({ scrollTop: true });
      if (st.authView === 'login') refreshCaptcha();
    }
    registerSW();
    bindNativeNotifyEvents();
    bindCalendarSyncEvents();
    bindBleEvents();
  }

  BP.onUnauthorized = function () {
    if (!st.auth.authenticated) return;
    stopReminderPolling();
    st.auth.authenticated = false;
    st.user = null;
    st.patients = [];
    st.viewPatientId = null;
    st.adminUsers = [];
    st.adminLoaded = false;
    st.authView = 'login';
    st.authChecked = true;
    st.captcha = null;
    bleBindkey = '';
    st.bleConfig = null; st.bleError = null; st._bleManualRequest = false;
    BP.ui.closeAllModals();
    render({ scrollTop: true });
    refreshCaptcha();
    BP.ui.toast('登录已过期，请重新登录', 'error');
  };

  // 供调试/自检使用
  window.BPApp = {
    state: st,
    go: go,
    render: render,
    reload: reloadCurrent,
    boot: boot,
    openRecordModal: openRecordModal,
    applyDeepLink: applyDeepLink,
    enableNotifications: enableNotifications,
    notifyBrowser: notifyBrowser,
    bindNativeNotifyEvents: bindNativeNotifyEvents,
    syncCalendar: syncCalendar,
    clearCalendar: clearCalendar,
    buildCalendarEvents: buildCalendarEvents,
    buildMedCalendarEvents: buildMedCalendarEvents,
    bindCalendarSyncEvents: bindCalendarSyncEvents,
    loadBleConfig: loadBleConfig,
    setBleEnabled: setBleEnabled,
    initBleAutoSync: initBleAutoSync,
    bleImportPending: bleImportPending
  };

  bindEvents();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
