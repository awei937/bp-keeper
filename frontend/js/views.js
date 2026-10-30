/* 血压管家 — 视图层：所有页面与弹层的 HTML 渲染（纯字符串，无框架） */
(function () {
  'use strict';
  window.BP = window.BP || {};
  var U = BP.util;

  function S() { return BP.state; }
  function I(name, size, opts) { return BP.icons.icon(name, size, opts); }
  function logo(size, uid) { return BP.icons.logo(size, { uid: uid || 'a' }); }
  function e(s) { return U.esc(s); }

  /* ---- 角色上下文辅助 ---- */
  function role() { return BP.role.current(); }
  function isDoctor() { return BP.role.isDoctor(); }
  function isAdmin() { return BP.role.isAdmin(); }
  function readOnly() { return BP.role.isReadOnly(); }
  function canWrite() { return BP.role.canWrite(); }
  function curUser() { return BP.role.user(); }
  function viewingName() { return BP.role.viewingPatient(); }
  var ROLE_CN = { admin: '管理员', user: '普通用户', doctor: '医生' };
  function roleLabel(r) { return ROLE_CN[r] || '普通用户'; }
  function patientSelectHtml(includeSelf) {
    var st = S();
    var html = '';
    if (includeSelf) html += '<option value="">我的数据</option>';
    (st.patients || []).forEach(function (p) {
      var val = String(p.id);
      html += '<option value="' + val + '"' + (String(st.viewPatientId) === val ? ' selected' : '') + '>' +
        e(p.display_name || p.username) + '</option>';
    });
    return '<select id="patient-switch" class="patient-select" aria-label="切换查看患者">' + html + '</select>';
  }

  var views = {};
  BP.views = views;

  /* ================================================================== */
  /* 认证页：登录 / 首次设置密码                                          */
  /* ================================================================== */
  views.auth = function () {
    var st = S();
    var setup = st.authView === 'setup';
    // 用户名默认留空；登录失败重渲染时保留用户输入，否则回填 localStorage 记住的上次用户名
    var lastUser = st.lastLoginUsername || U.storageGet('bp_last_username') || '';
    var demoHint = BP.isMock
      ? '<p class="auth-demo">演示模式：任意用户名 / 密码 / 验证码即可进入（admin / userA / doctorD 可体验不同角色）</p>'
      : '';
    var userField = '<label class="field"><span class="field-label">用户名</span>' +
      '<input class="input input-lg" id="' + (setup ? 'setup-username' : 'login-username') + '" type="text" autocomplete="username" ' +
      'inputmode="text" placeholder="' + (setup ? 'admin' : '请输入用户名') + '" value="' + e(setup ? (lastUser || 'admin') : lastUser) + '"' +
      (setup ? '' : ' data-autofocus') + '></label>';

    // 登录验证码（旧后端无 /api/auth/captcha 时整个区域隐藏）
    var captchaHtml = '';
    if (!setup) {
      var cap = st.captcha;
      if (!cap || cap.status === 'loading') {
        captchaHtml = '<div class="field captcha-field"><span class="field-label">验证码</span>' +
          '<div class="captcha-loading">验证码加载中…</div></div>';
      } else if (cap.status === 'ready') {
        captchaHtml = '<div class="field captcha-field"><span class="field-label">验证码</span>' +
          '<div class="captcha-row">' +
          '<input class="input captcha-input" id="login-captcha" type="text" autocomplete="off" maxlength="8" ' +
          'placeholder="验证码" aria-label="验证码">' +
          '<img class="captcha-img" src="' + e(cap.image) + '" alt="验证码图片" title="点击换一张" data-action="refresh-captcha">' +
          '<button type="button" class="btn btn-ghost btn-sm captcha-refresh" data-action="refresh-captcha">换一张</button>' +
          '</div></div>';
      } else if (cap.status === 'error') {
        captchaHtml = '<div class="field captcha-field"><span class="field-label">验证码</span>' +
          '<div class="captcha-loading">验证码加载失败，' +
          '<button type="button" class="link-btn captcha-retry" data-action="refresh-captcha">点击重试</button></div></div>';
      }
      // status === 'unavailable'：旧后端，不渲染验证码区域
    }

    return '' +
      '<div class="auth-screen">' +
      '<div class="auth-deco auth-deco-1"></div><div class="auth-deco auth-deco-2"></div>' +
      '<div class="auth-card">' +
      '<div class="auth-logo">' + logo(72, 'auth') + '</div>' +
      '<h1 class="auth-title">血压管家</h1>' +
      '<p class="auth-sub">' + (setup ? '第一次使用，创建管理员账号' : '家人的血压与吃药，都记在这里') + '</p>' +
      (setup
        ? '<form class="auth-form" data-form="setup" novalidate>' +
          userField +
          '<label class="field"><span class="field-label">访问密码</span>' +
          '<span class="input-wrap"><input class="input input-lg" id="setup-password" type="password" inputmode="text" autocomplete="new-password" placeholder="至少 6 位，建议含字母和数字">' +
          '<button type="button" class="pw-toggle" data-action="toggle-pw" data-target="setup-password" aria-label="显示密码">' + I('eye', 21) + '</button></span></label>' +
          '<label class="field"><span class="field-label">确认密码</span>' +
          '<span class="input-wrap"><input class="input input-lg" id="setup-password2" type="password" autocomplete="new-password" placeholder="再输入一次">' +
          '<button type="button" class="pw-toggle" data-action="toggle-pw" data-target="setup-password2" aria-label="显示密码">' + I('eye', 21) + '</button></span></label>' +
          '<p class="form-error" id="auth-error" hidden></p>' +
          '<button class="btn btn-primary btn-block btn-xl" type="submit">开始使用</button>' +
          '<p class="auth-hint">第一个账号自动成为管理员；密码保存在你自己的服务器上。</p>' +
          '</form>'
        : '<form class="auth-form" data-form="login" novalidate>' +
          userField +
          '<label class="field"><span class="field-label">密码</span>' +
          '<span class="input-wrap"><input class="input input-lg" id="login-password" type="password" autocomplete="current-password" placeholder="请输入密码">' +
          '<button type="button" class="pw-toggle" data-action="toggle-pw" data-target="login-password" aria-label="显示密码">' + I('eye', 21) + '</button></span></label>' +
          captchaHtml +
          '<p class="form-error" id="auth-error" hidden></p>' +
          '<button class="btn btn-primary btn-block btn-xl" type="submit">登录</button>' +
          '<p class="auth-hint">请输入用户名和密码；验证码用于防止暴力登录</p>' +
          demoHint +
          '</form>') +
      '<div class="auth-feats">' +
      '<span class="auth-feat">' + I('pulse', 18) + '血压记录</span>' +
      '<span class="auth-feat">' + I('pill', 18) + '吃药提醒</span>' +
      '<span class="auth-feat">' + I('shield', 18) + '数据私有</span>' +
      '</div>' +
      '</div>' +
      '<p class="auth-foot">血压管家 · 为家人准备的健康小工具</p>' +
      '</div>';
  };

  /* ================================================================== */
  /* 应用外壳                                                             */
  /* ================================================================== */
  views.shell = function () {
    return views.header() +
      views.shellBanner() +
      '<main class="app-main" id="main">' + views.page() + '</main>' +
      (S().route === 'home' && canWrite() ? views.dock() : '') +
      views.tabbar();
  };

  /* 医生只读横幅 / 管理员查看患者横幅 / 医生无绑定患者提示 */
  views.shellBanner = function () {
    var st = S();
    if (isDoctor()) {
      if (!st.patients || !st.patients.length) {
        return '<section class="ro-banner ro-empty">' +
          '<div class="ro-ic">' + I('shield', 22) + '</div>' +
          '<div class="ro-main"><p class="ro-title">医生账号暂未绑定患者</p>' +
          '<p class="ro-sub">请联系管理员在「用户管理」里为你绑定患者后刷新页面</p></div></section>';
      }
      return '<section class="ro-banner">' +
        '<div class="ro-ic">' + I('eye', 22) + '</div>' +
        '<div class="ro-main"><p class="ro-title">只读模式 · 正在查看 ' + e(viewingName()) + '</p>' +
        '<p class="ro-sub">医生账号只能查看与导出，不能修改数据</p></div>' +
        '<div class="ro-switch">' + patientSelectHtml(false) + '</div>' +
        '</section>';
    }
    if (isAdmin() && st.viewPatientId) {
      return '<section class="ro-banner">' +
        '<div class="ro-ic">' + I('eye', 22) + '</div>' +
        '<div class="ro-main"><p class="ro-title">正在查看 ' + e(viewingName()) + ' 的数据（只读）</p>' +
        '<p class="ro-sub">返回自己的数据后可继续记录与修改</p></div>' +
        '<button type="button" class="btn btn-sm btn-soft" data-action="switch-self">返回我的数据</button>' +
        '</section>';
    }
    return '';
  };

  views.header = function () {
    var st = S();
    var d = new Date();
    var dateLine = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + U.cnDate(d).split(' ')[1];
    var count = st.reminders.length;
    var r = role();
    var roleChip = r === 'user' ? '' : '<span class="role-pill role-' + r + '">' + roleLabel(r) + '</span>';
    var title;
    if (readOnly() && viewingName()) title = '只读查看：' + viewingName();
    else if (isDoctor()) title = '医生视图';
    else title = U.greeting() + '，' + (curUser().display_name || '爸妈');
    var patientSwitch = '';
    if (isAdmin() && st.patients && st.patients.length) {
      patientSwitch = '<label class="patient-switch-wrap"><span class="ps-label">查看</span>' + patientSelectHtml(true) + '</label>';
    }
    return '' +
      '<header class="topbar"><div class="topbar-inner">' +
      '<div class="greet-block">' +
      '<p class="greet-date">' + dateLine + (BP.isMock ? '<span class="mock-pill">演示模式</span>' : '') + roleChip + '</p>' +
      '<h1 class="greet-title">' + e(title) + '</h1>' +
      '</div>' +
      '<div class="topbar-actions">' + patientSwitch +
      (canWrite() ? '<button type="button" class="icon-btn bell-btn" data-action="open-reminders" aria-label="查看提醒">' +
        I('bell', 24, { sw: 1.9 }) +
        (count ? '<span class="bell-badge">' + count + '</span>' : '') +
        '</button>' : '') +
      '</div>' +
      '</div></header>';
  };

  views.tabbar = function () {
    var route = S().route;
    var doctor = isDoctor();
    var tabs = [
      ['home', '首页', 'home'],
      ['records', '记录', 'records'],
      ['meds', doctor ? '用药' : '吃药', 'pill'],
      ['settings', doctor ? '报告' : '设置', 'sliders']
    ];
    return '<nav class="tabbar" aria-label="主导航"><div class="tabbar-inner">' +
      tabs.map(function (t) {
        var active = route === t[0] || (t[0] === 'settings' && route === 'admin');
        return '<button type="button" class="tab-btn' + (active ? ' active' : '') + '" data-action="go" data-route="' + t[0] + '"' +
          (active ? ' aria-current="page"' : '') + '>' +
          '<span class="tab-ico">' + I(t[2], 25, { sw: active ? 2.1 : 1.8 }) + '</span>' +
          '<span class="tab-label">' + t[1] + '</span></button>';
      }).join('') +
      '</div></nav>';
  };

  views.dock = function () {
    if (!canWrite()) return '';
    return '' +
      '<div class="action-dock"><div class="action-dock-inner">' +
      '<button type="button" class="btn btn-primary btn-record" data-action="new-record">' +
      I('plus', 26, { sw: 2.2 }) + '<span>记录血压</span></button>' +
      '<button type="button" class="btn btn-soft btn-ocr" data-action="open-ocr">' +
      I('camera', 25) + '<span>拍照识别</span></button>' +
      '</div></div>';
  };

  views.page = function () {
    switch (S().route) {
      case 'records': return views.records();
      case 'meds': return views.meds();
      case 'settings': return views.settings();
      case 'admin': return views.adminUsers();
      default: return views.home();
    }
  };

  /* 医生未绑定患者 / 无患者时的空状态 */
  views.noPatientPage = function () {
    return '<div class="page">' + emptyState('shield', '还没有绑定患者', '请联系管理员在「用户管理 → 绑定医生-患者」中为你绑定患者，绑定后刷新即可查看。') + '</div>';
  };

  /* ================================================================== */
  /* 通用小组件                                                           */
  /* ================================================================== */
  function secHead(title, meta, actionHtml) {
    return '<div class="sec-head"><div class="sec-title-wrap"><h2 class="sec-title">' + title + '</h2>' +
      (meta ? '<span class="sec-meta">' + meta + '</span>' : '') + '</div>' + (actionHtml || '') + '</div>';
  }

  function emptyState(iconName, title, desc, action) {
    return '<div class="empty"><div class="empty-ic">' + I(iconName, 44, { sw: 1.5 }) + '</div>' +
      '<h3>' + e(title) + '</h3><p>' + e(desc || '') + '</p>' + (action || '') + '</div>';
  }

  function skeletonCards(n) {
    var s = '';
    for (var i = 0; i < n; i++) s += '<div class="card skeleton-card"><div class="sk sk-line w60"></div><div class="sk sk-line w90"></div><div class="sk sk-line w40"></div></div>';
    return s;
  }

  function skeletonPage() {
    return '<div class="page">' +
      '<div class="sk sk-hello"></div>' +
      '<div class="slot-grid">' + [0, 1, 2, 3].map(function () {
        return '<div class="slot-card sk-card"><div class="sk sk-line w50"></div><div class="sk sk-line w80"></div><div class="sk sk-line w40"></div></div>';
      }).join('') + '</div>' +
      '<div class="card skeleton-card tall"><div class="sk sk-line w40"></div><div class="sk sk-block"></div></div>' +
      '</div>';
  }

  function levelChip(sys, dia) {
    var lv = U.bpLevel(sys, dia);
    if (!lv.key || lv.key === 'none') return '';
    return '<span class="level-chip ' + lv.cls + '">' + lv.label + '</span>';
  }

  function pill(text, cls, iconName) {
    if (!text) return '';
    return '<span class="tag ' + (cls || '') + '">' + (iconName ? I(iconName, 14, { sw: 2 }) : '') + e(text) + '</span>';
  }

  /* ================================================================== */
  /* 提醒横幅                                                             */
  /* ================================================================== */
  views.reminderBanner = function (items) {
    if (!items || !items.length) return '';
    var top = items[0];
    var extra = items.length > 1 ? '等 ' + items.length + ' 项待办' : '待办提醒';
    return '<section class="reminder-banner" role="status">' +
      '<div class="rb-icon">' + I('alarm', 24, { sw: 1.9 }) + '</div>' +
      '<div class="rb-main">' +
      '<p class="rb-title">' + e(top.title || '有待办提醒') + '</p>' +
      '<p class="rb-body">' + e(top.body || '') + (items.length > 1 ? ' · ' + extra : '') + '</p>' +
      '<div class="rb-actions">' +
      '<button type="button" class="btn btn-sm btn-primary" data-action="reminder-do" data-key="' + e(top.key) + '">' +
      (top.kind === 'med' ? '去打卡' : '去记录') + '</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-action="snooze" data-key="' + e(top.key) + '">稍后 10 分钟</button>' +
      '</div>' +
      '</div></section>';
  };

  /* ================================================================== */
  /* 首页                                                                 */
  /* ================================================================== */
  views.home = function () {
    var st = S();
    if (isDoctor() && !st.viewPatientId) return views.noPatientPage();
    var d = st.dashboard;
    if (!d) {
      if (st.loading.home) return skeletonPage();
      return '<div class="page">' + emptyState('alert-circle', '首页暂时加载不出来', '请检查网络，或稍后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="home">重新加载</button>') + '</div>';
    }
    var nowHM = d.now ? U.hm(d.now) : U.hm(new Date());
    var doneCount = d.slots.filter(function (s) { return s.done; }).length;
    return '<div class="page page-home">' +
      (canWrite() ? views.reminderBanner(st.reminders) : '') +
      '<div class="home-layout">' +
      '<div class="home-col home-col-main">' +
      '<section class="home-sec">' +
      secHead('今日测量', '已完成 ' + doneCount + '/' + d.slots.length + ' 个时段') +
      '<div class="slot-grid">' + d.slots.map(function (s) { return views.slotCard(s, nowHM); }).join('') + '</div>' +
      '</section>' +
      views.latestCard(d.latest) +
      '</div>' +
      '<div class="home-col home-col-side">' +
      views.homeMedsCard(d.meds || []) +
      views.trendCard() +
      '</div>' +
      '</div>' +
      '</div>';
  };

  views.slotCard = function (slot, nowHM) {
    var state = slot.done ? 'done' : (slot.window && slot.window[1] && nowHM > slot.window[1] ? 'missed' : 'pending');
    var win = (slot.window || []).join('–');
    var last = slot.last;
    var writable = canWrite();
    var stateText = state === 'done' ? '已完成' : state === 'missed' ? '已错过' : '待测量';
    var tag = writable ? 'button' : 'div';
    var attrs = writable
      ? ' type="button" data-action="new-record" data-slot="' + e(slot.key) + '"'
      : '';
    var footRight = last
      ? '<span class="slot-pulse">脉 ' + U.num(last.pulse) + '</span>'
      : '<span class="slot-pulse">' + (writable ? '点此记录' : '未记录') + '</span>';
    return '<' + tag + attrs + ' class="slot-card slot-' + state + (writable ? '' : ' slot-static') + '">' +
      '<span class="slot-top">' +
      '<span class="slot-label">' + e(slot.label) + '</span>' +
      '<span class="slot-state-ic">' + I(state === 'done' ? 'check-circle' : state === 'missed' ? 'alert-circle' : 'clock', 19, { sw: 2 }) + '</span>' +
      '</span>' +
      '<span class="slot-window">' + e(win) + ' · 目标 ' + e(slot.target_time) + '</span>' +
      '<span class="slot-value">' + (last
        ? U.num(last.systolic) + '<em>/</em>' + U.num(last.diastolic) + '<small>mmHg</small>'
        : '<span class="slot-empty">待测量</span>') + '</span>' +
      '<span class="slot-foot"><span class="slot-state">' + stateText + '</span>' + footRight +
      '</span></' + tag + '>';
  };

  views.latestCard = function (latest) {
    if (!latest) {
      return '<section class="latest-card latest-empty">' +
        '<div class="latest-top"><span class="latest-tag">最近一次测量</span></div>' +
        '<p class="latest-none">' + (canWrite() ? '还没有血压记录，点下面的「记录血压」开始吧' : '该患者还没有血压记录') + '</p>' +
        '</section>';
    }
    var lv = U.bpLevel(latest.systolic, latest.diastolic);
    var st = S();
    var ts = st.settings ? st.settings.target_sys : 140;
    var td = st.settings ? st.settings.target_dia : 90;
    var meta = [
      latest.pulse ? '脉率 ' + U.num(latest.pulse) : '',
      U.armCN(latest.arm),
      U.posCN(latest.position),
      sourceLabel(latest.source, '手动记录')
    ].filter(Boolean);
    return '<section class="latest-card">' +
      '<div class="latest-deco">' + I('pulse', 220, { sw: 1 }) + '</div>' +
      '<div class="latest-top"><span class="latest-tag">最近一次测量</span>' +
      '<span class="latest-time">' + e(U.dateTimeLabel(latest.measured_at)) + '</span></div>' +
      '<div class="latest-value"><span class="latest-sys">' + U.num(latest.systolic) + '</span>' +
      '<span class="latest-sep">/</span><span class="latest-dia">' + U.num(latest.diastolic) + '</span>' +
      '<span class="latest-unit">mmHg</span></div>' +
      '<div class="latest-meta">' + meta.map(function (m) { return '<span class="latest-chip">' + e(m) + '</span>'; }).join('') + '</div>' +
      '<div class="latest-foot">' + levelChip(latest.systolic, latest.diastolic) +
      '<span class="latest-target">目标 &lt; ' + U.num(ts) + '/' + U.num(td) + ' mmHg</span></div>' +
      '</section>';
  };

  views.trendCard = function () {
    var st = S();
    var stats = st.homeStats;
    var avg = stats && stats.avg_sys != null
      ? U.num(stats.avg_sys) + '<em>/</em>' + U.num(stats.avg_dia) + '<small>mmHg</small>'
      : '–';
    return '<section class="card trend-card">' +
      '<div class="card-head"><div><h3>近 7 天趋势</h3><p>收缩压 / 舒张压</p></div>' +
      '<button type="button" class="link-btn" data-action="go" data-route="records">全部记录' + I('chevron-right', 16) + '</button></div>' +
      '<div class="mini-stats">' +
      '<div class="mini-stat"><span class="mini-label">平均</span><span class="mini-value">' + avg + '</span></div>' +
      '<div class="mini-stat"><span class="mini-label">超标</span><span class="mini-value">' + (stats ? U.num(stats.high_count) : '–') + '<small>次</small></span></div>' +
      '</div>' +
      '<div class="chart-wrap chart-mini"><canvas id="chart-home" aria-label="近 7 天血压趋势图"></canvas></div>' +
      '</section>';
  };

  views.homeMedsCard = function (meds) {
    var writable = canWrite();
    var pending = meds.filter(function (m) { return m.status === 'pending'; }).length;
    return '<section class="card home-meds-card">' +
      '<div class="card-head"><div><h3>今日吃药</h3><p>' + (meds.length ? (pending ? pending + ' 项待' + (writable ? '打卡' : '服用') : '今天都完成啦') : '还没有服药计划') + '</p></div>' +
      '<button type="button" class="link-btn" data-action="go" data-route="meds">' + (writable ? '管理' : '查看') + I('chevron-right', 16) + '</button></div>' +
      (meds.length
        ? '<ul class="task-list">' + meds.map(function (m) { return views.medTask(m); }).join('') + '</ul>'
        : '<div class="mini-empty">' + I('pill', 28) + '<span>' + (writable ? '去「吃药」页添加药品，之后会按时提醒' : '该患者暂无服药计划') + '</span></div>') +
      '</section>';
  };

  views.medTask = function (log) {
    var status = log.status || 'pending';
    var writable = canWrite();
    var checkTag = writable ? 'button' : 'span';
    var checkAttrs = writable
      ? ' type="button" data-action="med-toggle" data-id="' + log.id + '" data-status="' + status + '" aria-label="' +
        (status === 'pending' ? '标记已服' : '撤销') + '"'
      : '';
    return '<li class="task task-' + status + '">' +
      '<' + checkTag + checkAttrs + ' class="task-check">' +
      I(status === 'taken' ? 'check' : status === 'skipped' ? 'x' : 'check', 22, { sw: 2.4 }) + '</' + checkTag + '>' +
      '<div class="task-main">' +
      '<p class="task-name">' + e(log.name) + '<span class="task-dose">' + U.dose(log.dose) + ' ' + e(log.unit || '') + '</span></p>' +
      '<p class="task-time">' + e(log.scheduled_time || '') +
      (status === 'taken' ? (log.taken_at ? ' · ' + U.hm(log.taken_at) + ' 已服' : ' · 已服用')
        : status === 'skipped' ? ' · 已跳过' : (writable ? ' · 待打卡' : ' · 待服用')) +
      '</p></div>' +
      (writable
        ? '<div class="task-actions">' +
          (status === 'pending'
            ? '<button type="button" class="btn btn-sm btn-primary" data-action="med-take" data-id="' + log.id + '">打卡</button>' +
              '<button type="button" class="btn btn-sm btn-ghost" data-action="med-skip" data-id="' + log.id + '">跳过</button>'
            : '<button type="button" class="btn btn-sm btn-ghost" data-action="med-undo" data-id="' + log.id + '">撤销</button>') +
          '</div>'
        : '') +
      '</li>';
  };

  /* ================================================================== */
  /* 记录页                                                               */
  /* ================================================================== */
  views.records = function () {
    var st = S();
    if (isDoctor() && !st.viewPatientId) return views.noPatientPage();
    var loading = st.loading.records;
    var stats = st.stats;
    var items = st.measurements;
    var writable = canWrite();
    if (!items && loading) {
      return '<div class="page">' +
        '<div class="page-head"><div><h1>血压记录</h1><p>正在加载…</p></div></div>' + skeletonCards(3) + '</div>';
    }
    if (!items) {
      return '<div class="page">' + emptyState('alert-circle', '记录加载失败', '请检查网络后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="records">重新加载</button>') + '</div>';
    }
    return '<div class="page page-records">' +
      '<div class="page-head">' +
      '<div><h1>血压记录</h1><p>' + (readOnly() ? '只读查看 · ' : '') + '全部 ' + U.num(st.recordsTotal || items.length) + ' 条记录 · 近 ' + st.statsDays + ' 天 ' +
      (stats ? U.num(stats.count) : '–') + ' 条</p></div>' +
      '<button type="button" class="icon-btn" data-action="open-export" aria-label="导出数据">' + I('download', 23) + '</button>' +
      '</div>' +
      views.recordsChartCard(stats) +
      '<div class="sec-head"><h2 class="sec-title">记录明细</h2>' +
      '<span class="sec-meta">' + (items.length ? (writable ? '点一条可修改' : '只读') : '') + '</span></div>' +
      (items.length ? views.recordsList(items) : emptyState('records', '这段时间还没有记录', '换到 30 天看看，或记录一次血压',
        writable ? '<button type="button" class="btn btn-primary btn-block" data-action="new-record">记录血压</button>' : '')) +
      '</div>';
  };

  views.recordsChartCard = function (stats) {
    var st = S();
    var avg = stats && stats.avg_sys != null ? U.num(stats.avg_sys) + '/' + U.num(stats.avg_dia) : '–';
    var high = stats ? U.num(stats.high_count) : '–';
    var count = stats ? U.num(stats.count) : '–';
    function segBtn(d) {
      return '<button type="button" class="seg-btn' + (st.statsDays === d ? ' active' : '') + '" data-action="stats-days" data-days="' + d + '">' +
        d + ' 天</button>';
    }
    return '<section class="card chart-card">' +
      '<div class="chart-head">' +
      '<div class="seg">' + segBtn(7) + segBtn(30) + '</div>' +
      '<div class="legend">' +
      '<button type="button" class="legend-chip' + (st.series.sys ? ' on' : '') + '" data-action="toggle-series" data-series="sys"><i class="dot dot-sys"></i>收缩压</button>' +
      '<button type="button" class="legend-chip' + (st.series.dia ? ' on' : '') + '" data-action="toggle-series" data-series="dia"><i class="dot dot-dia"></i>舒张压</button>' +
      '<button type="button" class="legend-chip' + (st.series.pulse ? ' on' : '') + '" data-action="toggle-series" data-series="pulse"><i class="dot dot-pulse"></i>脉率</button>' +
      '</div></div>' +
      '<div class="chart-wrap chart-main"><canvas id="chart-records" aria-label="血压趋势图"></canvas></div>' +
      '<p class="chart-caption">统计范围：近 ' + st.statsDays + ' 天（' + count + ' 条记录）</p>' +
      '<div class="stat-row">' +
      '<div class="stat-cell"><span>平均</span><b>' + avg + '<small>mmHg</small></b></div>' +
      '<div class="stat-cell"><span>记录</span><b>' + count + '<small>条</small></b></div>' +
      '<div class="stat-cell"><span>超标</span><b class="stat-warn">' + high + '<small>次</small></b></div>' +
      '</div></section>';
  };

  views.recordsList = function (items) {
    var groups = [];
    var byDate = {};
    items.forEach(function (m) {
      var key = (m.measured_at || '').slice(0, 10);
      if (!byDate[key]) { byDate[key] = []; groups.push(key); }
      byDate[key].push(m);
    });
    return '<div class="record-groups">' + groups.map(function (dateKey, i) {
      var list = byDate[dateKey].slice().sort(function (a, b) {
        return (b.measured_at || '').localeCompare(a.measured_at || '');
      });
      return '<section class="rec-group">' +
        '<div class="rec-date"><span class="rec-date-label">' + e(U.cnDate(dateKey + 'T12:00:00')) + '</span>' +
        '<span class="rec-date-side">' + list.length + ' 条' + (i === 0 ? ' · 最近' : '') + '</span></div>' +
        '<ul class="rec-list">' + list.map(views.recordItem).join('') + '</ul></section>';
    }).join('') + '</div>';
  };

  views.recordItem = function (m) {
    var lv = U.bpLevel(m.systolic, m.diastolic);
    var extras = [U.armCN(m.arm), U.posCN(m.position), sourceLabel(m.source, '')].filter(Boolean);
    var writable = canWrite();
    var tag = writable ? 'button' : 'div';
    var attrs = writable ? ' type="button" data-action="edit-record" data-id="' + m.id + '"' : '';
    return '<li><' + tag + attrs + ' class="rec-item' + (writable ? '' : ' rec-item-static') + '">' +
      '<span class="rec-time">' + U.hm(m.measured_at) + '</span>' +
      '<span class="rec-main">' +
      '<span class="rec-val"><b class="' + lv.cls + '">' + U.num(m.systolic) + '</b><i>/</i><b class="' + lv.cls + '">' + U.num(m.diastolic) + '</b>' +
      '<span class="rec-unit">mmHg</span></span>' +
      (m.pulse ? '<span class="rec-pulse">脉率 ' + U.num(m.pulse) + '</span>' : '') +
      (extras.length || m.note
        ? '<span class="rec-tags">' + extras.map(function (x) { return '<span class="tag tag-xs">' + e(x) + '</span>'; }).join('') +
          (m.note ? '<span class="rec-note">' + e(m.note) + '</span>' : '') + '</span>'
        : '') +
      '</span>' +
      '<span class="rec-side">' + (lv.label ? '<span class="level-chip ' + lv.cls + '">' + lv.label + '</span>' : '') +
      (writable ? I('chevron-right', 20) : '') + '</span>' +
      '</' + tag + '></li>';
  };

  /* ================================================================== */
  /* 吃药页（医生角色为只读「用药」）                                      */
  /* ================================================================== */
  views.meds = function () {
    var st = S();
    if (isDoctor() && !st.viewPatientId) return views.noPatientPage();
    var meds = st.meds;
    var logs = st.medlogsToday;
    var writable = canWrite();
    var pageTitle = isDoctor() ? '用药' : '吃药';
    if ((!meds || !logs) && st.loading.meds) {
      return '<div class="page">' +
        '<div class="page-head"><div><h1>' + pageTitle + '</h1><p>正在加载…</p></div></div>' + skeletonCards(3) + '</div>';
    }
    if (!meds || !logs) {
      return '<div class="page">' + emptyState('alert-circle', '吃药数据加载失败', '请检查网络后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="meds">重新加载</button>') + '</div>';
    }
    var pending = logs.filter(function (l) { return l.status === 'pending'; }).length;
    return '<div class="page page-meds">' +
      '<div class="page-head">' +
      '<div><h1>' + pageTitle + '</h1><p>' + (writable ? '按时吃药，血压更稳' : '只读查看 · 不能修改服药记录') + '</p></div>' +
      (writable ? '<button type="button" class="btn btn-primary btn-sm btn-add" data-action="open-med-form">' + I('plus', 20, { sw: 2.2 }) + '新增</button>' : '') +
      '</div>' +
      views.adherenceCard() +
      '<section class="card today-meds-card">' +
      '<div class="card-head"><div><h3>今日任务</h3><p>' +
      (logs.length ? (pending ? (writable ? '还有 ' + pending + ' 项待打卡' : '还有 ' + pending + ' 项待服用') : '今天都完成啦，真棒') : '今天没有服药安排') + '</p></div></div>' +
      (logs.length ? '<ul class="task-list">' + logs.map(function (l) { return views.medTask(l); }).join('') + '</ul>'
        : '<div class="mini-empty">' + I('check-circle', 28) + '<span>' + (writable ? '新增药品后，这里会自动生成每天的任务' : '该患者暂无服药安排') + '</span></div>') +
      '</section>' +
      secHead('我的药品', meds.length ? meds.length + ' 种在服用' : '') +
      (meds.length
        ? '<div class="med-grid">' + meds.map(function (m) { return views.medCard(m); }).join('') + '</div>'
        : emptyState('pill', '还没有添加药品', writable ? '添加后每天会生成服药任务并提醒' : '该患者暂无在服药品',
          writable ? '<button type="button" class="btn btn-primary btn-block" data-action="open-med-form">添加药品</button>' : '')) +
      '</div>';
  };

  views.adherenceCard = function () {
    var a = S().adherence;
    if (!a || !a.total) {
      return '<section class="card adherence-card"><div class="adh-ring" style="--p:0"><div class="adh-ring-in"><b>–</b><span>依从率</span></div></div>' +
        '<div class="adh-body"><p class="adh-title">近 7 天依从率</p><p class="adh-sub">还没有服药记录，添加药品开始记录吧</p></div></section>';
    }
    var pct = Math.round(a.taken / a.total * 100);
    return '<section class="card adherence-card">' +
      '<div class="adh-ring" style="--p:' + pct + '"><div class="adh-ring-in"><b>' + pct + '%</b><span>依从率</span></div></div>' +
      '<div class="adh-body">' +
      '<p class="adh-title">近 7 天按时服药</p>' +
      '<p class="adh-sub"><span>已服 ' + a.taken + ' 次</span><span>跳过 ' + a.skipped + ' 次</span><span>漏服 ' + a.missed + ' 次</span></p>' +
      '<div class="progress"><i style="width:' + pct + '%"></i></div>' +
      '</div></section>';
  };

  views.medCard = function (m) {
    var writable = canWrite();
    return '<article class="card med-card">' +
      '<div class="med-head"><div class="med-ic">' + I('pill', 24, { sw: 1.9 }) + '</div>' +
      '<div class="med-title"><h3>' + e(m.name) + '</h3><p>每次 ' + U.dose(m.dose) + ' ' + e(m.unit || '') + '</p></div>' +
      '<span class="badge badge-on">服用中</span></div>' +
      '<div class="med-times">' + (m.times || []).map(function (t) { return '<span class="time-chip">' + I('clock', 15) + e(t) + '</span>'; }).join('') + '</div>' +
      '<div class="med-foot"><span class="med-period">' + e(m.start_date || '') + ' 起</span>' +
      (writable
        ? '<span class="med-actions">' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="edit-med" data-id="' + m.id + '">' + I('edit', 17) + '编辑</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="stop-med" data-id="' + m.id + '">' + I('stop', 17) + '停用</button>' +
          '</span>'
        : '') +
      '</div></article>';
  };

  /* ================================================================== */
  /* 设置页                                                               */
  /* ================================================================== */
  views.settings = function () {
    var st = S();
    if (isDoctor() && !st.viewPatientId) return views.noPatientPage();
    if (readOnly()) return views.settingsReadOnly();
    var s = st.settings;
    if (!s) {
      if (st.loading.settings) {
        return '<div class="page"><div class="page-head"><div><h1>设置</h1><p>正在加载…</p></div></div>' + skeletonCards(3) + '</div>';
      }
      return '<div class="page">' + emptyState('alert-circle', '设置加载失败', '请检查网络后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="settings">重新加载</button>') + '</div>';
    }
    var slotRows = ['morning', 'forenoon', 'afternoon', 'bedtime'].map(function (k) {
      var label = { morning: '早上', forenoon: '上午', afternoon: '下午', bedtime: '睡前' }[k];
      var win = (s.slot_windows && s.slot_windows[k]) ? s.slot_windows[k].join('–') : '';
      return '<div class="set-row">' +
        '<div class="set-row-main"><span class="set-row-title">' + label + '</span>' +
        '<span class="set-row-sub">测量窗口 ' + e(win) + '</span></div>' +
        '<input class="input time-input" type="text" inputmode="numeric" maxlength="5" data-time-input ' +
        'id="set-slot-' + k + '" value="' + e((s.slot_times || {})[k] || '') + '" placeholder="06:30" aria-label="' + label + '目标时间（24 小时制）">' +
        '</div>';
    }).join('');
    return '<div class="page page-settings">' +
      '<div class="page-head"><div><h1>设置</h1><p>时段、提醒与数据</p></div></div>' +

      '<section class="card set-card">' +
      '<div class="card-head"><div><h3>测量时段</h3><p>每个时段的目标时间，到点会提醒测量</p></div></div>' +
      '<div class="set-rows">' + slotRows + '</div>' +
      '<button type="button" class="btn btn-primary btn-block" data-action="save-slots">保存时段</button>' +
      '</section>' +

      '<section class="card set-card">' +
      '<div class="card-head"><div><h3>判定阈值</h3><p>超过这个数值会标记为超标</p></div></div>' +
      '<div class="set-rows">' +
      views.thresholdRow('收缩压', 'set-target-sys', s.target_sys, 'mmHg', 80, 220) +
      views.thresholdRow('舒张压', 'set-target-dia', s.target_dia, 'mmHg', 40, 140) +
      '</div>' +
      '<button type="button" class="btn btn-primary btn-block" data-action="save-targets">保存阈值</button>' +
      '</section>' +

      '<section class="card set-card">' +
      '<div class="set-row set-row-switch">' +
      '<div class="set-row-main"><span class="set-row-title">开启提醒</span><span class="set-row-sub">测血压和吃药到点时提醒我</span></div>' +
      '<label class="switch"><input type="checkbox" id="set-reminder"' + (s.reminder_enabled ? ' checked' : '') + '><span class="track"><span class="thumb"></span></span></label>' +
      '</div>' +
      '<div class="set-row set-row-switch">' +
      '<div class="set-row-main"><span class="set-row-title">手机系统通知</span><span class="set-row-sub" id="notify-state">' + views.notifyStateText() + '</span></div>' +
      '<button type="button" class="btn btn-sm btn-soft" data-action="enable-notifications">' + (views.notifyGranted() ? '已开启' : '开启') + '</button>' +
      '</div>' +
      '<div class="set-row set-row-switch">' +
      '<div class="set-row-main"><span class="set-row-title">时区</span><span class="set-row-sub">' + e(s.timezone || 'Asia/Shanghai') + '</span></div>' +
      '<span class="set-static">' + I('wifi', 19) + '</span>' +
      '</div>' +
      '</section>' +

      views.bleCard() +

      '<section class="card set-card">' +
      '<div class="card-head"><div><h3>通知通道</h3><p>开启后，提醒会同时推送到手机</p></div></div>' +
      '<div class="channels">' +
      views.channel('ntfy', 'ntfy', 'bell', '免费推送服务，适合自己部署') +
      views.channel('pushplus', 'PushPlus', 'chat', '微信消息推送，需关注公众号') +
      views.channel('email', '邮件', 'mail', '把提醒发送到邮箱') +
      views.channel('webhook', 'Webhook', 'link', '推送到自己的服务地址') +
      '</div></section>' +

      views.exportCard() +

      (isAdmin()
        ? '<section class="card set-card">' +
          '<div class="card-head"><div><h3>用户管理</h3><p>管理家庭成员、医生账号与绑定关系</p></div></div>' +
          '<button type="button" class="data-row" data-action="go-admin">' +
          '<span class="data-row-ic">' + I('user', 22) + '</span>' +
          '<span class="data-row-main"><b>用户与绑定管理</b><small>新建用户、修改角色、重置密码、绑定医生与患者</small></span>' +
          I('chevron-right', 20) + '</button>' +
          '</section>'
        : '') +

      views.accountCard() +

      '<p class="about-line">血压管家 v1.0 · 数据保存在你自己的服务器' + (BP.isMock ? ' · 当前为演示模式（示例数据）' : '') + '</p>' +
      '</div>';
  };

  /* 只读设置页（医生 / 管理员查看患者）：患者信息 + 报告导出 + 账户 */
  views.settingsReadOnly = function () {
    var st = S();
    var s = st.settings;
    if (!s) {
      if (st.loading.settings) {
        return '<div class="page"><div class="page-head"><div><h1>报告</h1><p>正在加载…</p></div></div>' + skeletonCards(3) + '</div>';
      }
      return '<div class="page">' + emptyState('alert-circle', '数据加载失败', '请检查网络后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="settings">重新加载</button>') + '</div>';
    }
    var pname = viewingName() || '当前患者';
    return '<div class="page page-settings">' +
      '<div class="page-head"><div><h1>报告</h1><p>只读查看 · 导出患者数据</p></div></div>' +
      '<section class="card set-card">' +
      '<div class="card-head"><div><h3>当前患者</h3><p>医生账号只能查看与导出，不能修改数据</p></div></div>' +
      '<div class="patient-info">' +
      '<div class="patient-avatar">' + I('user', 26) + '</div>' +
      '<div class="patient-info-main"><b>' + e(pname) + '</b>' +
      '<small>只读模式 · 数据来自患者本人记录</small></div>' +
      '<span class="role-pill role-doctor">只读</span>' +
      '</div>' +
      (isAdmin() ? '<button type="button" class="btn btn-soft btn-block mt12" data-action="switch-self">返回我的数据</button>' : '') +
      '</section>' +
      views.exportCard({ readonly: true }) +
      views.accountCard() +
      '<p class="about-line">血压管家 v1.0 · 数据保存在你自己的服务器' + (BP.isMock ? ' · 当前为演示模式（示例数据）' : '') + '</p>' +
      '</div>';
  };

  /* APK（WebView 壳）注入的原生日历同步桥；浏览器中不存在 */
  function calendarSyncBridge() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPCalendarSync : null;
      if (b && typeof b.isSupported === 'function' && b.isSupported()) return b;
      return null;
    } catch (e) { return null; }
  }

  /* APK v1.4 蓝牙自动同步桥；浏览器中不存在 */
  function bleBridgeAvailable() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPBleSync : null;
      return !!(b && typeof b.configure === 'function' && typeof b.start === 'function');
    } catch (e) { return false; }
  }

  /* 记录来源显示文案 */
  function sourceLabel(src, fallback) {
    if (src === 'ocr') return '拍照识别';
    if (src === 'ble') return '蓝牙自动同步';
    return fallback || '';
  }

  /* 蓝牙自动同步卡片（仅 APK 且可写时显示；不渲染 bindkey） */
  views.bleCard = function () {
    var st = S();
    if (!bleBridgeAvailable() || !canWrite()) return '';
    var cfg = st.bleConfig;
    if (cfg && cfg.unavailable) return '';
    var body;
    if (st.bleError) {
      body = '<div class="ble-status ble-status-error">' + e(st.bleError) +
        '<button type="button" class="link-btn ble-retry" data-action="ble-retry">重试</button></div>';
    } else if (!cfg) {
      body = '<div class="ble-status">正在读取蓝牙配置…</div>';
    } else if (!cfg.configured) {
      body = '<div class="ble-status">服务器尚未配置蓝牙设备</div>' +
        '<p class="ble-hint">请联系管理员在服务器端完成蓝牙血压计绑定后，再回到这里开启自动同步。</p>';
    } else {
      body = '<div class="ble-device">' +
        '<span class="ble-ic">' + I('wifi', 22) + '</span>' +
        '<div class="ble-device-main"><b>' + e(cfg.mac || '已配置蓝牙设备') + '</b>' +
        '<small>' + (cfg.enabled ? '自动同步已开启' : '自动同步已关闭') + '</small></div>' +
        '<label class="switch"><input type="checkbox" id="ble-enabled"' + (cfg.enabled ? ' checked' : '') +
        '><span class="track"><span class="thumb"></span></span></label>' +
        '</div>' +
        '<p class="ble-hint">开启后 App 退到后台也能收测量广播；需要保持手机蓝牙开启。测量完成后打开 App 会自动导入。</p>';
    }
    return '<section class="card set-card">' +
      '<div class="card-head"><div><h3>蓝牙自动同步</h3><p>与蓝牙血压计配对，测量后自动导入</p></div><span class="ble-badge">App</span></div>' +
      body +
      '</section>';
  };

  /* 数据导出卡片（普通用户/管理员含备份与恢复；只读模式仅导出） */
  views.exportCard = function (opts) {
    opts = opts || {};
    var ro = !!opts.readonly;
    var showCalendarSync = !ro && !!calendarSyncBridge(); // 只读/浏览器隐藏
    var showDiagnostics = !!(window.BPBle || window.BPNotify); // 仅新版 APK
    return '<section class="card set-card">' +
      '<div class="card-head"><div><h3>' + (ro ? '报告导出' : '数据') + '</h3><p>' +
      (ro ? '导出当前患者的血压与服药数据' : '导出或备份自己的健康数据') + '</p></div></div>' +
      '<div class="data-actions' + (ro ? ' data-actions-2' : '') + '">' +
      '<button type="button" class="data-btn" data-action="export-xlsx">' + I('download', 22) + '<span>导出 Excel</span></button>' +
      '<button type="button" class="data-btn" data-action="export-csv">' + I('file-text', 22) + '<span>导出 CSV</span></button>' +
      (ro ? '' : '<button type="button" class="data-btn" data-action="export-backup">' + I('database', 22) + '<span>数据备份</span></button>') +
      '</div>' +
      '<button type="button" class="data-row" data-action="export-report">' +
      '<span class="data-row-ic">' + I('printer', 22) + '</span>' +
      '<span class="data-row-main"><b>打印 / PDF 报告</b><small>生成给医生看的血压与服药汇总，可另存为 PDF</small></span>' +
      I('chevron-right', 20) + '</button>' +
      '<button type="button" class="data-row" data-action="export-calendar">' +
      '<span class="data-row-ic">' + I('calendar', 22) + '</span>' +
      '<span class="data-row-main"><b>日历提醒 (.ics)</b><small>导入手机日历，按时提醒测血压和吃药</small></span>' +
      I('chevron-right', 20) + '</button>' +
      (showCalendarSync
        ? '<div class="calendar-sync">' +
          '<button type="button" class="data-row" data-action="sync-calendar">' +
          '<span class="data-row-ic">' + I('refresh', 22) + '</span>' +
          '<span class="data-row-main"><b>同步到手机日历</b><small>把每天测血压和吃药提醒直接写入手机系统日历（App 一键同步）</small></span>' +
          I('chevron-right', 20) + '</button>' +
          '<button type="button" class="link-btn calendar-clear" data-action="clear-calendar">清除本应用写入的日历提醒</button>' +
          '</div>'
        : '') +
      (showDiagnostics
        ? '<button type="button" class="data-row" data-action="open-diagnostics">' +
          '<span class="data-row-ic">' + I('pulse', 22) + '</span>' +
          '<span class="data-row-main"><b>蓝牙 / 通知诊断</b><small>检查血压计蓝牙广播与米家通知（实验功能，仅 App 内可用）</small></span>' +
          I('chevron-right', 20) + '</button>'
        : '') +
      (ro ? '' :
        '<button type="button" class="data-row" data-action="restore-backup">' +
        '<span class="data-row-ic">' + I('upload', 22) + '</span>' +
        '<span class="data-row-main"><b>从备份恢复</b><small>选择之前导出的 JSON 备份文件，覆盖当前数据</small></span>' +
        I('chevron-right', 20) + '</button>' +
        '<input type="file" id="backup-file" accept=".json,application/json" hidden>') +
      '</section>';
  };

  /* 账户卡片（显示名称 / 修改密码 / 退出登录） */
  views.accountCard = function () {
    return '<section class="card set-card">' +
      '<div class="card-head"><div><h3>账户</h3><p>' + e(curUser().username || '') + ' · ' + roleLabel(role()) + '</p></div></div>' +
      '<details class="acc">' +
      '<summary><span class="acc-sum">' + I('user', 20) + '修改显示名称</span>' + I('chevron-down', 18) + '</summary>' +
      '<form class="acc-body" data-form="profile" novalidate>' +
      '<label class="field"><span class="field-label">显示名称</span><input class="input" id="profile-display" type="text" maxlength="32" value="' + e(curUser().display_name || '') + '" placeholder="例如：家人"></label>' +
      '<p class="form-hint">用于首页问候和通知标题；留空则显示用户名。用户名不可自行修改。</p>' +
      '<p class="form-error" id="profile-error" hidden></p>' +
      '<button class="btn btn-primary btn-block" type="submit">保存显示名称</button>' +
      '</form></details>' +
      '<details class="acc">' +
      '<summary><span class="acc-sum">' + I('key', 20) + '修改密码</span>' + I('chevron-down', 18) + '</summary>' +
      '<form class="acc-body" data-form="password" novalidate>' +
      '<label class="field"><span class="field-label">当前密码</span><input class="input" id="pw-old" type="password" autocomplete="current-password" placeholder="当前登录密码"></label>' +
      '<label class="field"><span class="field-label">新密码</span><input class="input" id="pw-new" type="password" autocomplete="new-password" placeholder="至少 6 位"></label>' +
      '<label class="field"><span class="field-label">确认新密码</span><input class="input" id="pw-new2" type="password" autocomplete="new-password" placeholder="再输入一次"></label>' +
      '<p class="form-error" id="pw-error" hidden></p>' +
      '<button class="btn btn-primary btn-block" type="submit">保存新密码</button>' +
      '</form></details>' +
      '<button type="button" class="btn btn-danger-ghost btn-block mt12" data-action="logout">' + I('logout', 20) + '退出登录</button>' +
      '</section>';
  };

  /* ================================================================== */
  /* 用户管理（仅管理员）                                                 */
  /* ================================================================== */
  views.adminUsers = function () {
    var st = S();
    if (!isAdmin()) {
      return '<div class="page">' + emptyState('shield', '无权访问', '只有管理员可以管理用户。') + '</div>';
    }
    if (!st.adminLoaded) {
      if (st.loading.admin) {
        return '<div class="page"><div class="page-head"><div><h1>用户管理</h1><p>正在加载…</p></div></div>' + skeletonCards(3) + '</div>';
      }
      return '<div class="page">' + emptyState('alert-circle', '用户列表加载失败', '请检查网络后重试',
        '<button type="button" class="btn btn-primary btn-block" data-action="reload" data-route="admin">重新加载</button>') + '</div>';
    }
    var users = st.adminUsers || [];
    return '<div class="page page-admin">' +
      '<div class="page-head">' +
      '<div><h1>用户管理</h1><p>共 ' + users.length + ' 个账号 · 管理员、普通用户与医生</p></div>' +
      '<button type="button" class="btn btn-primary btn-sm btn-add" data-action="admin-new-user">' + I('plus', 20, { sw: 2.2 }) + '新建</button>' +
      '</div>' +
      '<div class="admin-list">' + users.map(views.adminUserCard).join('') + '</div>' +
      '<p class="about-line">不能删除自己和最后一个管理员；医生只能查看被绑定患者的数据。</p>' +
      '</div>';
  };

  views.adminUserCard = function (u) {
    var me = Number((curUser() || {}).id) === Number(u.id);
    var bind = '';
    if (u.role === 'doctor') {
      bind = '已绑定 ' + ((u.patient_ids || []).length) + ' 位患者';
    } else if (u.role === 'user') {
      bind = '已绑定 ' + ((u.doctor_ids || []).length) + ' 位医生';
    } else {
      bind = '管理员账号';
    }
    var avatarIcon = u.role === 'admin' ? 'shield' : u.role === 'doctor' ? 'user' : 'user';
    return '<article class="card user-card">' +
      '<div class="user-head">' +
      '<div class="user-avatar role-' + u.role + '">' + I(avatarIcon, 22) + '</div>' +
      '<div class="user-main"><h3>' + e(u.display_name || u.username) +
      (me ? '<span class="tag tag-xs">我</span>' : '') + '</h3>' +
      '<p>@' + e(u.username) + ' · ' + bind + '</p></div>' +
      '<span class="role-pill role-' + u.role + '">' + roleLabel(u.role) + '</span>' +
      '</div>' +
      '<div class="user-actions">' +
      '<button type="button" class="btn btn-sm btn-soft" data-action="admin-edit-user" data-id="' + u.id + '">' +
      I('edit', 17) + '编辑</button>' +
      (me ? '' : '<button type="button" class="btn btn-sm btn-danger-ghost" data-action="admin-delete-user" data-id="' + u.id + '">' +
        I('trash', 17) + '删除</button>') +
      '</div></article>';
  };

  views.thresholdRow = function (label, id, value, unit, min, max) {
    return '<div class="set-row">' +
      '<div class="set-row-main"><span class="set-row-title">' + label + '</span><span class="set-row-sub">单位 ' + unit + '</span></div>' +
      '<div class="stepper">' +
      '<button type="button" class="step-btn" data-action="stepper" data-target="' + id + '" data-delta="-5" aria-label="减少">' + I('minus', 18, { sw: 2.2 }) + '</button>' +
      '<input class="input step-input" type="number" id="' + id + '" value="' + e(value) + '" min="' + min + '" max="' + max + '" step="1" inputmode="numeric">' +
      '<button type="button" class="step-btn" data-action="stepper" data-target="' + id + '" data-delta="5" aria-label="增加">' + I('plus', 18, { sw: 2.2 }) + '</button>' +
      '</div></div>';
  };

  /* APK（WebView 壳）注入的原生通知桥；浏览器中不存在 */
  function nativeNotifyBridge() {
    try {
      var b = (typeof window !== 'undefined') ? window.BPNativeNotify : null;
      if (b && typeof b.isSupported === 'function' && b.isSupported()) return b;
      return null;
    } catch (e) { return null; }
  }
  views.notifyGranted = function () {
    try {
      var bridge = nativeNotifyBridge();
      if (bridge && typeof bridge.isPermissionGranted === 'function') return !!bridge.isPermissionGranted();
      return typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch (e) { return false; }
  };
  views.notifyStateText = function () {
    try {
      var bridge = nativeNotifyBridge();
      if (bridge) {
        var granted = false;
        try { granted = !!bridge.isPermissionGranted(); } catch (e2) { granted = false; }
        if (granted) return '已允许，提醒会显示在手机通知栏（App 通知）';
        return '未开启，点右侧按钮授权';
      }
      // 桥存在但 isSupported() 为 false / 抛错：APK 内系统通知被关闭
      if (typeof window !== 'undefined' && window.BPNativeNotify) {
        return '系统通知已关闭，请在手机设置中允许';
      }
      if (typeof Notification === 'undefined') {
        return '当前环境不支持系统通知；请用血压管家 App，或使用日历/PushPlus 提醒';
      }
      if (Notification.permission === 'granted') return '已允许，提醒会显示在通知栏';
      if (Notification.permission === 'denied') return '已拒绝，可在浏览器设置里重新允许';
      return '未开启，点右侧按钮授权';
    } catch (e) {
      return '当前环境不支持系统通知；请用血压管家 App，或使用日历/PushPlus 提醒';
    }
  };

  views.channel = function (key, title, iconName, desc) {
    var s = S().settings;
    var c = (s.channels && s.channels[key]) || {};
    var enabled = !!c.enabled;
    var fields = '';
    if (key === 'ntfy') {
      fields = views.field('服务器地址', 'ch-ntfy-server', c.server || '', 'text', 'https://ntfy.sh') +
        views.field('主题 topic', 'ch-ntfy-topic', c.topic || '', 'text', '例如 bp-family') +
        views.field('访问令牌（可选）', 'ch-ntfy-token', c.token || '', 'password', '仅有访问控制时填写');
    } else if (key === 'pushplus') {
      fields = views.field('PushPlus Token', 'ch-pushplus-token', c.token || '', 'password', '在 pushplus.plus 获取');
    } else if (key === 'email') {
      fields = views.field('SMTP 服务器', 'ch-email-host', c.smtp_host || '', 'text', 'smtp.qq.com') +
        views.field('端口', 'ch-email-port', c.smtp_port || 465, 'number', '465') +
        views.field('发件账号', 'ch-email-username', c.username || '', 'text', 'your@mail.com') +
        views.field('授权码 / 密码', 'ch-email-password', c.password || '', 'password', '邮箱授权码') +
        views.field('收件邮箱', 'ch-email-to', c.to || '', 'text', 'family@mail.com') +
        '<label class="set-row set-row-switch"><span class="set-row-title">使用 SSL</span>' +
        '<span class="switch"><input type="checkbox" id="ch-email-ssl"' + (c.ssl !== false ? ' checked' : '') + '><span class="track"><span class="thumb"></span></span></span></label>';
    } else if (key === 'webhook') {
      fields = views.field('Webhook 地址', 'ch-webhook-url', c.url || '', 'text', 'https://example.com/hook') +
        '<label class="field"><span class="field-label">请求方法</span><select class="input" id="ch-webhook-method">' +
        ['POST', 'GET', 'PUT'].map(function (m) {
          return '<option value="' + m + '"' + ((c.method || 'POST') === m ? ' selected' : '') + '>' + m + '</option>';
        }).join('') + '</select></label>';
    }
    return '<details class="chan' + (enabled ? ' is-on' : '') + '"' + (S().openChannel === key ? ' open' : '') + ' data-channel="' + key + '">' +
      '<summary><span class="chan-ic">' + I(iconName, 21) + '</span>' +
      '<span class="chan-main"><span class="chan-title">' + title + '</span><span class="chan-desc">' + desc + '</span></span>' +
      '<span class="chan-badge">' + (enabled ? '已启用' : '未启用') + '</span>' + I('chevron-down', 18) + '</summary>' +
      '<div class="chan-body">' +
      '<label class="set-row set-row-switch"><span class="set-row-title">启用 ' + title + '</span>' +
      '<span class="switch"><input type="checkbox" id="ch-' + key + '-enabled"' + (enabled ? ' checked' : '') + '><span class="track"><span class="thumb"></span></span></span></label>' +
      fields +
      '<div class="chan-actions">' +
      '<button type="button" class="btn btn-soft btn-sm" data-action="test-channel" data-channel="' + key + '">发送测试</button>' +
      '<button type="button" class="btn btn-primary btn-sm" data-action="save-channel" data-channel="' + key + '">保存</button>' +
      '</div></div></details>';
  };

  views.field = function (label, id, value, type, placeholder) {
    return '<label class="field field-sm"><span class="field-label">' + label + '</span>' +
      '<input class="input" id="' + id + '" type="' + (type || 'text') + '" value="' + e(value) + '" placeholder="' + e(placeholder || '') + '"></label>';
  };

  /* ================================================================== */
  /* 弹层                                                                 */
  /* ================================================================== */
  function sheetWrap(title, subtitle, body, index, opts) {
    opts = opts || {};
    return '<div class="overlay" data-overlay-index="' + index + '" data-action="overlay-close">' +
      '<div class="sheet' + (opts.large ? ' sheet-lg' : '') + '" role="dialog" aria-modal="true" aria-label="' + e(title) + '">' +
      '<div class="sheet-grab" aria-hidden="true"></div>' +
      '<div class="sheet-head"><div class="sheet-head-text"><h2>' + e(title) + '</h2>' +
      (subtitle ? '<p>' + e(subtitle) + '</p>' : '') + '</div>' +
      '<button type="button" class="icon-btn sheet-close" data-action="modal-close" aria-label="关闭">' + I('close', 22) + '</button></div>' +
      '<div class="sheet-body">' + body + '</div>' +
      '</div></div>';
  }

  views.renderModal = function (m, index) {
    switch (m.name) {
      case 'confirm': return modalConfirm(m, index);
      case 'record': return modalRecord(m, index);
      case 'ocr': return modalOcr(m, index);
      case 'med': return modalMed(m, index);
      case 'export': return modalExport(m, index);
      case 'reminders': return modalReminders(m, index);
      case 'adminUser': return modalAdminUser(m, index);
      default: return '';
    }
  };

  function modalConfirm(m, index) {
    return sheetWrap(m.data.title, '', '' +
      '<p class="confirm-msg">' + e(m.data.message) + '</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost btn-lg" data-action="confirm-cancel">' + e(m.data.cancelText) + '</button>' +
      '<button type="button" class="btn ' + (m.data.danger ? 'btn-danger' : 'btn-primary') + ' btn-lg" data-action="confirm-ok">' + e(m.data.confirmText) + '</button>' +
      '</div>', index);
  }

  /* ---------- 用户管理：新建 / 编辑用户弹层 ---------- */
  function modalAdminUser(m, index) {
    var d = m.data || {};
    var u = d.user || null;
    var creating = !u;
    var selfId = (curUser() || {}).id;
    var isSelf = !!u && Number(u.id) === Number(selfId);
    var curRoleValue = u ? u.role : 'user';
    var doctors = (d.doctors || []).filter(function (x) { return x.role === 'doctor'; });
    var patients = (d.patients || []).filter(function (x) { return x.role === 'user'; });
    var checkedPat = (u && u.patient_ids) || [];
    var checkedDoc = (u && u.doctor_ids) || [];
    var roles = [['user', '普通用户'], ['doctor', '医生'], ['admin', '管理员']];

    function checkList(list, checked, kind) {
      if (!list.length) return '<p class="form-hint">暂无可用账号</p>';
      return list.map(function (x) {
        var on = checked.map(Number).indexOf(Number(x.id)) >= 0;
        return '<label class="check-row"><input type="checkbox" data-bind="' + kind + '" value="' + x.id + '"' + (on ? ' checked' : '') + '>' +
          '<span class="check-name">' + e(x.display_name || x.username) +
          '<small>@' + e(x.username) + '</small></span></label>';
      }).join('');
    }

    var bindings = creating ? '' :
      '<div class="field"><span class="field-label">绑定关系</span>' +
      '<div class="bind-box" id="ad-bind-doctors"' + (curRoleValue === 'user' ? '' : ' hidden') + '>' +
      '<p class="form-hint">该患者可见的医生（医生账号登录后可查看此患者）：</p>' + checkList(doctors, checkedDoc, 'doctor') + '</div>' +
      '<div class="bind-box" id="ad-bind-patients"' + (curRoleValue === 'doctor' ? '' : ' hidden') + '>' +
      '<p class="form-hint">该医生可查看的患者：</p>' + checkList(patients, checkedPat, 'patient') + '</div>' +
      '</div>';

    var body = '<form data-form="adminUser" novalidate>' +
      (d.error ? '<p class="form-error show">' + e(d.error) + '</p>' : '') +
      '<label class="field"><span class="field-label">用户名</span>' +
      (creating
        ? '<input class="input" id="ad-username" autocomplete="off" placeholder="例如 userA" data-autofocus>'
        : '<input class="input" id="ad-username" value="' + e(u.username) + '" disabled>') +
      '</label>' +
      '<label class="field"><span class="field-label">显示名（可选）</span>' +
      '<input class="input" id="ad-display" value="' + e(u ? (u.display_name || '') : '') + '" placeholder="例如 王阿姨"></label>' +
      '<div class="form-2col">' +
      '<label class="field"><span class="field-label">角色</span>' +
      '<select class="input" id="ad-role"' + (isSelf ? ' disabled' : '') + '>' +
      roles.map(function (r) {
        return '<option value="' + r[0] + '"' + (curRoleValue === r[0] ? ' selected' : '') + '>' + r[1] + '</option>';
      }).join('') + '</select></label>' +
      '<label class="field"><span class="field-label">' + (creating ? '密码' : '重置密码（可选）') + '</span>' +
      '<input class="input" id="ad-password" type="password" autocomplete="new-password" placeholder="' +
      (creating ? '至少 6 位' : '留空则不修改') + '"></label>' +
      '</div>' +
      bindings +
      '<p class="form-hint">' + (creating ? '新用户创建后可在列表中编辑并绑定关系。' : '修改角色后请确认绑定关系是否仍然正确。') + '</p>' +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost btn-lg" data-action="modal-close">取消</button>' +
      '<button type="submit" class="btn btn-primary btn-lg">' + (creating ? '创建用户' : '保存修改') + '</button>' +
      '</div></form>';
    return sheetWrap(creating ? '新建用户' : '编辑用户',
      creating ? '创建家庭成员或医生账号' : '@' + u.username,
      body, index, { large: true });
  }

  /* ---------- 新增 / 编辑血压弹层 ---------- */
  function modalRecord(m, index) {
    var d = m.data || {};
    var rec = d.record || null;
    var measuredValue = rec ? U.localInputValue(rec.measured_at) : U.localInputValue(d.presetAt || new Date());
    var measuredDate = measuredValue.slice(0, 10);
    var measuredTime = measuredValue.slice(11, 16);
    var sys = rec ? rec.systolic : '';
    var dia = rec ? rec.diastolic : '';
    var pulse = rec ? (rec.pulse || '') : '';
    var arm = rec ? (rec.arm || '') : 'left';
    var position = rec ? (rec.position || '') : 'sitting';
    var note = rec ? (rec.note || '') : '';
    var editing = !!rec;

    function segGroup(id, options, current) {
      return '<div class="seg-seg" data-seg="' + id + '">' + options.map(function (o) {
        return '<button type="button" class="seg-opt' + (current === o[0] ? ' active' : '') + '" data-action="pick-option" data-group="' + id + '" data-value="' + o[0] + '">' + o[1] + '</button>';
      }).join('') + '</div>' +
        '<input type="hidden" id="' + id + '" value="' + e(current) + '">';
    }

    var body = '' +
      '<form data-form="record" novalidate>' +
      (editing ? '<div class="record-meta-line">' +
        '<span class="tag">' + sourceLabel(rec.source, '手动记录') + '</span>' +
        '<span class="tag">' + e(U.cnDate(rec.measured_at)) + '</span>' +
        '</div>' : '') +
      '<div class="dt-row">' +
      '<label class="dt-col dt-col-date"><span class="field-label">测量日期</span>' +
      '<input class="input dt-date" type="text" inputmode="numeric" maxlength="10" data-date-input id="f-measured-date" value="' + e(measuredDate) + '" placeholder="2026-10-29" aria-label="测量日期，格式 年-月-日"></label>' +
      '<label class="dt-col dt-col-time"><span class="field-label">测量时间</span>' +
      '<input class="input dt-time" type="text" inputmode="numeric" maxlength="5" data-time-input id="f-measured-time" value="' + e(measuredTime) + '" placeholder="16:40" aria-label="测量时间，24 小时制"></label>' +
      '<button type="button" class="btn btn-soft dt-now" data-action="set-now">现在</button>' +
      '</div>' +
      '<div class="bp-inputs">' +
      '<label class="bp-input"><span class="field-label">收缩压（高压）</span>' +
      '<span class="bp-input-row"><input class="input num-input" type="number" id="f-sys" inputmode="numeric" min="60" max="260" placeholder="120" value="' + e(sys) + '" data-autofocus>' +
      '<span class="num-unit">mmHg</span></span></label>' +
      '<label class="bp-input"><span class="field-label">舒张压（低压）</span>' +
      '<span class="bp-input-row"><input class="input num-input" type="number" id="f-dia" inputmode="numeric" min="30" max="180" placeholder="80" value="' + e(dia) + '">' +
      '<span class="num-unit">mmHg</span></span></label>' +
      '</div>' +
      '<label class="field"><span class="field-label">脉率（可选）</span>' +
      '<span class="bp-input-row"><input class="input num-input num-input-sm" type="number" id="f-pulse" inputmode="numeric" min="30" max="220" placeholder="76" value="' + e(pulse) + '"><span class="num-unit">次/分</span></span></label>' +
      '<div class="form-2col">' +
      '<div class="field"><span class="field-label">测量手臂</span>' + segGroup('f-arm', [['left', '左臂'], ['right', '右臂']], arm) + '</div>' +
      '<div class="field"><span class="field-label">测量体位</span>' + segGroup('f-position', [['sitting', '坐姿'], ['lying', '卧姿'], ['standing', '站姿']], position) + '</div>' +
      '</div>' +
      '<label class="field"><span class="field-label">备注（可选）</span>' +
      '<textarea class="input textarea" id="f-note" rows="2" placeholder="例如：午睡后测量">' + e(note) + '</textarea></label>' +
      '<p class="form-error" id="f-error" hidden></p>' +
      '<div class="ocr-inline"><button type="button" class="btn btn-soft btn-block" data-action="open-ocr">' +
      I('camera', 22) + '拍照识别血压计</button>' +
      '<p class="ocr-inline-hint">对着血压计屏幕拍一张，自动填好数值</p></div>' +
      '<div class="modal-actions">' +
      (editing ? '<button type="button" class="btn btn-danger-ghost" data-action="delete-record" data-id="' + rec.id + '">' + I('trash', 20) + '删除</button>' : '') +
      '<button type="button" class="btn btn-ghost btn-lg" data-action="modal-close">取消</button>' +
      '<button type="submit" class="btn btn-primary btn-lg">' + (editing ? '保存修改' : '保存记录') + '</button>' +
      '</div></form>';

    return sheetWrap(editing ? '修改记录' : '记录血压', editing ? U.dateTimeLabel(rec.measured_at) : '测量后立刻记录，数据更准确', body, index, { large: true });
  }

  /* ---------- OCR 弹层 ---------- */
  function modalOcr(m, index) {
    var d = m.data || {};
    var body = '';
    if (d.loading) {
      body = '<div class="ocr-loading">' +
        '<div class="spinner"></div>' +
        '<p class="ocr-loading-title">正在识别血压计…</p>' +
        '<p class="ocr-loading-sub">照片只在你的服务器上处理</p>' +
        (d.previewUrl ? '<img class="ocr-preview" src="' + e(d.previewUrl) + '" alt="待识别照片">' : '') +
        '</div>';
    } else if (d.error) {
      body = '<div class="ocr-error">' + I('alert-circle', 40, { sw: 1.6 }) +
        '<p class="ocr-error-title">没有识别成功</p><p class="ocr-error-msg">' + e(d.error) + '</p>' +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost btn-lg" data-action="ocr-reset">重新选择照片</button>' +
        '<button type="button" class="btn btn-primary btn-lg" data-action="ocr-manual">手动输入</button></div></div>';
    } else if (d.result) {
      var r = d.result;
      var cands = r.candidates || [];
      body = (d.previewUrl ? '<img class="ocr-preview small" src="' + e(d.previewUrl) + '" alt="识别的照片">' :
        (d.demoImage ? '<img class="ocr-preview small" src="' + e(d.demoImage) + '" alt="示例血压计照片">' : '')) +
        '<div class="ocr-result-head"><span class="ocr-ok">' + I('check-circle', 19, { sw: 2 }) + (cands.length ? '识别到 ' + cands.length + ' 条记录' : '没有识别到数值') + '</span>' +
        '<span class="tag tag-xs">' + e(r.image_type || 'unknown') + '</span></div>' +
        (r.message ? '<p class="ocr-msg">' + e(r.message) + '</p>' : '') +
        (cands.length
          ? '<div class="cand-list">' + cands.map(function (c, i) {
            return '<button type="button" class="cand-card" data-action="use-candidate" data-index="' + i + '">' +
              '<span class="cand-vals"><b>' + U.num(c.systolic) + '</b><i>/</i><b>' + U.num(c.diastolic) + '</b>' +
              (c.pulse ? '<span class="cand-pulse">脉率 ' + U.num(c.pulse) + '</span>' : '') + '</span>' +
              '<span class="cand-meta"><span class="tag tag-xs tag-ok">置信度 ' + Math.round((c.confidence || 0) * 100) + '%</span>' +
              (c.evidence ? '<span class="tag tag-xs">' + e(c.evidence) + '</span>' : '') +
              (d.demo ? '<span class="tag tag-xs tag-demo">演示数据</span>' : '') + '</span>' +
              '<span class="cand-pick">' + I('check', 18, { sw: 2.4 }) + '填入记录</span></button>';
          }).join('') + '</div>'
          : '<div class="ocr-empty">' + I('image', 36, { sw: 1.5 }) + '<p>换个角度、避开反光再拍一张，或手动输入</p></div>') +
        (r.raw_text && r.raw_text.length
          ? '<details class="raw-text"><summary>查看识别原文</summary><p>' + e(r.raw_text.join('  ')) + '</p></details>'
          : '') +
        '<div class="modal-actions"><button type="button" class="btn btn-ghost btn-lg" data-action="ocr-reset">重新拍照</button>' +
        '<button type="button" class="btn btn-soft btn-lg" data-action="ocr-manual">手动输入</button></div>';
    } else {
      body = '<div class="ocr-intro">' +
        '<div class="ocr-illu">' + I('camera', 46, { sw: 1.4 }) + '</div>' +
        '<p class="ocr-tip">把手机对准血压计屏幕，保持光线充足、屏幕清晰</p>' +
        '<ul class="ocr-steps">' +
        '<li><b>1</b>点击下面的按钮拍照或从相册选择</li>' +
        '<li><b>2</b>自动识别高压 / 低压 / 脉率</li>' +
        '<li><b>3</b>核对后保存记录</li>' +
        '</ul>' +
        '<div class="ocr-pick-row">' +
        '<label class="btn btn-primary ocr-pick" for="ocr-file-camera">' + I('camera', 24) + '拍照</label>' +
        '<label class="btn btn-soft ocr-pick" for="ocr-file-gallery">' + I('image', 24) + '从相册选择</label>' +
        '</div>' +
        '<input type="file" id="ocr-file-camera" accept="image/*" capture="environment" hidden>' +
        '<input type="file" id="ocr-file-gallery" accept="image/*" hidden>' +
        '<p class="ocr-hint">支持 jpg / png，单张不超过 15MB；桌面端两个按钮都会打开文件选择</p>';
      if (BP.isMock) {
        body += '<div class="ocr-demo">' +
          '<div class="ocr-demo-head"><span>演示识别结果</span><span class="tag tag-xs tag-demo">mock</span></div>' +
          '<button type="button" class="cand-card" data-action="use-candidate-demo">' +
          '<span class="cand-vals"><b>152</b><i>/</i><b>93</b><span class="cand-pulse">脉率 78</span></span>' +
          '<span class="cand-meta"><span class="tag tag-xs tag-ok">置信度 93%</span><span class="tag tag-xs">152 93 78</span></span>' +
          '<span class="cand-pick">' + I('check', 18, { sw: 2.4 }) + '填入记录</span></button>' +
          '<p class="ocr-demo-note">演示模式使用内置示例数据；连接真实后端后会先上传照片再识别。</p>' +
          '</div>';
      }
      body += '</div>';
    }
    return sheetWrap('拍照识别', '识别血压计屏幕上的数值', body, index, { large: true });
  }

  /* ---------- 药品弹层 ---------- */
  function modalMed(m, index) {
    var d = m.data || {};
    var med = d.med || null;
    var form = d.form || (med ? {
      name: med.name, dose: med.dose, unit: med.unit || '片',
      times: (med.times || []).slice(), start_date: med.start_date || U.todayStr(),
      end_date: med.end_date || '', note: med.note || '', active: med.active !== false
    } : {
      name: '', dose: 1, unit: '片', times: ['08:00'], start_date: U.todayStr(),
      end_date: '', note: '', active: true
    });
    var units = ['片', '粒', '袋', '毫升', '毫克', '克', '支', '单位'];
    var times = (form.times || []).map(function (t, i) {
      return '<div class="time-row">' +
        '<input class="input time-input" type="text" inputmode="numeric" maxlength="5" data-time-input id="m-time-' + i + '" value="' + e(t) + '" placeholder="08:00" aria-label="服药时间（24 小时制）">' +
        (form.times.length > 1 ? '<button type="button" class="icon-btn icon-btn-sm" data-action="med-time-remove" data-index="' + i + '" aria-label="删除这个时间">' + I('close', 18) + '</button>' : '') +
        '</div>';
    }).join('');
    var body = '<form data-form="med" novalidate>' +
      (d.error ? '<p class="form-error show">' + e(d.error) + '</p>' : '') +
      '<label class="field"><span class="field-label">药品名称</span>' +
      '<input class="input input-lg" id="m-name" placeholder="例如：苯磺酸氨氯地平" value="' + e(form.name) + '" data-autofocus></label>' +
      '<div class="form-2col">' +
      '<label class="field"><span class="field-label">每次剂量</span>' +
      '<input class="input num-input num-input-sm" id="m-dose" type="number" inputmode="decimal" min="0.01" max="100" step="0.01" value="' + e(form.dose) + '"></label>' +
      '<label class="field"><span class="field-label">单位</span><select class="input" id="m-unit">' +
      units.map(function (u) { return '<option value="' + u + '"' + (form.unit === u ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select></label>' +
      '</div>' +
      '<div class="field"><span class="field-label">每天服药时间</span>' +
      '<div class="time-list" id="m-times">' + times + '</div>' +
      '<button type="button" class="btn btn-soft btn-sm mt8" data-action="med-time-add">' + I('plus', 18, { sw: 2.2 }) + '再加一个时间</button>' +
      '</div>' +
      '<div class="form-2col">' +
      '<label class="field"><span class="field-label">开始日期</span><input class="input" id="m-start" type="text" inputmode="numeric" maxlength="10" data-date-input value="' + e(form.start_date) + '" placeholder="2026-10-01"></label>' +
      '<label class="field"><span class="field-label">结束日期（可选）</span><input class="input" id="m-end" type="text" inputmode="numeric" maxlength="10" data-date-input value="' + e(form.end_date) + '" placeholder="2026-12-31"></label>' +
      '</div>' +
      '<label class="field"><span class="field-label">备注（可选）</span><textarea class="input textarea" id="m-note" rows="2" placeholder="例如：早餐后服用">' + e(form.note) + '</textarea></label>' +
      '<div class="modal-actions">' +
      (med ? '<button type="button" class="btn btn-danger-ghost" data-action="delete-med" data-id="' + med.id + '">' + I('trash', 20) + '删除</button>' : '') +
      '<button type="button" class="btn btn-ghost btn-lg" data-action="modal-close">取消</button>' +
      '<button type="submit" class="btn btn-primary btn-lg">' + (med ? '保存修改' : '添加药品') + '</button>' +
      '</div></form>';
    return sheetWrap(med ? '编辑药品' : '新增药品', '设置好后每天会自动生成服药任务', body, index, { large: true });
  }

  /* ---------- 导出弹层 ---------- */
  function modalExport(m, index) {
    var d = m.data || {};
    var from = d.from || U.dateStr(U.addDays(new Date(), -29));
    var to = d.to || U.todayStr();
    var body = '' +
      '<div class="export-range">' +
      '<label class="field field-inline"><span class="field-label">从</span>' +
      '<input class="input" type="text" inputmode="numeric" maxlength="10" data-date-input id="x-from" value="' + e(from) + '" placeholder="2026-09-30" aria-label="开始日期"></label>' +
      '<span class="range-sep">至</span>' +
      '<label class="field field-inline"><span class="field-label">到</span>' +
      '<input class="input" type="text" inputmode="numeric" maxlength="10" data-date-input id="x-to" value="' + e(to) + '" placeholder="2026-10-29" aria-label="结束日期"></label>' +
      '</div>' +
      '<div class="quick-ranges">' +
      '<button type="button" class="chip-btn" data-action="export-range" data-days="7">近 7 天</button>' +
      '<button type="button" class="chip-btn on" data-action="export-range" data-days="30">近 30 天</button>' +
      '<button type="button" class="chip-btn" data-action="export-range" data-days="month">本月</button>' +
      '</div>' +
      '<div class="export-list">' +
      '<button type="button" class="export-item" data-action="do-export-xlsx">' +
      '<span class="export-ic">' + I('file-text', 24) + '</span>' +
      '<span class="export-main"><b>Excel 表格（.xlsx）</b><small>血压记录 + 服药记录 + 统计摘要</small></span>' +
      I('chevron-right', 20) + '</button>' +
      '<button type="button" class="export-item" data-action="do-export-csv">' +
      '<span class="export-ic">' + I('download', 24) + '</span>' +
      '<span class="export-main"><b>CSV 文件（.csv）</b><small>可导入其他表格软件</small></span>' +
      I('chevron-right', 20) + '</button>' +
      (canWrite()
        ? '<button type="button" class="export-item" data-action="do-export-backup">' +
          '<span class="export-ic">' + I('database', 24) + '</span>' +
          '<span class="export-main"><b>数据备份（.json）</b><small>包含全部设置与记录，可留档</small></span>' +
          I('chevron-right', 20) + '</button>'
        : '') +
      '</div>' +
      (BP.isMock ? '<p class="export-note">演示模式下会下载由内置数据生成的示例文件。</p>' : '');
    return sheetWrap('导出数据', '选择时间范围后下载', body, index);
  }

  /* ---------- 提醒弹层 ---------- */
  function modalReminders(m, index) {
    var items = S().reminders || [];
    var body = items.length
      ? '<ul class="reminder-list">' + items.map(function (r) {
        return '<li class="reminder-item">' +
          '<div class="rm-ic">' + I(r.kind === 'med' ? 'pill' : 'pulse', 22) + '</div>' +
          '<div class="rm-main"><p class="rm-title">' + e(r.title) + '</p><p class="rm-body">' + e(r.body) + '</p>' +
          '<p class="rm-time">' + e(U.dateTimeLabel(r.due_at)) + '</p></div>' +
          '<div class="rm-actions">' +
          '<button type="button" class="btn btn-sm btn-primary" data-action="reminder-do" data-key="' + e(r.key) + '">去处理</button>' +
          '<button type="button" class="btn btn-sm btn-ghost" data-action="snooze" data-key="' + e(r.key) + '">稍后</button>' +
          '</div></li>';
      }).join('') + '</ul>'
      : emptyState('check-circle', '暂时没有待办提醒', '到测量或吃药时间，这里会出现提醒');
    return sheetWrap('提醒', items.length ? '共 ' + items.length + ' 项待处理' : '', body, index);
  }

  /* 导航/加载辅助供 app.js 使用 */
  views.skeletonPage = skeletonPage;

})();
