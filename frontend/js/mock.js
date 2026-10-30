/* 血压管家 — 演示模式（?mock=1）：拦截所有 /api/* 请求，返回内置示例数据。
   不依赖后端，方便本地打开与截图验收。真实模式不会加载本文件的任何逻辑。 */
(function () {
  'use strict';
  var qs = new URLSearchParams(location.search);
  if (qs.get('mock') !== '1') return;

  window.BP = window.BP || {};
  BP.isMock = true;

  /* ------------------------- 日期工具 ------------------------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function dayDate(offset) {
    var d = new Date();
    d.setDate(d.getDate() + offset);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function fmtDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dstr(offset) { return fmtDate(dayDate(offset)); }
  function isoLocal(d) {
    var off = -d.getTimezoneOffset();
    var sign = off >= 0 ? '+' : '-';
    var oh = pad(Math.floor(Math.abs(off) / 60));
    var om = pad(Math.abs(off) % 60);
    return fmtDate(d) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00' + sign + oh + ':' + om;
  }
  function isoAt(offset, hh, mm) {
    var d = dayDate(offset);
    d.setHours(hh, mm, 0, 0);
    return isoLocal(d);
  }
  function today() { return dstr(0); }
  function nowIso() { return isoLocal(new Date()); }

  /* ------------------------- 设置 ------------------------- */
  var settings = {
    slot_times: { morning: '06:30', forenoon: '10:00', afternoon: '17:00', bedtime: '22:00' },
    slot_windows: {
      morning: ['06:00', '07:30'],
      forenoon: ['09:00', '11:30'],
      afternoon: ['16:00', '18:30'],
      bedtime: ['21:30', '23:59']
    },
    target_sys: 135,
    target_dia: 85,
    reminder_enabled: true,
    timezone: 'Asia/Shanghai',
    channels: {
      ntfy: { enabled: false, server: '', topic: '', token: '' },
      pushplus: { enabled: false, token: '' },
      email: { enabled: false, smtp_host: '', smtp_port: 465, ssl: true, username: '', password: '', to: '' },
      webhook: { enabled: false, url: '', method: 'POST' }
    }
  };

  /* ------------------------- 药品 ------------------------- */
  var medications = [
    {
      id: 1, name: '苯磺酸氨氯地平', dose: 1, unit: '片', times: ['08:00'],
      start_date: dstr(-30), end_date: null, active: true, note: '早餐后服用'
    },
    {
      id: 2, name: '缬沙坦', dose: 1, unit: '片', times: ['08:00', '20:00'],
      start_date: dstr(-20), end_date: null, active: true, note: ''
    }
  ];
  var medIdSeq = 3;

  /* ------------------------- 血压记录 ------------------------- */
  var measurements = [];
  var measurementId = 1;
  function addMeasurement(offset, hh, mm, sys, dia, pulse, arm, position, note, source) {
    var at = isoAt(offset, hh, mm);
    measurements.push({
      id: measurementId++,
      measured_at: at,
      systolic: sys,
      diastolic: dia,
      pulse: pulse,
      arm: arm || 'left',
      position: position || 'sitting',
      slot: slotForTime(at),
      note: note || '',
      source: source || 'manual',
      created_at: at,
      updated_at: at
    });
  }
  // 今天（示例：早上 / 上午 / 下午已测，睡前还未测）
  addMeasurement(0, 6, 42, 138, 88, 74, 'left', 'sitting', '');
  addMeasurement(0, 10, 15, 145, 92, 78, 'left', 'sitting', '');
  addMeasurement(0, 16, 40, 152, 93, 80, 'right', 'sitting', '午睡后测量');
  // 昨天 10/28
  addMeasurement(-1, 7, 5, 136, 86, 72, 'left', 'sitting', '');
  addMeasurement(-1, 21, 50, 142, 87, 76, 'left', 'sitting', '');
  // 更早
  addMeasurement(-2, 6, 50, 148, 94, 80, 'left', 'sitting', '');
  addMeasurement(-2, 16, 20, 141, 89, 78, 'right', 'sitting', '');
  addMeasurement(-3, 7, 10, 134, 82, 70, 'left', 'sitting', '');
  addMeasurement(-4, 6, 35, 139, 88, 75, 'left', 'sitting', '');
  addMeasurement(-4, 17, 5, 150, 95, 82, 'left', 'sitting', '爬楼后休息 5 分钟再测');
  addMeasurement(-5, 7, 0, 143, 90, 77, 'right', 'sitting', '');
  addMeasurement(-6, 6, 55, 137, 85, 73, 'left', 'sitting', '');
  addMeasurement(-6, 21, 40, 144, 89, 76, 'left', 'sitting', '');
  addMeasurement(-8, 7, 15, 146, 92, 79, 'left', 'sitting', '', 'ocr');
  addMeasurement(-11, 6, 45, 140, 91, 74, 'right', 'standing', '');
  addMeasurement(-15, 7, 30, 135, 83, 71, 'left', 'sitting', '');

  function slotForTime(iso) {
    var hhmm = String(iso).slice(11, 16);
    var keys = ['morning', 'forenoon', 'afternoon', 'bedtime'];
    for (var i = 0; i < keys.length; i++) {
      var w = settings.slot_windows[keys[i]];
      if (hhmm >= w[0] && hhmm <= w[1]) return keys[i];
    }
    return 'other';
  }

  /* ------------------------- 服药记录 ------------------------- */
  var medlogs = [];
  var medlogId = 3001;
  function logName(med) {
    return { name: med.name, dose: med.dose, unit: med.unit };
  }
  function seedMedlogs() {
    medlogs = [];
    for (var offset = -6; offset <= 0; offset++) {
      medications.forEach(function (med) {
        if (!med.active) return;
        if (offset < 0) {
          var startIdx = Math.abs(offset);
          if (fmtDate(dayDate(offset)) < med.start_date) return;
        }
        med.times.forEach(function (t, ti) {
          var status = 'taken';
          if (offset === 0) {
            status = t === '08:00' ? 'taken' : 'pending';
          } else if (offset === -2 && med.id === 2 && ti === 0) {
            status = 'skipped';
          } else if (offset === -4 && med.id === 1) {
            status = 'skipped';
          } else if (offset === -6 && med.id === 2 && ti === 1) {
            status = 'pending'; // 历史漏服
          }
          var base = logName(med);
          var takenAt = status === 'taken' ? isoAt(offset, parseInt(t.slice(0, 2), 10), (parseInt(t.slice(3, 5), 10) + 3) % 60) : null;
          medlogs.push({
            id: medlogId++,
            medication_id: med.id,
            name: base.name,
            dose: base.dose,
            unit: base.unit,
            date: dstr(offset),
            scheduled_time: t,
            status: status,
            taken_at: takenAt,
            note: ''
          });
        });
      });
    }
  }
  seedMedlogs();

  function syncTodayLogs() {
    var t = today();
    var existing = medlogs.filter(function (l) { return l.date === t; });
    medications.forEach(function (med) {
      if (!med.active) return;
      med.times.forEach(function (time) {
        var found = existing.some(function (l) {
          return l.medication_id === med.id && l.scheduled_time === time;
        });
        if (!found) {
          var base = logName(med);
          medlogs.push({
            id: medlogId++, medication_id: med.id, name: base.name, dose: base.dose, unit: base.unit,
            date: t, scheduled_time: time, status: 'pending', taken_at: null, note: ''
          });
        }
      });
    });
    // 去掉已停用/已删除药品当天未处理的待办
    var activeIds = medications.filter(function (m) { return m.active; }).map(function (m) { return m.id; });
    medlogs = medlogs.filter(function (l) {
      if (l.date !== t) return true;
      if (activeIds.indexOf(l.medication_id) < 0 && l.status === 'pending') return false;
      return true;
    });
  }

  /* ------------------------- 提醒 ------------------------- */
  var snoozedUntil = {};
  function computeReminders() {
    if (!settings.reminder_enabled) return [];
    var list = [];
    // 演示模式统一以今晚 21:40 作为"当前时间"，方便展示待办横幅
    var demoNow = '21:40';
    var now = demoNow;
    var slots = dashboardSlots();
    slots.forEach(function (s) {
      if (s.done) return;
      var start = (s.window || [])[0];
      if (start && now >= start) {
        list.push({
          kind: 'measure',
          key: 'measure:' + today() + ':' + s.key,
          title: '该测血压了',
          body: s.label + ' ' + (s.window || []).join('–') + ' 的测量还没记录',
          due_at: isoAt(0, parseInt(s.target_time.slice(0, 2), 10), parseInt(s.target_time.slice(3, 5), 10)),
          slot: s.key,
          medlog_id: null
        });
      }
    });
    var logs = medlogs.filter(function (l) { return l.date === today() && l.status === 'pending'; });
    logs.forEach(function (l) {
      if (l.scheduled_time > now) return;
      list.push({
        kind: 'med',
        key: 'medlog:' + l.id,
        title: '该吃药了',
        body: l.name + ' ' + l.dose + ' ' + l.unit + ' · ' + l.scheduled_time + ' 还没打卡',
        due_at: isoAt(0, parseInt(l.scheduled_time.slice(0, 2), 10), parseInt(l.scheduled_time.slice(3, 5), 10)),
        slot: null,
        medlog_id: l.id
      });
    });
    return list.filter(function (r) {
      return !(snoozedUntil[r.key] && snoozedUntil[r.key] > Date.now());
    });
  }

  /* ------------------------- 统计 ------------------------- */
  function round1(v) { return v === null || v === undefined ? null : Math.round(v * 10) / 10; }

  function computeStats(days) {
    var start = dstr(-(days - 1));
    var end = today();
    var inRange = measurements.filter(function (m) {
      var d = String(m.measured_at).slice(0, 10);
      return d >= start && d <= end;
    });
    var count = inRange.length;
    var sumSys = 0, sumDia = 0, sumPulse = 0, pulseN = 0, high = 0;
    var seriesMap = {};
    var slotMap = {};
    var classification = { normal: 0, elevated: 0, high: 0 };
    inRange.forEach(function (m) {
      sumSys += m.systolic;
      sumDia += m.diastolic;
      if (m.pulse) { sumPulse += m.pulse; pulseN++; }
      if (m.systolic > settings.target_sys || m.diastolic > settings.target_dia) high++;
      var d = String(m.measured_at).slice(0, 10);
      if (!seriesMap[d]) seriesMap[d] = { sys: 0, dia: 0, pulse: 0, pn: 0, count: 0 };
      var sm = seriesMap[d];
      sm.sys += m.systolic; sm.dia += m.diastolic; sm.count++;
      if (m.pulse) { sm.pulse += m.pulse; sm.pn++; }
      var slot = m.slot || 'other';
      if (!slotMap[slot]) slotMap[slot] = { count: 0, sys: 0, dia: 0 };
      slotMap[slot].count++; slotMap[slot].sys += m.systolic; slotMap[slot].dia += m.diastolic;
      if (m.systolic >= 140 || m.diastolic >= 90) classification.high++;
      else if (m.systolic >= 120 || m.diastolic >= 80) classification.elevated++;
      else classification.normal++;
    });
    var series = Object.keys(seriesMap).sort().map(function (d) {
      var s = seriesMap[d];
      return {
        date: d,
        avg_sys: round1(s.sys / s.count),
        avg_dia: round1(s.dia / s.count),
        avg_pulse: s.pn ? round1(s.pulse / s.pn) : null,
        count: s.count
      };
    });
    var bySlot = {};
    Object.keys(slotMap).forEach(function (k) {
      var s = slotMap[k];
      bySlot[k] = { count: s.count, avg_sys: round1(s.sys / s.count), avg_dia: round1(s.dia / s.count) };
    });
    return {
      days: days,
      count: count,
      avg_sys: count ? round1(sumSys / count) : null,
      avg_dia: count ? round1(sumDia / count) : null,
      avg_pulse: pulseN ? round1(sumPulse / pulseN) : null,
      high_count: high,
      series: series,
      by_slot: bySlot,
      classification: classification
    };
  }

  /* ------------------------- 首页聚合 ------------------------- */
  var SLOT_META = {
    morning: { label: '早上', icon: 'sun' },
    forenoon: { label: '上午', icon: 'sun' },
    afternoon: { label: '下午', icon: 'sun' },
    bedtime: { label: '睡前', icon: 'moon' }
  };

  function dashboardSlots() {
    var t = today();
    var todays = measurements.filter(function (m) { return String(m.measured_at).slice(0, 10) === t; });
    return ['morning', 'forenoon', 'afternoon', 'bedtime'].map(function (key) {
      var list = todays.filter(function (m) { return m.slot === key; }).sort(function (a, b) {
        return String(a.measured_at).localeCompare(String(b.measured_at));
      });
      var last = list.length ? list[list.length - 1] : null;
      return {
        key: key,
        label: SLOT_META[key].label,
        window: settings.slot_windows[key],
        target_time: settings.slot_times[key],
        done: list.length > 0,
        count: list.length,
        last: last ? {
          systolic: last.systolic, diastolic: last.diastolic,
          pulse: last.pulse, measured_at: last.measured_at
        } : null
      };
    });
  }

  function dashboard(date) {
    var sorted = measurements.slice().sort(function (a, b) {
      return String(b.measured_at).localeCompare(String(a.measured_at));
    });
    var slots = dashboardSlots();
    var todayLogs = medlogs.filter(function (l) { return l.date === today(); }).sort(function (a, b) {
      return String(a.scheduled_time).localeCompare(String(b.scheduled_time));
    });
    var s7 = computeStats(7);
    return {
      date: date || today(),
      now: isoAt(0, 21, 40), // 演示数据统一以今晚 21:40 为"当前时间"
      slots: slots,
      measurements_today: measurements.filter(function (m) {
        return String(m.measured_at).slice(0, 10) === today();
      }).sort(function (a, b) { return String(b.measured_at).localeCompare(String(a.measured_at)); }),
      latest: sorted.length ? sorted[0] : null,
      meds: todayLogs,
      stats7: {
        count: s7.count, avg_sys: s7.avg_sys, avg_dia: s7.avg_dia, avg_pulse: s7.avg_pulse,
        high_count: s7.high_count, by_slot: s7.by_slot
      },
      reminders: computeReminders()
    };
  }

  /* ------------------------- HTTP 响应工具 ------------------------- */
  function json(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
  function err(detail, status) { return json({ detail: detail }, status || 400); }
  function text(data, status, contentType) {
    return new Response(data, {
      status: status || 200,
      headers: { 'Content-Type': contentType || 'text/plain; charset=utf-8' }
    });
  }

  /* ------------------------- 多用户角色（演示） ------------------------- */
  // ?mock=1&role=admin|user|doctor 演示三种角色（默认 admin）
  var demoRole = ['admin', 'user', 'doctor'].indexOf(qs.get('role')) >= 0 ? qs.get('role') : 'admin';
  var seedTime = nowIso();
  var users = [
    { id: 1, username: 'admin', display_name: '管理员', role: 'admin', created_at: seedTime, patient_ids: [], doctor_ids: [] },
    { id: 2, username: 'userA', display_name: '王阿姨', role: 'user', created_at: seedTime, patient_ids: [], doctor_ids: [4] },
    { id: 3, username: 'userB', display_name: '李叔叔', role: 'user', created_at: seedTime, patient_ids: [], doctor_ids: [] },
    { id: 4, username: 'doctorD', display_name: '张医生', role: 'doctor', created_at: seedTime, patient_ids: [2], doctor_ids: [] }
  ];
  var userIdSeq = 5;
  var currentUserId = demoRole === 'doctor' ? 4 : (demoRole === 'user' ? 2 : 1);
  function userById(id) {
    for (var i = 0; i < users.length; i++) if (Number(users[i].id) === Number(id)) return users[i];
    return null;
  }
  function currentMockUser() { return userById(currentUserId) || users[0]; }
  function userLite(u) {
    return u ? { id: u.id, username: u.username, display_name: u.display_name, role: u.role } : null;
  }
  function userPublic(u) {
    return {
      id: u.id, username: u.username, display_name: u.display_name, role: u.role,
      created_at: u.created_at, patient_ids: (u.patient_ids || []).slice(), doctor_ids: (u.doctor_ids || []).slice()
    };
  }
  function isMockAdmin() { return currentMockUser().role === 'admin'; }
  function addMockLink(doctorId, patientId) {
    var d = userById(doctorId), p = userById(patientId);
    if (!d || !p || d.role !== 'doctor' || p.role !== 'user') return false;
    if (d.patient_ids.indexOf(p.id) < 0) d.patient_ids.push(p.id);
    if (p.doctor_ids.indexOf(d.id) < 0) p.doctor_ids.push(d.id);
    return true;
  }
  function removeMockLink(doctorId, patientId) {
    var d = userById(doctorId), p = userById(patientId);
    if (d) d.patient_ids = (d.patient_ids || []).filter(function (x) { return Number(x) !== Number(patientId); });
    if (p) p.doctor_ids = (p.doctor_ids || []).filter(function (x) { return Number(x) !== Number(doctorId); });
  }

  /* ------------------------- 登录验证码（演示） ------------------------- */
  var captchaSeq = 1;
  function mockCaptchaImage() {
    var code = String(1000 + Math.floor(Math.random() * 9000));
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="60">' +
      '<rect width="160" height="60" fill="#e8f4ef"/>' +
      '<path d="M0 46 Q40 12 80 38 T160 20" stroke="#9dcfc2" stroke-width="2" fill="none"/>' +
      '<path d="M0 18 Q50 52 100 16 T160 42" stroke="#f0c9a8" stroke-width="2" fill="none"/>' +
      '<text x="80" y="41" font-family="monospace" font-size="30" font-weight="bold" fill="#0E9F8A" ' +
      'text-anchor="middle" letter-spacing="8">' + code + '</text></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  /* ------------------------- 认证状态 ------------------------- */
  var auth = {
    initialized: qs.get('auth') !== 'setup',
    authenticated: qs.get('auth') !== 'login' && qs.get('auth') !== 'setup'
  };
  var password = '123456';

  /* ------------------------- 路由分发 ------------------------- */
  async function handle(path, method, init) {
    var url = new URL(path, location.origin);
    var p = url.pathname;
    var search = url.searchParams;
    var body = null;
    if (init && init.body) {
      if (typeof init.body === 'string') {
        try { body = JSON.parse(init.body); } catch (e) { body = null; }
      } else if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
        body = { _form: true };
      }
    }

    /* ---- 认证 ---- */
    if (p === '/api/auth/status' && method === 'GET') {
      return json({
        initialized: auth.initialized,
        authenticated: auth.authenticated,
        user: auth.authenticated ? userLite(currentMockUser()) : null
      });
    }
    if (p === '/api/auth/captcha' && method === 'GET') {
      // 演示模式：内置 SVG 占位验证码；登录接受任意验证码
      return json({ id: 'demo-captcha-' + (captchaSeq++), image: mockCaptchaImage(), expires_in: 300 });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      auth.authenticated = true;
      var loginName = String((body && body.username) || 'admin').trim();
      var foundUser = null;
      for (var ui = 0; ui < users.length; ui++) {
        if (users[ui].username.toLowerCase() === loginName.toLowerCase()) { foundUser = users[ui]; break; }
      }
      // 兼容用户名后续改为 wei：wei 视作管理员
      if (!foundUser && loginName.toLowerCase() === 'wei') foundUser = users[0];
      if (foundUser) currentUserId = foundUser.id;
      return json({ ok: true });
    }
    if (p === '/api/auth/setup' && method === 'POST') {
      auth.initialized = true;
      password = (body && body.password) || password;
      if (body && body.username) {
        users[0].username = String(body.username);
        users[0].display_name = users[0].display_name || '管理员';
      }
      currentUserId = users[0].id;
      return json({ ok: true });
    }
    if (p === '/api/auth/logout' && method === 'POST') {
      auth.authenticated = false;
      return json({ ok: true });
    }
    if (p === '/api/auth/password' && method === 'POST') {
      return json({ ok: true, message: '密码已修改（演示模式）' });
    }
    if (!auth.authenticated) return err('unauthorized', 401);

    /* ---- 首页 / 统计 ---- */
    if (p === '/api/dashboard' && method === 'GET') return json(dashboard(search.get('date')));

    if (p === '/api/stats' && method === 'GET') {
      var days = parseInt(search.get('days') || '7', 10) || 7;
      return json(computeStats(days));
    }

    if (p === '/api/reminders' && method === 'GET') {
      return json({ items: computeReminders(), now: nowIso() });
    }
    if (p === '/api/reminders/snooze' && method === 'POST') {
      var minutes = (body && body.minutes) || 10;
      snoozedUntil[body.key] = Date.now() + minutes * 60000;
      return json({ ok: true });
    }

    /* ---- 血压记录 ---- */
    if (p === '/api/measurements') {
      if (method === 'GET') {
        var from = search.get('from');
        var to = search.get('to');
        var limit = parseInt(search.get('limit') || '500', 10);
        var offset = parseInt(search.get('offset') || '0', 10);
        var items = measurements.filter(function (m) {
          var d = String(m.measured_at).slice(0, 10);
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        }).sort(function (a, b) {
          return String(b.measured_at).localeCompare(String(a.measured_at));
        });
        var total = items.length;
        return json({ items: items.slice(offset, offset + limit), total: total });
      }
      if (method === 'POST') {
        if (!body || !body.measured_at || !body.systolic || !body.diastolic) {
          return err('缺少必填字段：measured_at / systolic / diastolic', 422);
        }
        var at = body.measured_at;
        var rec = {
          id: measurementId++,
          measured_at: at,
          systolic: Number(body.systolic),
          diastolic: Number(body.diastolic),
          pulse: body.pulse != null ? Number(body.pulse) : null,
          arm: body.arm || 'left',
          position: body.position || 'sitting',
          slot: slotForTime(at),
          note: body.note || '',
          source: body.source || 'manual',
          created_at: nowIso(),
          updated_at: nowIso()
        };
        measurements.push(rec);
        return json(rec);
      }
    }
    var mMeas = p.match(/^\/api\/measurements\/(\d+)$/);
    if (mMeas) {
      var mid = Number(mMeas[1]);
      var idx = measurements.findIndex(function (m) { return m.id === mid; });
      if (idx < 0) return err('记录不存在', 404);
      if (method === 'PUT') {
        var patch = Object.assign({}, measurements[idx], body || {});
        patch.updated_at = nowIso();
        patch.slot = slotForTime(patch.measured_at);
        measurements[idx] = patch;
        return json(patch);
      }
      if (method === 'DELETE') {
        measurements.splice(idx, 1);
        return json({ ok: true });
      }
    }

    /* ---- 药品 ---- */
    if (p === '/api/medications') {
      if (method === 'GET') {
        var activeOnly = search.get('active') === '1';
        var meds = medications.filter(function (m) { return activeOnly ? m.active !== false : true; });
        return json({ items: meds });
      }
      if (method === 'POST') {
        if (!body || !body.name || !body.dose || !body.times || !body.times.length) {
          return err('缺少必填字段：name / dose / times', 422);
        }
        var med = {
          id: medIdSeq++,
          name: body.name,
          dose: Number(body.dose),
          unit: body.unit || '片',
          times: body.times.slice(),
          start_date: body.start_date || today(),
          end_date: body.end_date || null,
          active: true,
          note: body.note || ''
        };
        medications.push(med);
        syncTodayLogs();
        return json(med);
      }
    }
    var mMed = p.match(/^\/api\/medications\/(\d+)$/);
    if (mMed) {
      var medId = Number(mMed[1]);
      var mi = medications.findIndex(function (m) { return m.id === medId; });
      if (mi < 0) return err('药品不存在', 404);
      if (method === 'PUT') {
        medications[mi] = Object.assign({}, medications[mi], body || {});
        syncTodayLogs();
        return json(medications[mi]);
      }
      if (method === 'DELETE') {
        medications.splice(mi, 1);
        syncTodayLogs();
        return json({ ok: true });
      }
    }

    /* ---- 服药记录 ---- */
    if (p === '/api/medlogs' && method === 'GET') {
      var date = search.get('date') || today();
      syncTodayLogs();
      var logs = medlogs.filter(function (l) { return l.date === date; }).sort(function (a, b) {
        return String(a.scheduled_time).localeCompare(String(b.scheduled_time));
      });
      return json({ items: logs });
    }
    var mLog = p.match(/^\/api\/medlogs\/(\d+)\/(take|skip|undo)$/);
    if (mLog) {
      var logId = Number(mLog[1]);
      var action = mLog[2];
      var log = medlogs.filter(function (l) { return l.id === logId; })[0];
      if (!log) return err('服药任务不存在', 404);
      if (action === 'take') {
        log.status = 'taken';
        log.taken_at = nowIso();
        log.note = (body && body.note) || '';
      } else if (action === 'skip') {
        log.status = 'skipped';
        log.taken_at = null;
      } else {
        log.status = 'pending';
        log.taken_at = null;
      }
      return json(log);
    }

    /* ---- 设置 ---- */
    if (p === '/api/settings' && method === 'GET') return json(settings);
    if (p === '/api/settings' && method === 'PUT') {
      if (body) {
        Object.keys(body).forEach(function (k) {
          if (k === 'channels') {
            settings.channels = Object.assign({}, settings.channels, body.channels || {});
          } else {
            settings[k] = body[k];
          }
        });
      }
      return json(settings);
    }
    if (p === '/api/settings/test-channel' && method === 'POST') {
      var ch = body && body.channel;
      var label = { ntfy: 'ntfy', pushplus: 'PushPlus', email: '邮件', webhook: 'Webhook' }[ch] || ch;
      return json({ ok: true, message: '测试消息已发送到 ' + label + '（演示模式，不会真的发送）' });
    }

    /* ---- OCR ---- */
    if (p === '/api/ocr/health' && method === 'GET') return json({ available: true, engine: 'rapidocr' });
    if (p === '/api/ocr' && method === 'POST') {
      return json({
        engine: 'rapidocr',
        image_type: 'monitor',
        candidates: [{
          systolic: 152, diastolic: 93, pulse: 78, measured_at: null,
          confidence: 0.93, evidence: '152 93 78'
        }],
        raw_text: ['152', '93', '78', 'mmHg', 'PULSE'],
        upload_id: 7,
        message: '识别到 1 条测量记录（演示数据）'
      });
    }
    var mUpload = p.match(/^\/api\/ocr\/uploads\/(\d+)$/);
    if (mUpload) return err('演示模式不提供原图', 404);

    /* ---- 导出 ---- */
    if (p === '/api/export/csv' && method === 'GET') {
      var type = search.get('type') || 'bp';
      var lines = [];
      if (type === 'med') {
        lines.push('日期,时间,药品,剂量,单位,状态,服用时间');
        medlogs.slice().sort(function (a, b) {
          return (a.date + a.scheduled_time).localeCompare(b.date + b.scheduled_time);
        }).forEach(function (l) {
          lines.push([l.date, l.scheduled_time, l.name, l.dose, l.unit,
            l.status === 'taken' ? '已服' : l.status === 'skipped' ? '跳过' : '待办',
            l.taken_at || ''].join(','));
        });
      } else {
        lines.push('日期,时间,收缩压,舒张压,脉率,部位,体位,时段,备注,来源');
        measurements.slice().sort(function (a, b) {
          return String(a.measured_at).localeCompare(String(b.measured_at));
        }).forEach(function (m) {
          lines.push([
            m.measured_at.slice(0, 10), m.measured_at.slice(11, 16), m.systolic, m.diastolic,
            m.pulse || '', m.arm === 'left' ? '左臂' : m.arm === 'right' ? '右臂' : '',
            m.position === 'sitting' ? '坐姿' : m.position === 'lying' ? '卧姿' : m.position === 'standing' ? '站姿' : '',
            m.slot || '', (m.note || '').replace(/,/g, '，'), m.source === 'ocr' ? '拍照识别' : '手动'
          ].join(','));
        });
      }
      return text('\ufeff' + lines.join('\r\n'), 200, 'text/csv; charset=utf-8');
    }
    if (p === '/api/export/calendar.ics' && method === 'GET') {
      var ics = [];
      var icsStamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      var startDate = dstr(1).replace(/-/g, '');
      var addIcsEvent = function (uid, time, summary, alarmText) {
        ics.push('BEGIN:VEVENT');
        ics.push('UID:bp-demo-' + uid + '@localhost');
        ics.push('DTSTAMP:' + icsStamp);
        ics.push('DTSTART;TZID=' + settings.timezone + ':' + startDate + 'T' + time.replace(':', '') + '00');
        ics.push('DURATION:PT15M');
        ics.push('RRULE:FREQ=DAILY');
        ics.push('SUMMARY:' + summary);
        ics.push('DESCRIPTION:血压管家每日提醒');
        ics.push('BEGIN:VALARM');
        ics.push('ACTION:DISPLAY');
        ics.push('DESCRIPTION:' + alarmText);
        ics.push('TRIGGER:-PT5M');
        ics.push('END:VALARM');
        ics.push('END:VEVENT');
      };
      ics.push('BEGIN:VCALENDAR');
      ics.push('VERSION:2.0');
      ics.push('PRODID:-//血压管家//Demo//CN');
      ics.push('CALSCALE:GREGORIAN');
      ics.push('METHOD:PUBLISH');
      ics.push('X-WR-CALNAME:血压管家提醒（演示）');
      ics.push('X-WR-TIMEZONE:' + settings.timezone);
      ics.push('BEGIN:VTIMEZONE');
      ics.push('TZID:' + settings.timezone);
      ics.push('BEGIN:STANDARD');
      ics.push('DTSTART:19700101T000000');
      ics.push('TZOFFSETFROM:+0800');
      ics.push('TZOFFSETTO:+0800');
      ics.push('TZNAME:CST');
      ics.push('END:STANDARD');
      ics.push('END:VTIMEZONE');
      var icsSlots = [['morning', '早上测血压'], ['forenoon', '上午测血压'], ['afternoon', '下午测血压'], ['bedtime', '睡前测血压']];
      icsSlots.forEach(function (s) {
        addIcsEvent('measure-' + s[0], settings.slot_times[s[0]], s[1], '该测血压了');
      });
      medications.filter(function (m) { return m.active !== false; }).forEach(function (med) {
        (med.times || []).forEach(function (t, i) {
          addIcsEvent('med-' + med.id + '-' + i, t, '吃药：' + med.name + ' ' + med.dose + med.unit, '该吃药了');
        });
      });
      ics.push('END:VCALENDAR');
      return text(ics.join('\r\n'), 200, 'text/calendar; charset=utf-8');
    }
    if (p === '/api/export/xlsx' && method === 'GET') {
      return text('演示模式占位文件：真实后端会生成包含「血压记录」「服药记录」「统计摘要」的 .xlsx 文件。',
        200, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }
    if (p === '/api/export/backup' && method === 'GET') {
      return text(JSON.stringify({
        exported_at: nowIso(),
        settings: settings,
        medications: medications,
        measurements: measurements,
        medlogs: medlogs
      }, null, 2), 200, 'application/json; charset=utf-8');
    }

    /* ---- 从备份恢复（演示模式：不写入真实数据，仅返回导入条数） ---- */
    if (p === '/api/import/backup' && method === 'POST') {
      if (!body || !body.backup || typeof body.backup !== 'object') {
        return err('备份内容为空或格式不正确', 422);
      }
      var b = body.backup;
      var count = function (arr) { return Array.isArray(arr) ? arr.length : 0; };
      return json({
        ok: true,
        imported: {
          measurements: count(b.measurements),
          medications: count(b.medications),
          med_logs: count(b.medlogs) || count(b.med_logs),
          settings: !!(b.settings && typeof b.settings === 'object')
        },
        demo: true
      });
    }

    /* ---- 多用户：患者列表 / 管理员用户管理 ---- */
    if (p === '/api/patients' && method === 'GET') {
      var cu = currentMockUser();
      var patientList = [];
      if (cu.role === 'admin') {
        patientList = users.filter(function (u) { return u.role === 'user'; });
      } else if (cu.role === 'doctor') {
        patientList = users.filter(function (u) {
          return u.role === 'user' && (cu.patient_ids || []).map(Number).indexOf(Number(u.id)) >= 0;
        });
      } else {
        patientList = [cu];
      }
      return json({ items: patientList.map(userLite) });
    }
    if (p === '/api/admin/users' && method === 'GET') {
      if (!isMockAdmin()) return err('需要管理员权限', 403);
      return json({ items: users.map(userPublic) });
    }
    if (p === '/api/admin/users' && method === 'POST') {
      if (!isMockAdmin()) return err('需要管理员权限', 403);
      var newUsername = body && String(body.username || '').trim();
      if (!newUsername) return err('用户名为必填项', 422);
      if (users.some(function (u) { return u.username.toLowerCase() === newUsername.toLowerCase(); })) {
        return err('用户名已存在', 400);
      }
      if (!body.role || ['admin', 'user', 'doctor'].indexOf(body.role) < 0) return err('角色不正确', 422);
      if (!body.password || String(body.password).length < 6) return err('密码至少 6 位', 422);
      var newUser = {
        id: userIdSeq++, username: newUsername, display_name: body.display_name || '',
        role: body.role, created_at: nowIso(), patient_ids: [], doctor_ids: []
      };
      users.push(newUser);
      return json(userPublic(newUser));
    }
    var mAdminUser = p.match(/^\/api\/admin\/users\/(\d+)$/);
    if (mAdminUser) {
      if (!isMockAdmin()) return err('需要管理员权限', 403);
      var targetUser = userById(Number(mAdminUser[1]));
      if (!targetUser) return err('用户不存在', 404);
      if (method === 'PATCH') {
        if (targetUser.id === currentUserId && body && body.role && body.role !== targetUser.role) {
          return err('不能修改自己的角色', 400);
        }
        if (targetUser.role === 'admin' && body && body.role && body.role !== 'admin' &&
          users.filter(function (u) { return u.role === 'admin'; }).length <= 1) {
          return err('至少保留一个管理员', 400);
        }
        if (body) {
          if (body.display_name !== undefined) targetUser.display_name = String(body.display_name || '');
          if (body.role) targetUser.role = body.role;
        }
        return json(userPublic(targetUser));
      }
      if (method === 'DELETE') {
        if (targetUser.id === currentUserId) return err('不能删除自己', 400);
        if (targetUser.role === 'admin' &&
          users.filter(function (u) { return u.role === 'admin'; }).length <= 1) {
          return err('不能删除最后一个管理员', 400);
        }
        var removedId = targetUser.id;
        users = users.filter(function (u) { return u.id !== removedId; });
        users.forEach(function (u) {
          u.patient_ids = (u.patient_ids || []).filter(function (x) { return Number(x) !== removedId; });
          u.doctor_ids = (u.doctor_ids || []).filter(function (x) { return Number(x) !== removedId; });
        });
        return json({ ok: true });
      }
    }
    if (p === '/api/admin/links' && method === 'POST') {
      if (!isMockAdmin()) return err('需要管理员权限', 403);
      if (!addMockLink(Number(body && body.doctor_id), Number(body && body.patient_id))) {
        return err('绑定失败：医生或患者不存在，或角色不正确', 400);
      }
      return json({ ok: true });
    }
    if (p === '/api/admin/links' && method === 'DELETE') {
      if (!isMockAdmin()) return err('需要管理员权限', 403);
      removeMockLink(Number(search.get('doctor_id')), Number(search.get('patient_id')));
      return json({ ok: true });
    }

    /* ---- 其他 ---- */
    if (p === '/api/health' && method === 'GET') {
      return json({ status: 'ok', version: '1.0.0-demo', time: nowIso() });
    }

    return err('接口不存在：' + p, 404);
  }

  /* ------------------------- fetch 拦截 ------------------------- */
  var requestLog = [];
  var originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    var pathname = '';
    try {
      pathname = new URL(url, location.href).pathname;
    } catch (e) { pathname = url; }
    if (pathname.indexOf('/api/') === 0) {
      var fullPath = pathname + (url.indexOf('?') >= 0 ? url.slice(url.indexOf('?')) : '');
      requestLog.push({
        method: method,
        path: fullPath,
        body: (init && typeof init.body === 'string') ? init.body : null
      });
      return handle(fullPath, method, init || {})
        .catch(function (e) {
          return json({ detail: '演示数据出错：' + (e && e.message) }, 500);
        });
    }
    return originalFetch(input, init);
  };

  BP.mock = {
    store: function () {
      return {
        settings: settings, medications: medications, measurements: measurements, medlogs: medlogs,
        users: users, auth: auth, currentUserId: currentUserId
      };
    },
    requests: requestLog,
    setRole: function (role) {
      var map = { admin: 1, user: 2, doctor: 4 };
      if (map[role]) currentUserId = map[role];
      auth.authenticated = true;
    },
    currentUser: function () { return userPublic(currentMockUser()); },
    reset: function () {
      snoozedUntil = {};
      seedMedlogs();
      requestLog.length = 0;
    }
  };
})();
