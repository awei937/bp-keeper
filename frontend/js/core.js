/* 血压管家 — 核心层：状态、工具函数、API 封装、Toast / 弹层基础设施 */
(function () {
  'use strict';
  window.BP = window.BP || {};

  var qs = new URLSearchParams(location.search);

  /* ------------------------------------------------------------------ */
  /* 全局状态                                                             */
  /* ------------------------------------------------------------------ */
  BP.isMock = qs.get('mock') === '1';
  BP.state = {
    mode: BP.isMock ? 'mock' : 'real',
    auth: { initialized: true, authenticated: false },
    user: null,                  // {id, username, display_name, role}
    patients: [],                // 医生绑定患者 / 管理员可查看的用户
    viewPatientId: null,         // 医生必选；管理员可选（查看患者时为只读）
    adminUsers: [],              // 管理员用户管理列表
    authChecked: false,
    authView: 'login',           // login | setup
    lastLoginUsername: null,     // 登录失败重渲染后保留用户已输入的用户名
    captcha: null,               // { status: idle|loading|ready|unavailable|error, id, image, expiresIn, error }
    route: 'home',
    loading: {},                 // route -> bool
    loaded: {},                  // route -> bool
    dashboard: null,
    stats: null,
    statsDays: 7,
    measurements: null,
    recordsTotal: 0,
    meds: null,
    medlogsToday: null,
    adherence: null,
    settings: null,
    reminders: [],
    seenReminderKeys: {},
    series: { sys: true, dia: true, pulse: false },
    openChannel: null,           // 深链接：设置页自动展开的通知通道
    pendingOpenChannel: null,
    charts: {},
    modals: [],
    scrollY: 0,
    booted: false
  };

  /* ------------------------------------------------------------------ */
  /* 角色 / 患者上下文                                                    */
  /* ------------------------------------------------------------------ */
  function currentRole() {
    var u = BP.state.user;
    return (u && u.role) || 'admin'; // 旧后端无 user 字段时按 admin 兜底
  }
  function currentUser() {
    var st = BP.state;
    if (st.user) return st.user;
    // 兜底：旧后端（无 user 字段）时视为 admin，避免白屏
    return { id: 0, username: 'admin', display_name: '', role: 'admin' };
  }
  function isDoctor() { return currentRole() === 'doctor'; }
  function isAdmin() { return currentRole() === 'admin'; }
  // 只读：医生；或管理员正在查看其他患者
  function isReadOnly() {
    var st = BP.state;
    if (currentRole() === 'doctor') return true;
    return currentRole() === 'admin' && !!st.viewPatientId;
  }
  function canWrite() { return !isReadOnly(); }
  function roleLabel(r) {
    return ({ admin: '管理员', user: '普通用户', doctor: '医生' })[r] || '普通用户';
  }
  function patientName(id) {
    var pid = id != null ? id : BP.state.viewPatientId;
    if (pid == null) return '';
    var list = BP.state.patients || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(pid)) return list[i].display_name || list[i].username || ('患者 #' + pid);
    }
    return '';
  }
  function viewingPatient() { return BP.state.viewPatientId != null ? patientName() : ''; }

  // 需要随 GET 请求附加的 patient_id（医生/管理员查看患者时）
  function patientIdValue() {
    var st = BP.state;
    if (st.viewPatientId == null) return null;
    var r = currentRole();
    if (r === 'doctor' || r === 'admin') return st.viewPatientId;
    return null;
  }
  function withPatient(url) {
    var pid = patientIdValue();
    if (pid == null) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'patient_id=' + encodeURIComponent(pid);
  }

  BP.role = {
    current: currentRole,
    user: currentUser,
    isDoctor: isDoctor,
    isAdmin: isAdmin,
    isReadOnly: isReadOnly,
    canWrite: canWrite,
    label: roleLabel,
    patientName: patientName,
    viewingPatient: viewingPatient,
    patientId: patientIdValue
  };

  /* ------------------------------------------------------------------ */
  /* 工具函数                                                             */
  /* ------------------------------------------------------------------ */
  var CN_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function pad(n) { return String(n).padStart(2, '0'); }

  function parseDate(v) {
    if (v instanceof Date) return v;
    if (!v) return new Date(NaN);
    return new Date(v);
  }

  function dateStr(d) {
    d = parseDate(d) || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function todayStr() { return dateStr(new Date()); }

  function addDays(dateOrStr, n) {
    var d = typeof dateOrStr === 'string' ? new Date(dateOrStr + 'T12:00:00') : parseDate(dateOrStr);
    d = new Date(d.getTime());
    d.setDate(d.getDate() + n);
    return d;
  }

  function cnDate(v, opts) {
    opts = opts || {};
    var d = parseDate(v);
    if (isNaN(d.getTime())) return '';
    var s = (d.getMonth() + 1) + '月' + d.getDate() + '日';
    if (opts.weekday !== false) s += ' ' + CN_WEEK[d.getDay()];
    return s;
  }

  function shortDate(v) {
    var d = parseDate(v);
    if (isNaN(d.getTime())) return '';
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function hm(v) {
    var d = parseDate(v);
    if (isNaN(d.getTime())) return '--:--';
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function dateTimeLabel(v) {
    var d = parseDate(v);
    if (isNaN(d.getTime())) return '';
    var t = todayStr();
    var ds = dateStr(d);
    var day = ds === t ? '今天' : (ds === dateStr(addDays(new Date(), -1)) ? '昨天' : cnDate(d));
    return day + ' ' + hm(d);
  }

  function localInputValue(v) {
    var d = v ? parseDate(v) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return dateStr(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toIso(localValue) {
    // datetime-local "YYYY-MM-DDTHH:mm" -> 带本地时区偏移的 ISO8601
    if (!localValue) return null;
    var d = new Date(localValue);
    if (isNaN(d.getTime())) return null;
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = pad(Math.floor(Math.abs(off) / 60));
    var om = pad(Math.abs(off) % 60);
    return dateStr(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00' + sign + oh + ':' + om;
  }

  /* 24 小时制时间 / 日期文本输入工具（避免浏览器本地化 AM/PM 显示） */
  function normalizeTime(v) {
    v = String(v || '').trim().replace(/[：:]/g, ':').replace(/[^\d:]/g, '');
    var m = v.match(/^(\d{1,2})(?::?(\d{1,2}))?$/);
    if (!m) return String(v || '').trim();
    var h = parseInt(m[1], 10);
    var mi = m[2] != null ? parseInt(m[2], 10) : 0;
    if (isNaN(h) || isNaN(mi) || h > 23 || mi > 59) return String(v || '').trim();
    return pad(h) + ':' + pad(mi);
  }
  function isValidTime(v) {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  }
  function normalizeDate(v) {
    var s = String(v || '').trim();
    var digits = s.replace(/\D/g, '');
    if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8);
    return s;
  }
  function isValidDate(v) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return false;
    var d = new Date(v + 'T12:00:00');
    return !isNaN(d.getTime()) && dateStr(d) === v;
  }
  function combineDateTime(date, time) {
    if (!isValidDate(date) || !isValidTime(time)) return null;
    return toIso(date + 'T' + time);
  }
  function nowDateInput() { return dateStr(new Date()); }
  function nowTimeInput() {
    var d = new Date();
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, digits) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '–';
    var n = Number(v);
    return digits ? n.toFixed(digits) : String(Math.round(n));
  }

  /* 剂量显示：保留小数，不做四舍五入（0.5 → "0.5"，1 → "1"） */
  function dose(v) {
    if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '–';
    var n = Number(v);
    var text = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    return text || '0';
  }

  function round1(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return null;
    return Math.round(Number(v) * 10) / 10;
  }

  var ARM_CN = { left: '左臂', right: '右臂' };
  var POS_CN = { sitting: '坐姿', lying: '卧姿', standing: '站姿' };
  var SLOT_CN = { morning: '早上', forenoon: '上午', afternoon: '下午', bedtime: '睡前', other: '其他' };
  var SLOT_ICON = { morning: 'sunrise', forenoon: 'pulse', afternoon: 'pulse', bedtime: 'moon' };

  function armCN(v) { return ARM_CN[v] || ''; }
  function posCN(v) { return POS_CN[v] || ''; }
  function slotCN(v) { return SLOT_CN[v] || '其他'; }

  // 依据常见成人血压分级（仅色阶提示，不等同医疗诊断）
  function bpLevel(sys, dia) {
    sys = Number(sys); dia = Number(dia);
    if (!sys || !dia) return { key: 'none', label: '', cls: '' };
    if (sys >= 160 || dia >= 100) return { key: 'very-high', label: '明显偏高', cls: 'lv-high' };
    if (sys >= 140 || dia >= 90) return { key: 'high', label: '偏高', cls: 'lv-high' };
    if (sys >= 120 || dia >= 80) return { key: 'elevated', label: '略高', cls: 'lv-mid' };
    return { key: 'normal', label: '正常', cls: 'lv-ok' };
  }

  function isHigh(sys, dia) {
    var s = BP.state.settings;
    var ts = s ? Number(s.target_sys) : 140;
    var td = s ? Number(s.target_dia) : 90;
    return Number(sys) > ts || Number(dia) > td;
  }

  function greeting() {
    var h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 9) return '早上好';
    if (h < 12) return '上午好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      var args = arguments, ctx = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, wait);
    };
  }

  function uid() { return 'u' + Math.random().toString(36).slice(2, 9); }

  /* ------------------------------------------------------------------ */
  /* API 封装                                                             */
  /* ------------------------------------------------------------------ */
  function ApiError(message, status) {
    this.name = 'ApiError';
    this.message = message || '请求失败';
    this.status = status || 0;
  }
  ApiError.prototype = Object.create(Error.prototype);

  async function request(path, opts) {
    opts = opts || {};
    var init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    };
    if (opts.body !== undefined && opts.body !== null) {
      if (typeof FormData !== 'undefined' && opts.body instanceof FormData) {
        init.body = opts.body;
      } else {
        init.headers['Content-Type'] = 'application/json; charset=utf-8';
        init.body = JSON.stringify(opts.body);
      }
    }
    var res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new ApiError('网络连接失败，请检查网络后重试', 0);
    }
    if (res.status === 401) {
      // 登录/初始化接口的 401 是"密码错误"，不触发全局跳登录
      if (BP.onUnauthorized && path.indexOf('/api/auth/login') !== 0 && path.indexOf('/api/auth/setup') !== 0) {
        BP.onUnauthorized();
      }
      throw new ApiError('登录状态已过期，请重新登录', 401);
    }
    if (!res.ok) {
      var detail = '';
      try {
        var data = await res.json();
        if (data && data.detail) detail = data.detail;
      } catch (e2) { /* ignore */ }
      var fallback = res.status >= 500 ? '服务器出错了，请稍后再试' : '请求未完成，请稍后再试';
      throw new ApiError(detail || fallback, res.status);
    }
    if (opts.raw) return res;
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('application/json') >= 0) return res.json();
    return res;
  }

  BP.api = {
    request: request,
    async authStatus() { return request('/api/auth/status'); },
    async captcha() { return request('/api/auth/captcha'); },
    async setup(password, username) {
      return request('/api/auth/setup', { method: 'POST', body: { password: password, username: username || 'admin' } });
    },
    async login(username, password, captchaId, captchaCode) {
      var body = { username: username || 'admin', password: password };
      // 旧后端无验证码接口时不额外发送这两个字段
      if (captchaId) {
        body.captcha_id = captchaId;
        body.captcha = captchaCode || '';
      }
      return request('/api/auth/login', { method: 'POST', body: body });
    },
    async logout() { return request('/api/auth/logout', { method: 'POST' }); },
    async changePassword(oldPw, newPw) {
      return request('/api/auth/password', { method: 'POST', body: { old_password: oldPw, new_password: newPw } });
    },
    async updateProfile(displayName) {
      return request('/api/auth/profile', { method: 'PATCH', body: { display_name: displayName } });
    },
    async dashboard(date) {
      return request(withPatient('/api/dashboard?date=' + encodeURIComponent(date || todayStr())));
    },
    async stats(days) { return request(withPatient('/api/stats?days=' + (days || 7))); },
    async measurements(q) {
      q = q || {};
      var p = [];
      if (q.from) p.push('from=' + encodeURIComponent(q.from));
      if (q.to) p.push('to=' + encodeURIComponent(q.to));
      p.push('limit=' + (q.limit || 500));
      p.push('offset=' + (q.offset || 0));
      var pid = patientIdValue();
      if (pid != null) p.push('patient_id=' + encodeURIComponent(pid));
      return request('/api/measurements?' + p.join('&'));
    },
    async createMeasurement(data) {
      return request('/api/measurements', { method: 'POST', body: data });
    },
    async updateMeasurement(id, patch) {
      return request('/api/measurements/' + encodeURIComponent(id), { method: 'PUT', body: patch });
    },
    async deleteMeasurement(id) {
      return request('/api/measurements/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    async medications(activeOnly) {
      var base = '/api/medications' + (activeOnly === false ? '' : '?active=1');
      if (patientIdValue() != null) {
        base += (base.indexOf('?') >= 0 ? '&' : '?') + 'patient_id=' + encodeURIComponent(patientIdValue());
      }
      return request(base);
    },
    async createMedication(data) {
      return request('/api/medications', { method: 'POST', body: data });
    },
    async updateMedication(id, patch) {
      return request('/api/medications/' + encodeURIComponent(id), { method: 'PUT', body: patch });
    },
    async deleteMedication(id) {
      return request('/api/medications/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    async medlogs(date) {
      return request(withPatient('/api/medlogs?date=' + encodeURIComponent(date || todayStr())));
    },
    async medlogAction(id, action) {
      // 契约：take/skip 接受 {"note": ""}；undo 无需额外字段
      return request('/api/medlogs/' + encodeURIComponent(id) + '/' + action, {
        method: 'POST', body: { note: '' }
      });
    },
    async getSettings() { return request(withPatient('/api/settings')); },
    async putSettings(patch) { return request('/api/settings', { method: 'PUT', body: patch }); },
    async testChannel(channel) {
      return request('/api/settings/test-channel', { method: 'POST', body: { channel: channel } });
    },
    async reminders() { return request(withPatient('/api/reminders')); },
    async snooze(key, minutes) {
      return request('/api/reminders/snooze', { method: 'POST', body: { key: key, minutes: minutes || 10 } });
    },
    async ocrHealth() { return request('/api/ocr/health'); },
    async ocrUpload(file) {
      var fd = new FormData();
      fd.append('file', file);
      return request('/api/ocr', { method: 'POST', body: fd });
    },
    async download(path, filename) {
      var res = await request(path, { raw: true });
      var blob = await res.blob();
      var a = document.createElement('a');
      var url = URL.createObjectURL(blob);
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    },
    // 导出快捷方法（路径与契约一致；医生/管理员查看患者时自动带 patient_id）
    exportXlsx(from, to) {
      return BP.api.download(withPatient('/api/export/xlsx?from=' + from + '&to=' + to),
        '血压记录_' + from + '_' + to + '.xlsx');
    },
    exportCsv(type, from, to) {
      var name = type === 'med' ? '服药记录' : '血压记录';
      return BP.api.download(withPatient('/api/export/csv?type=' + type + '&from=' + from + '&to=' + to),
        name + '_' + from + '_' + to + '.csv');
    },
    exportBackup() {
      return BP.api.download('/api/export/backup', '血压管家备份_' + todayStr() + '.json');
    },
    exportCalendar() {
      return BP.api.download(withPatient('/api/export/calendar.ics'), '血压管家提醒.ics');
    },
    reportUrl(days) {
      return withPatient('/api/export/report?days=' + (days || 30));
    },
    async restoreBackup(backup) {
      return request('/api/import/backup', { method: 'POST', body: { backup: backup } });
    },
    /* ---- 多用户角色相关 ---- */
    async patients() { return request('/api/patients'); },
    async adminUsersList() { return request('/api/admin/users'); },
    async adminCreateUser(data) {
      return request('/api/admin/users', { method: 'POST', body: data });
    },
    async adminUpdateUser(id, patch) {
      return request('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: patch });
    },
    async adminDeleteUser(id) {
      return request('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
    },
    async adminLink(doctorId, patientId) {
      return request('/api/admin/links', { method: 'POST', body: { doctor_id: doctorId, patient_id: patientId } });
    },
    async adminUnlink(doctorId, patientId) {
      return request('/api/admin/links?doctor_id=' + encodeURIComponent(doctorId) +
        '&patient_id=' + encodeURIComponent(patientId), { method: 'DELETE' });
    }
  };

  /* ------------------------------------------------------------------ */
  /* Toast（顶部浮层通知，可手动关闭；弹层打开时自动清空/不打扰）            */
  /* ------------------------------------------------------------------ */
  var toastRoot = null;
  function getToastRoot() {
    if (!toastRoot) toastRoot = document.getElementById('toast-root');
    return toastRoot;
  }
  function dismissToast(el) {
    if (!el) return;
    if (el._timer) { clearTimeout(el._timer); el._timer = null; }
    el.classList.remove('in');
    setTimeout(function () { if (el.parentNode) el.remove(); }, 240);
  }
  function clearToasts() {
    var root = getToastRoot();
    if (!root) return;
    Array.prototype.slice.call(root.children).forEach(function (el) { dismissToast(el); });
  }
  function toast(message, kind, ms) {
    kind = kind || 'info';
    ms = ms || 4000;
    // 弹层打开时不弹出 toast，避免遮挡弹层内容/按钮
    if (BP.state.modals && BP.state.modals.length) return;
    var root = getToastRoot();
    if (!root) return;
    var iconName = kind === 'success' ? 'check-circle' : kind === 'error' ? 'alert-circle' : 'info';
    var el = document.createElement('div');
    el.className = 'toast toast-' + kind;
    el.setAttribute('role', 'status');
    el.innerHTML = '<span class="toast-ic">' + BP.icons.icon(iconName, 22, { sw: 2 }) + '</span>' +
      '<span class="toast-msg">' + esc(message) + '</span>' +
      '<button type="button" class="toast-close" data-action="toast-close" aria-label="关闭提示">' +
      BP.icons.icon('close', 17, { sw: 2.4 }) + '</button>';
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('in'); });
    el._timer = setTimeout(function () { dismissToast(el); }, ms);
    while (root.children.length > 3) root.removeChild(root.firstChild);
  }

  /* ------------------------------------------------------------------ */
  /* 弹层（支持堆叠：记录弹层上再开 OCR 弹层）                              */
  /* ------------------------------------------------------------------ */
  function renderModals() {
    var root = document.getElementById('modal-root');
    if (!root) return;
    if (!BP.state.modals.length) {
      root.innerHTML = '';
      document.body.classList.remove('modal-open');
      return;
    }
    // 弹层打开时清掉已有 toast，保持弹层干净
    clearToasts();
    document.body.classList.add('modal-open');
    root.innerHTML = BP.state.modals.map(function (m, i) {
      return BP.views.renderModal(m, i);
    }).join('');
    var focus = root.querySelector('[data-autofocus]');
    if (focus) setTimeout(function () { try { focus.focus({ preventScroll: true }); } catch (e) { } }, 60);
  }

  function openModal(name, data) {
    BP.state.modals.push({ name: name, data: data || {} });
    renderModals();
  }
  function closeModal() {
    BP.state.modals.pop();
    renderModals();
  }
  function closeAllModals() {
    BP.state.modals = [];
    renderModals();
  }
  function refreshModals() { renderModals(); }

  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      openModal('confirm', {
        title: opts.title || '确认操作',
        message: opts.message || '',
        confirmText: opts.confirmText || '确定',
        cancelText: opts.cancelText || '取消',
        danger: !!opts.danger,
        resolve: resolve
      });
    });
  }

  BP.ui = {
    toast: toast,
    clearToasts: clearToasts,
    dismissToast: dismissToast,
    openModal: openModal,
    closeModal: closeModal,
    closeAllModals: closeAllModals,
    refreshModals: refreshModals,
    confirm: confirmDialog,
    renderModals: renderModals
  };

  /* ------------------------------------------------------------------ */
  /* 小工具导出                                                           */
  /* ------------------------------------------------------------------ */
  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* 隐私模式忽略 */ }
  }

  BP.util = {
    pad: pad, dateStr: dateStr, todayStr: todayStr, addDays: addDays, cnDate: cnDate,
    shortDate: shortDate, hm: hm, dateTimeLabel: dateTimeLabel, localInputValue: localInputValue,
    toIso: toIso, normalizeTime: normalizeTime, isValidTime: isValidTime,
    normalizeDate: normalizeDate, isValidDate: isValidDate, combineDateTime: combineDateTime,
    nowDateInput: nowDateInput, nowTimeInput: nowTimeInput,
    esc: esc, num: num, dose: dose, round1: round1, armCN: armCN, posCN: posCN, slotCN: slotCN,
    bpLevel: bpLevel, isHigh: isHigh, greeting: greeting, debounce: debounce, uid: uid,
    storageGet: storageGet, storageSet: storageSet, ApiError: ApiError
  };
})();
