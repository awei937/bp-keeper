/* 血压管家 — 内联 SVG 图标库（全部自绘，无外部依赖） */
(function () {
  'use strict';
  window.BP = window.BP || {};

  var P = {
    home: '<path d="M3.2 10.6 12 3.3l8.8 7.3"/><path d="M5.3 9.4V20.2h13.4V9.4"/><path d="M9.6 20.2v-5.6h4.8v5.6"/>',
    records: '<rect x="4.2" y="3.6" width="15.6" height="16.8" rx="2.6"/><path d="M8 8.2h8M8 12h8M8 15.8h4.6"/>',
    pill: '<path d="M14.6 3.5a5 5 0 0 1 6.9 7l-4.6 4.6a5 5 0 0 1-7 0l-2.5-2.5a5 5 0 0 1 0-7 5 5 0 0 1 7 0z"/><path d="M8.1 7.9l8 8"/>',
    sliders: '<path d="M4 7.2h7.6M16.4 7.2H20M4 16.8h4.6M13.4 16.8H20"/><circle cx="13.8" cy="7.2" r="2.4"/><circle cx="10.8" cy="16.8" r="2.4"/>',
    plus: '<path d="M12 5.2v13.6M5.2 12h13.6"/>',
    minus: '<path d="M5.2 12h13.6"/>',
    camera: '<path d="M3.4 8.2h3.4l1.6-2.6h6.9l1.6 2.6h3.7v11H3.4z"/><circle cx="12" cy="13.3" r="3.4"/>',
    close: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8"/>',
    check: '<path d="M4.4 12.4l4.9 4.9L19.7 6.9"/>',
    x: '<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8"/>',
    'chevron-right': '<path d="M9.2 5.4 15.9 12l-6.7 6.6"/>',
    'chevron-down': '<path d="M5.4 9.2 12 15.9l6.6-6.7"/>',
    edit: '<path d="M16.4 3.7a2.2 2.2 0 0 1 3.1 3.1L7.3 19.1l-4.1 1 1-4.1z"/>',
    trash: '<path d="M4 6.8h16M9.2 6.8V3.9h5.6v2.9M6.5 6.8l1 13.3h9l1-13.3"/><path d="M10.2 10.5v6.2M13.8 10.5v6.2"/>',
    download: '<path d="M12 3.4v11.8M7.6 10.9 12 15.3l4.4-4.4M4.2 20.3h15.6"/>',
    upload: '<path d="M12 15.4V3.6M7.6 8 12 3.6 16.4 8M4.2 20.4h15.6"/>',
    bell: '<path d="M6.2 9.4a5.8 5.8 0 0 1 11.6 0c0 4.7 1.9 5.6 1.9 5.6H4.3s1.9-.9 1.9-5.6"/><path d="M10 19.1a2.1 2.1 0 0 0 4 0"/>',
    alarm: '<circle cx="12" cy="13.2" r="7.2"/><path d="M12 9.6v3.6l2.4 1.7M4.6 4.6l2.5-1.7M19.4 4.6l-2.5-1.7"/>',
    heart: '<path d="M12 20.4S3.9 15.5 3.9 9.9A4.6 4.6 0 0 1 12 6.7a4.6 4.6 0 0 1 8.1 3.2c0 5.6-8.1 10.5-8.1 10.5z"/>',
    pulse: '<path d="M2.6 12.4h4l2.1-6.3 4.2 12.1 2.2-5.8h6.3"/>',
    lock: '<rect x="4.9" y="10.6" width="14.2" height="10" rx="2.3"/><path d="M8.2 10.6V7.9a3.8 3.8 0 0 1 7.6 0v2.7"/><circle cx="12" cy="15.6" r="1.3"/>',
    eye: '<path d="M2.4 12S6 5.9 12 5.9 21.6 12 21.6 12 18 18.1 12 18.1 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.8"/>',
    'eye-off': '<path d="M3 3l18 18M10.6 6.2A9.9 9.9 0 0 1 12 6.1c6 0 9.6 6 9.6 6a16.6 16.6 0 0 1-3 3.7M6.4 6.7A16 16 0 0 0 2.4 12s3.6 6 9.6 6a9.4 9.4 0 0 0 3.3-.6"/><path d="M9.9 10a3 3 0 0 0 4.2 4.2"/>',
    clock: '<circle cx="12" cy="12" r="8.4"/><path d="M12 7.2V12l3.1 2.1"/>',
    calendar: '<rect x="3.6" y="5.2" width="16.8" height="15.4" rx="2.4"/><path d="M8 3.2v3.8M16 3.2v3.8M3.6 10.2h16.8"/>',
    chart: '<path d="M4 4.2v15.6h16"/><path d="M7.4 15.4l3.6-5 3 3 5.2-7"/>',
    user: '<circle cx="12" cy="8.2" r="3.9"/><path d="M4.4 20.6c0-3.9 3.4-6.1 7.6-6.1s7.6 2.2 7.6 6.1"/>',
    shield: '<path d="M12 3.2l8 2.8v6c0 5.2-3.6 8.3-8 9.4-4.4-1.1-8-4.2-8-9.4V6z"/><path d="M8.7 12.3l2.3 2.3 4.3-4.5"/>',
    refresh: '<path d="M20.2 12a8.2 8.2 0 1 1-2.4-5.8M20.2 4.1v5.2h-5.2"/>',
    info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.2M12 8.1h.01"/>',
    mail: '<rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.4"/><path d="M3.8 7.2 12 13l8.2-5.8"/>',
    chat: '<path d="M4.2 4.6h15.6v11.2H9.5l-5.3 3.8z"/>',
    link: '<path d="M10.2 13.8a4.2 4.2 0 0 0 5.9 0l3-3a4.2 4.2 0 0 0-5.9-5.9l-1.4 1.4"/><path d="M13.8 10.2a4.2 4.2 0 0 0-5.9 0l-3 3a4.2 4.2 0 0 0 5.9 5.9l1.4-1.4"/>',
    server: '<rect x="3.2" y="4" width="17.6" height="6.2" rx="2"/><rect x="3.2" y="13.8" width="17.6" height="6.2" rx="2"/><path d="M7 7.1h.01M7 16.9h.01"/>',
    database: '<ellipse cx="12" cy="6.2" rx="7.8" ry="2.9"/><path d="M4.2 6.2v11.6c0 1.6 3.5 2.9 7.8 2.9s7.8-1.3 7.8-2.9V6.2"/><path d="M4.2 12c0 1.6 3.5 2.9 7.8 2.9s7.8-1.3 7.8-2.9"/>',
    'file-text': '<path d="M6 3.4h7.3L19 9.1v11.5H6z"/><path d="M13.2 3.4v5.8H19M9.2 13.1h6.6M9.2 16.8h4.4"/>',
    logout: '<path d="M9.4 20.6H5.2a1.4 1.4 0 0 1-1.4-1.4V4.8a1.4 1.4 0 0 1 1.4-1.4h4.2"/><path d="M16.2 16.9 21 12l-4.8-4.9M21 12H9.4"/>',
    key: '<circle cx="8.2" cy="15.8" r="3.8"/><path d="M10.9 13.1 20.6 3.4M17.2 6.8l2.4 2.4M14.6 9.4l2.2 2.2"/>',
    'arrow-left': '<path d="M19.4 12H4.6M10.6 17.8 4.6 12l6-5.8"/>',
    'arrow-right': '<path d="M4.6 12h14.8M13.4 5.8l6 6.2-6 6.2"/>',
    'trend-up': '<path d="M3.6 17.4 9.8 11l3.9 3.9 6.7-6.7"/><path d="M15.2 8.2h5.2v5.2"/>',
    target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="4.6"/><circle cx="12" cy="12" r="1.1"/>',
    wifi: '<path d="M2.8 9.2a13.4 13.4 0 0 1 18.4 0M6.2 12.7a8.7 8.7 0 0 1 11.6 0M9.5 16.2a4.1 4.1 0 0 1 5 0"/><circle cx="12" cy="19.4" r="1.2"/>',
    sparkles: '<path d="M12 3.4l1.9 5.1 5.1 1.9-5.1 1.9L12 17.4l-1.9-5.1-5.1-1.9 5.1-1.9z"/><path d="M19 16.4l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',
    home2: '<path d="M4 10.8 12 4.4l8 6.4V20H4z"/><path d="M9.6 20v-5.2h4.8V20"/>',
    stop: '<rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.4"/>',
    'check-circle': '<circle cx="12" cy="12" r="8.6"/><path d="M8.2 12.2l2.6 2.6 5-5.2"/>',
    'alert-circle': '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5.2M12 16.2h.01"/>',
    'rotate-ccw': '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8M3.8 4.1v5.2h5.2"/>',
    image: '<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.6"/><circle cx="8.7" cy="9.7" r="1.8"/><path d="M4 17.2l4.9-4.7 3.4 3.2 2.9-2.7 4.8 4.2"/>',
    droplet: '<path d="M12 3.4c3.4 4 6 7 6 10.1a6 6 0 0 1-12 0C6 10.4 8.6 7.4 12 3.4z"/>',
    printer: '<path d="M6.6 8.6V3.8h10.8v4.8"/><path d="M6.6 17.2H4.4a1.8 1.8 0 0 1-1.8-1.8v-4.9a1.8 1.8 0 0 1 1.8-1.8h15.2a1.8 1.8 0 0 1 1.8 1.8v4.9a1.8 1.8 0 0 1-1.8 1.8h-2.2"/><rect x="6.6" y="13.6" width="10.8" height="7.1" rx="1.4"/><path d="M17.6 11.2h.01"/>',
    scale: '<path d="M12 3.4v17M6 20.4h12"/><path d="M12 7 5.2 9.2 2.6 15.4a3.2 3.2 0 0 0 6 0zM12 7l6.8 2.2 2.6 6.2a3.2 3.2 0 0 1-6 0z"/>'
  };

  function icon(name, size, opts) {
    opts = opts || {};
    var s = size || 24;
    var sw = opts.sw || 1.8;
    var path = P[name] || P.info;
    return '<svg class="ic' + (opts.cls ? ' ' + opts.cls : '') + '" width="' + s + '" height="' + s +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw +
      '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + path + '</svg>';
  }

  function logo(size, opts) {
    opts = opts || {};
    var s = size || 40;
    var id = 'bplogo' + (opts.uid || '');
    return '<svg class="bp-logo" width="' + s + '" height="' + s + '" viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
      '<defs><linearGradient id="' + id + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#18B49D"/><stop offset="1" stop-color="#07806F"/></linearGradient></defs>' +
      '<rect width="64" height="64" rx="19" fill="url(#' + id + ')"/>' +
      '<path d="M12.5 33.5h8.2l4.3-9.6 6.5 17.2 4.1-8.4h15.9" fill="none" stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<circle cx="50.5" cy="33.5" r="2.6" fill="#FFC48A"/></svg>';
  }

  BP.icons = { icon: icon, logo: logo, paths: P };
})();
