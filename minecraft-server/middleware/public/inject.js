/* ============================================================
   OmenHosting — panel enhancements
   Served from /api/omen/inject.js (cached, ETag'd)

   Perf design:
   - One rAF-debounced MutationObserver pass instead of running every
     handler on every mutation record.
   - Mutations confined to the xterm console are ignored: the terminal
     mutates on every log line and none of our handlers care about it.
   - Network calls are on fixed timers with in-flight guards + TTL caches,
     never driven by DOM mutations, and pause while the tab is hidden.
   ============================================================ */
(function () {
  'use strict';

  // The panel's own index.html also hardcodes a tag for this file, so without
  // a guard the whole module runs twice — double observers, timers and fetches.
  if (window.__omenInjected) return;
  window.__omenInjected = true;

  // ─── Small helpers ────────────────────────────────────────────
  var IDLE = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1); };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function getInstanceUuid() {
    var m = (window.location.hash || '').match(/[?&](?:uuid|instanceId)=([^&]+)/);
    return m ? m[1] : '';
  }

  // A tiny JSON fetch that never rejects and never piles up duplicate calls.
  var inFlight = {};
  function getJSON(url) {
    if (inFlight[url]) return inFlight[url];
    var p = fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (v) { delete inFlight[url]; return v; });
    inFlight[url] = p;
    return p;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  // ─── Shared state ─────────────────────────────────────────────
  var sleepCache = {};         // instance uuid -> { sleeping, at }
  var SLEEP_TTL = 30000;

  // ─── Backup / restore progress ────────────────────────────────
  // Rendered above the console for the open instance. Polls only while a
  // transfer is actually in flight so an idle panel makes no extra requests.

  var backupStates = {};
  var backupPollTimer = null;

  var BACKUP_BUSY = [
    'Preparing Backup', 'Compressing', 'Verifying',
    'Uploading', 'Downloading', 'Extracting'
  ];

  function isBackupBusy(state) {
    return BACKUP_BUSY.indexOf(state) !== -1;
  }

  function fetchBackupStatus() {
    if (document.hidden) return;
    getJSON('/api/omen/backup/status').then(function (data) {
      if (!data || !data.enabled) return;
      backupStates = data.states || {};
      renderBackupBox();

      // Poll fast while something is running, otherwise fall back to the
      // slow cadence so an idle panel stays quiet.
      var busy = Object.keys(backupStates).some(function (k) {
        return isBackupBusy(backupStates[k].state);
      });
      setBackupPoll(busy ? 2000 : 15000);
    });
  }

  function setBackupPoll(interval) {
    if (backupPollTimer && backupPollTimer.interval === interval) return;
    if (backupPollTimer) clearInterval(backupPollTimer.id);
    var id = setInterval(fetchBackupStatus, interval);
    backupPollTimer = { id: id, interval: interval };
  }

  function renderBackupBox() {
    var uuid = getInstanceUuid();
    var status = uuid ? backupStates[uuid] : null;
    var existing = document.querySelector('.omen-backup-box');

    // Nothing to show: drop the box rather than leaving a stale "Completed".
    if (!status || status.state === 'idle') {
      if (existing) existing.remove();
      return;
    }

    var consoleArea = document.querySelector('.terminal-wrapper, .console-wrapper, [class*="terminal"]');
    if (!consoleArea) {
      if (existing) existing.remove();
      return;
    }

    var failed = status.state === 'Failed';
    var done = status.state === 'Completed';
    var busy = isBackupBusy(status.state);
    var kind = failed ? 'is-failed' : (done ? 'is-done' : 'is-busy');

    var box = existing;
    if (!box) {
      box = el('div', 'omen-backup-box');
      consoleArea.parentNode.insertBefore(box, consoleArea);
    }

    // Rebuild only when something changed, so the retry button stays clickable.
    var signature = [status.state, status.progress, status.message, status.retryable].join('|');
    if (box.dataset.sig === signature) return;
    box.dataset.sig = signature;

    box.className = 'omen-backup-box ' + kind;
    box.innerHTML =
      '<div class="omen-backup-box__head">' +
        '<span class="omen-backup-box__label">' +
          (busy ? '<span class="omen-spinner"></span>' : '') +
          'Cloud Backup' +
        '</span>' +
        '<span class="omen-backup-box__state">' + escapeHtml(status.state) + '</span>' +
      '</div>' +
      (busy && status.progress
        ? '<div class="omen-backup-bar"><div class="omen-backup-bar__fill" style="width:' +
          Math.max(0, Math.min(100, status.progress)) + '%"></div></div>'
        : '') +
      '<div class="omen-backup-box__msg">' + escapeHtml(status.message || '') + '</div>' +
      (failed && status.retryable
        ? '<button class="omen-btn omen-backup-retry" type="button">Retry Upload</button>'
        : '');

    var retry = box.querySelector('.omen-backup-retry');
    if (retry) {
      retry.addEventListener('click', function () {
        retry.disabled = true;
        retry.textContent = 'Retrying…';
        fetch('/api/omen/backup/retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: getInstanceUuid() })
        })
          .then(function () { setBackupPoll(2000); fetchBackupStatus(); })
          .catch(function () { retry.disabled = false; retry.textContent = 'Retry Upload'; });
      });
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  // ─── DOM pass: server address box above the console ───────────
  var ipBoxTimer = null;

  function addIpBox() {
    var consoleArea = document.querySelector('.terminal-wrapper, .console-wrapper, [class*="terminal"]');

    // Console left the DOM (SPA navigation) — drop the poll so it can't leak.
    if (!consoleArea) {
      if (ipBoxTimer) { clearInterval(ipBoxTimer); ipBoxTimer = null; }
      return;
    }
    if (document.querySelector('.omen-ip-box')) return;

    var uuid = getInstanceUuid();
    if (!uuid) return;

    var box = el('div', 'omen-ip-box',
      '<div class="omen-ip-box__icon">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
        '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>' +
      '</div>' +
      '<div class="omen-ip-box__meta">' +
        '<div class="omen-ip-box__label">Server Address</div>' +
        '<div class="omen-ip-box__value" id="omen-ip-value">Detecting…</div>' +
      '</div>' +
      '<button class="omen-btn" id="omen-copy-ip" type="button">Copy</button>');

    consoleArea.parentNode.insertBefore(box, consoleArea);

    box.querySelector('#omen-copy-ip').addEventListener('click', function () {
      var btn = this;
      var ip = document.getElementById('omen-ip-value').textContent;
      if (!ip || ip === 'Detecting…' || ip === 'Not available') return;
      copyText(ip).then(function () {
        btn.textContent = 'Copied';
        btn.classList.add('omen-btn--ok');
        setTimeout(function () {
          btn.textContent = 'Copy';
          btn.classList.remove('omen-btn--ok');
        }, 2000);
      }).catch(function () {});
    });

    function update() {
      if (document.hidden) return;
      var id = getInstanceUuid();
      if (!id) return;
      getJSON('/api/omen/minekube/' + id).then(function (data) {
        var v = document.getElementById('omen-ip-value');
        if (!v) return;
        if (data && data.address) {
          v.textContent = data.address;
        } else {
          v.textContent = 'Not available';
        }
      });
    }

    update();
    if (ipBoxTimer) clearInterval(ipBoxTimer);
    ipBoxTimer = setInterval(update, 10000);
  }

  // ─── DOM pass: status dots ────────────────────────────────────
  var STATUS_KIND = {
    running: 'is-running',
    online: 'is-running',
    starting: 'is-starting',
    stopping: 'is-stopping',
    stopped: 'is-stopped',
    offline: 'is-stopped',
    error: 'is-error',
    busy: 'is-starting'
  };

  function addStatusIndicator() {
    var tags = document.querySelectorAll('.ant-tag:not([data-omen-dot])');
    for (var i = 0; i < tags.length; i++) {
      var tag = tags[i];
      var text = tag.textContent.trim().toLowerCase();
      var kind = STATUS_KIND[text] || '';
      if (!kind) continue;
      tag.insertBefore(el('span', 'omen-status-dot ' + kind), tag.firstChild);
      tag.setAttribute('data-omen-dot', '1');
    }

    // Sleeping state is server-side; cache it so we don't refetch per mutation.
    var cards = document.querySelectorAll('[data-instance-uuid]');
    for (var j = 0; j < cards.length; j++) {
      (function (card) {
        var uuid = card.getAttribute('data-instance-uuid');
        if (!uuid) return;
        var hit = sleepCache[uuid];
        if (hit && Date.now() - hit.at < SLEEP_TTL) {
          if (hit.sleeping) markSleeping(card);
          return;
        }
        if (document.hidden) return;
        getJSON('/api/omen/autosleep/' + uuid).then(function (data) {
          sleepCache[uuid] = { sleeping: !!(data && data.sleeping), at: Date.now() };
          if (sleepCache[uuid].sleeping) markSleeping(card);
        });
      })(cards[j]);
    }
  }

  function markSleeping(card) {
    var tag = card.querySelector('.ant-tag');
    if (!tag || tag.getAttribute('data-omen-sleep')) return;
    tag.innerHTML = '<span class="omen-status-dot is-sleeping"></span>Sleeping';
    tag.style.color = 'var(--pt-warn)';
    tag.style.borderColor = 'rgba(240,180,41,.35)';
    tag.style.background = 'rgba(240,180,41,.14)';
    tag.setAttribute('data-omen-sleep', '1');
    tag.setAttribute('data-omen-dot', '1');
  }

  // ─── My Application dashboard: Create Server button + modal ───
  // Lives inside the panel's own "Instance List" card header rather than as
  // a floating link to a separate page, so creating a server is part of the
  // dashboard someone is already looking at instead of a detour off it.
  function addCreateServerButton() {
    if (document.querySelector('.omen-dash-create-btn')) return;

    var titleEl = findExactText('Instance List');
    var header = titleEl && titleEl.closest('.card-panel-title');
    if (!header) return;   // not on the My Application dashboard right now

    var btn = el('button', 'omen-dash-create-btn', '+ Create Server');
    btn.type = 'button';
    header.appendChild(btn);
    btn.addEventListener('click', showCreateServerModal);
  }

  function showCreateServerModal() {
    if (document.querySelector('.omen-create-modal')) return;

    var modal = buildModal('omen-create-modal',
      '<h2 class="omen-modal__title">Create Minecraft Server</h2>' +
      '<p class="omen-modal__sub">Instantly create a server with Minekube Connect</p>' +
      '<div class="omen-field"><label>Server Name</label>' +
        '<input id="omen-create-name" type="text" placeholder="my-server" maxlength="30"></div>' +
      '<div class="omen-msg omen-msg--err" id="omen-create-error" style="display:none"></div>' +
      '<div class="omen-modal__actions">' +
        '<button class="omen-btn omen-btn--ghost" id="omen-create-cancel" type="button">Cancel</button>' +
        '<button class="omen-btn" id="omen-create-submit" type="button">Create Server</button>' +
      '</div>');

    var errEl = modal.querySelector('#omen-create-error');
    var submit = modal.querySelector('#omen-create-submit');

    modal.querySelector('#omen-create-cancel').onclick = function () { modal.remove(); };

    submit.onclick = function () {
      var name = modal.querySelector('#omen-create-name').value.trim() || 'minecraft-server';

      errEl.style.display = 'none';
      submit.disabled = true;
      submit.textContent = 'Creating...';

      getJSON('/api/omen/whoami').then(function (who) {
        return fetch('/api/omen/create-server', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nickname: name, userUuid: (who && who.uuid) || '' })
        });
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          if (res.ok && res.data && !res.data.error) {
            modal.remove();
            // The panel's own instance list has no cheap "refresh" hook to
            // call into from outside its Vue app, so a reload is what
            // actually shows the server that was just created.
            window.location.reload();
          } else {
            errEl.textContent = (res.data && res.data.error) || 'Failed to create server';
            errEl.style.display = 'block';
            submit.disabled = false;
            submit.textContent = 'Create Server';
          }
        })
        .catch(function () {
          errEl.textContent = 'Connection error';
          errEl.style.display = 'block';
          submit.disabled = false;
          submit.textContent = 'Create Server';
        });
    };
  }

  function addSignupLink() {
    if (!(window.location.hash || '').includes('/login')) return;
    if (document.querySelector('.omen-signup-link')) return;

    var form = document.querySelector('.login-panel-body, .login-panel, .ant-card, form');
    if (!form) return;

    var link = el('div', 'omen-signup-link',
      "<span>Don't have an account? </span>" +
      '<a href="javascript:void(0)" id="omen-signup-btn">Create Account</a>');

    form.appendChild(link);
    link.querySelector('#omen-signup-btn').addEventListener('click', showSignupModal);
  }

  function buildModal(cls, inner) {
    var modal = el('div', 'omen-modal ' + cls, '<div class="omen-modal__card">' + inner + '</div>');
    document.body.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) modal.remove(); });
    return modal;
  }

  function showSignupModal() {
    if (document.querySelector('.omen-signup-modal')) return;

    var modal = buildModal('omen-signup-modal',
      '<h2 class="omen-modal__title">Create Account</h2>' +
      '<p class="omen-modal__sub">Sign up to deploy your Minecraft server</p>' +
      '<div class="omen-field"><label>Username</label>' +
        '<input id="omen-signup-user" type="text" placeholder="3-20 characters" autocomplete="username"></div>' +
      '<div class="omen-field"><label>Password</label>' +
        '<input id="omen-signup-pass" type="password" placeholder="At least 6 characters" autocomplete="new-password"></div>' +
      '<div class="omen-msg omen-msg--err" id="omen-signup-error" style="display:none"></div>' +
      '<div class="omen-msg omen-msg--ok" id="omen-signup-success" style="display:none"></div>' +
      '<div class="omen-modal__actions">' +
        '<button class="omen-btn omen-btn--ghost" id="omen-signup-cancel" type="button">Cancel</button>' +
        '<button class="omen-btn" id="omen-signup-submit" type="button">Sign Up</button>' +
      '</div>');

    var errEl = modal.querySelector('#omen-signup-error');
    var okEl = modal.querySelector('#omen-signup-success');
    var submit = modal.querySelector('#omen-signup-submit');

    modal.querySelector('#omen-signup-cancel').onclick = function () { modal.remove(); };

    submit.onclick = function () {
      var username = modal.querySelector('#omen-signup-user').value.trim();
      var password = modal.querySelector('#omen-signup-pass').value;

      errEl.style.display = 'none';
      okEl.style.display = 'none';

      function fail(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

      if (username.length < 3) return fail('Username must be at least 3 characters');
      if (password.length < 6) return fail('Password must be at least 6 characters');

      submit.disabled = true;
      fetch('/api/omen/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.success) {
            okEl.textContent = 'Account created — you can now log in.';
            okEl.style.display = 'block';
            setTimeout(function () { modal.remove(); }, 1800);
          } else {
            fail((data && data.error) || 'Signup failed');
            submit.disabled = false;
          }
        })
        .catch(function () { fail('Connection error'); submit.disabled = false; });
    };
  }

  // ─── Persistent sidebar ────────────────────────────────────────
  // Shown whenever an instance is open (Console/Files/Config/etc — anything
  // with a uuid in the hash). MCSManager's own layout is a top-nav app with
  // no left rail for a single-server view, so this is a fixed overlay: the
  // panel's own header and content get shifted right via the
  // `omen-has-sidebar` body class in theme.css, and this is hidden below the
  // same breakpoint where MCSManager's own layout already switches to its
  // mobile fab-menu, so nothing fights that existing responsive behavior.

  // Custom icon chips — deliberately not the OS's native emoji font (an
  // actual Unicode emoji character renders as a completely different glyph
  // per platform: Apple's own art on macOS, Noto/Twemoji-ish elsewhere, a
  // plain box on anything with no matching font). Each of these is instead
  // a small self-contained SVG, pixel-identical everywhere this panel is
  // opened, with no font or external asset dependency.
  //
  // Colored one-hue-per-item at first (blue/purple/orange/pink/...), which
  // looked like an unrelated sticker pack next to the rest of this panel —
  // none of those colors exist anywhere else in the app. Rebuilt to reuse
  // the exact tinted-circle-plus-green-glyph language the resource-usage
  // icons already used before any of this redesign started (a soft
  // rgba(--pt-accent-rgb) fill with a --pt-primary-300 glyph), the same
  // green the sidebar's own active-item highlight and every status dot in
  // this app already use — so these read as part of one system instead of
  // a decoration bolted on top of it. Differentiation between items comes
  // from the glyph shape, not a rainbow of unrelated hues.
  function chip(glyph) {
    return '<svg width="18" height="18" viewBox="0 0 24 24">' +
      '<circle cx="12" cy="12" r="12" fill="rgba(34,197,94,0.16)"/>' +
      '<g fill="none" stroke="#4ade80" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + glyph + '</g>' +
    '</svg>';
  }

  var SIDEBAR_ICONS = {
    console: chip('<path d="M7 8l3 3-3 3"/><path d="M12 15h5"/>'),
    files: chip('<path d="M6 8h4l1.5 2H18a1 1 0 011 1v6a1 1 0 01-1 1H6a1 1 0 01-1-1V9a1 1 0 011-1z"/>'),
    plugins: chip('<path d="M9 8h3V6.5a1.5 1.5 0 013 0V8h3v3h1.5a1.5 1.5 0 010 3H18v3h-3v-1.5a1.5 1.5 0 00-3 0V17H9v-3H7.5a1.5 1.5 0 010-3H9V8z"/>'),
    modpacks: chip('<path d="M12 6l6 3.5v5L12 18l-6-3.5v-5z"/><path d="M6 9.5l6 3.5 6-3.5M12 13v5"/>'),
    backups: chip('<path d="M8 17a3.5 3.5 0 010-7 4.5 4.5 0 018.6-1.5A3.5 3.5 0 0117 17H8z"/>'),
    network: chip('<circle cx="12" cy="12" r="6"/><path d="M6 12h12"/><path d="M12 6c1.8 1.8 1.8 10.2 0 12M12 6c-1.8 1.8-1.8 10.2 0 12" stroke-width="1.3"/>'),
    settings: chip('<circle cx="12" cy="12" r="2.4"/><path d="M12 7.5v-2M12 18.5v-2M16.5 12h2M5.5 12h2M15.2 8.8l1.4-1.4M7.4 16.6l1.4-1.4M15.2 15.2l1.4 1.4M7.4 7.4l1.4 1.4" stroke-width="1.5"/>'),
    'mi-configuration-files': chip('<path d="M8 6h6l3 3v9a1 1 0 01-1 1H8a1 1 0 01-1-1V7a1 1 0 011-1z"/><path d="M9.5 13h5M9.5 16h5"/>'),
    'mi-file-management': chip('<path d="M5 8h5l1.5 2H19a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V9a1 1 0 011-1z"/>'),
    'mi-java-manager': chip('<path d="M8 10h7v4a3.5 3.5 0 01-3.5 3.5h-1A3.5 3.5 0 017 14v-4z"/><path d="M15 11h1.5a1.5 1.5 0 010 3H15"/>'),
    'mi-scheduled-tasks': chip('<circle cx="12" cy="12.5" r="6"/><path d="M12 9v3.5l2.5 1.5" stroke-width="1.5"/><path d="M9.5 5.5h5"/>'),
    'mi-event-tasks': chip('<path d="M13 5l-6 8h4l-1 6 6-8h-4z" stroke-linejoin="round"/>'),
    'mi-terminal-settings': chip('<rect x="5" y="8" width="14" height="9" rx="1.5"/><path d="M8 11.2h.01M11 11.2h.01M14 11.2h.01M8 14h6" stroke-width="1.5"/>'),
    'mi-instance-settings': chip('<path d="M8.5 15.5L15 9a2 2 0 012.8 2.8L11.3 18l-3.3.6z"/>'),
    'mi-minecraft-players-query': chip('<circle cx="9" cy="10" r="2.2"/><circle cx="16" cy="10" r="2.2"/><path d="M5 18c0-2.2 1.8-4 4-4s4 1.8 4 4M13 18c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke-width="1.5"/>'),
    default: chip('<circle cx="12" cy="12" r="1.6" fill="#4ade80" stroke="none"/>')
  };

  // Clicks the actual native "Go" link inside one of MCSManager's own
  // "Manage Instance" cards, found by its exact title text. Reusing the
  // real card's own click target (rather than guessing a hash route or
  // whether something is a route vs. a modal) means the sidebar entry keeps
  // working even for entries that open an admin-gated modal (Instance
  // Settings) rather than navigating.
  function clickNativeCard(title) {
    var textEl = findExactText(title);
    if (!textEl) return false;
    var card = textEl.closest('.inner-card-wrapper');
    if (!card) return false;
    var link = card.querySelector('a[href="javascript:void(0);"]') || card.querySelector('a');
    (link || card).click();
    return true;
  }

  // Mirrors MCSManager's own "Manage Instance" card grid one-for-one so the
  // sidebar can fully replace it as a navigation surface.
  var MANAGE_INSTANCE_TITLES = [
    'Configuration Files',
    'File Management',
    'Java Manager',
    'Scheduled Tasks',
    'Event Tasks',
    'Terminal Settings',
    'Instance Settings',
    'Minecraft Players Query'
  ];

  var SIDEBAR_ITEMS = [
    {
      group: 'YOUR SERVER', key: 'console', label: 'Console',
      match: /^#\/instances\/terminal(\?|$)/,
      go: function (q) { window.location.hash = '/instances/terminal' + q; }
    },
    {
      group: 'YOUR SERVER', key: 'files', label: 'Files',
      match: /^#\/instances\/terminal\/files/,
      go: function (q) { window.location.hash = '/instances/terminal/files' + q; }
    },
    {
      group: 'YOUR SERVER', key: 'plugins', label: 'Plugins',
      match: null,
      go: function () { openModBrowser('plugin'); }
    },
    {
      // The native "Manage Instance" grid (now hidden — see theme.css) held
      // both of these; Plugins above covers "Plugin Manager", this one
      // covers "Modpack Installer" so that feature stays reachable.
      group: 'YOUR SERVER', key: 'modpacks', label: 'Modpacks',
      match: null,
      go: function () { openModBrowser('modpack'); }
    },
    {
      group: 'YOUR SERVER', key: 'backups', label: 'Backups',
      match: null,
      go: function () { showBackupModal(); }
    },
    {
      group: 'CONFIG', key: 'network', label: 'Network',
      match: null,
      go: function () { showNetworkModal(); }
    },
    {
      group: 'CONFIG', key: 'settings', label: 'Settings',
      match: /^#\/instances\/terminal\/serverConfig/,
      go: function (q) { window.location.hash = '/instances/terminal/serverConfig' + q; }
    }
  ];

  MANAGE_INSTANCE_TITLES.forEach(function (title) {
    SIDEBAR_ITEMS.push({
      group: 'MANAGE INSTANCE',
      key: 'mi-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      label: title,
      match: null,
      go: function () { clickNativeCard(title); }
    });
  });

  function currentHashQuery() {
    var hash = window.location.hash || '';
    var i = hash.indexOf('?');
    return i === -1 ? '' : hash.slice(i);
  }

  function renderSidebar() {
    var uuid = getInstanceUuid();
    var existing = document.querySelector('.omen-sidebar');

    if (!uuid) {
      if (existing) existing.remove();
      document.body.classList.remove('omen-has-sidebar');
      return;
    }
    document.body.classList.add('omen-has-sidebar');

    var hash = window.location.hash || '';
    var q = currentHashQuery();

    if (!existing) {
      existing = el('div', 'omen-sidebar');
      document.body.appendChild(existing);
      existing.addEventListener('click', function (e) {
        var itemEl = e.target.closest('[data-sidebar-key]');
        if (!itemEl) return;
        var key = itemEl.getAttribute('data-sidebar-key');
        for (var i = 0; i < SIDEBAR_ITEMS.length; i++) {
          if (SIDEBAR_ITEMS[i].key === key) { SIDEBAR_ITEMS[i].go(currentHashQuery()); break; }
        }
      });
    }

    var groups = [];
    var byGroup = {};
    for (var g = 0; g < SIDEBAR_ITEMS.length; g++) {
      var item = SIDEBAR_ITEMS[g];
      if (!byGroup[item.group]) { byGroup[item.group] = []; groups.push(item.group); }
      byGroup[item.group].push(item);
    }

    var html = '<div class="omen-sidebar__brand">OmenHosting</div>';
    for (var gi = 0; gi < groups.length; gi++) {
      var groupName = groups[gi];
      html += '<div class="omen-sidebar__group">' + groupName + '</div>';
      byGroup[groupName].forEach(function (it) {
        var active = it.match && it.match.test(hash);
        html += '<div class="omen-sidebar__item' + (active ? ' is-active' : '') + '" data-sidebar-key="' + it.key + '">' +
          '<span class="omen-sidebar__icon">' + (SIDEBAR_ICONS[it.key] || SIDEBAR_ICONS.default) + '</span>' +
          '<span>' + it.label + '</span>' +
        '</div>';
      });
    }

    if (existing.dataset.q !== q + hash.split('?')[0]) {
      existing.dataset.q = q + hash.split('?')[0];
      existing.innerHTML = html;
    }
  }

  // ─── Network settings modal (Minekube subdomain) ──────────────
  function showNetworkModal() {
    if (document.querySelector('.omen-network-modal')) return;
    var uuid = getInstanceUuid();
    if (!uuid) return;

    var modal = buildModal('omen-network-modal',
      '<h2 class="omen-modal__title">Network</h2>' +
      '<p class="omen-modal__sub">Choose the subdomain players use to connect.</p>' +
      '<div class="omen-field"><label>Subdomain</label>' +
        '<input id="omen-network-name" type="text" maxlength="16" placeholder="my-server" autocomplete="off"></div>' +
      '<p class="omen-modal__sub" id="omen-network-preview" style="margin-top:-10px;text-align:left"></p>' +
      '<div class="omen-msg omen-msg--err" id="omen-network-error" style="display:none"></div>' +
      '<div class="omen-msg omen-msg--ok" id="omen-network-success" style="display:none"></div>' +
      '<div class="omen-modal__actions">' +
        '<button class="omen-btn omen-btn--ghost" id="omen-network-cancel" type="button">Cancel</button>' +
        '<button class="omen-btn" id="omen-network-save" type="button">Save</button>' +
      '</div>');

    var input = modal.querySelector('#omen-network-name');
    var preview = modal.querySelector('#omen-network-preview');
    var errEl = modal.querySelector('#omen-network-error');
    var okEl = modal.querySelector('#omen-network-success');
    var save = modal.querySelector('#omen-network-save');

    function updatePreview() {
      var v = input.value.trim();
      preview.textContent = v ? v + '.play.minekube.net' : '';
    }
    input.addEventListener('input', updatePreview);

    modal.querySelector('#omen-network-cancel').onclick = function () { modal.remove(); };

    getJSON('/api/omen/network/endpoint?uuid=' + encodeURIComponent(uuid)).then(function (data) {
      if (data && data.endpoint) { input.value = data.endpoint; updatePreview(); }
      input.focus();
    });

    save.onclick = function () {
      var name = input.value.trim();
      errEl.style.display = 'none';
      okEl.style.display = 'none';
      save.disabled = true;
      save.textContent = 'Saving…';

      fetch('/api/omen/network/endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: uuid, name: name })
      })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
        .then(function (res) {
          save.disabled = false;
          save.textContent = 'Save';
          if (res.ok) {
            okEl.textContent = 'Saved — takes effect the next time the server restarts.';
            okEl.style.display = 'block';
          } else {
            errEl.textContent = (res.data && res.data.error) || 'Failed to save';
            errEl.style.display = 'block';
          }
        })
        .catch(function () {
          save.disabled = false;
          save.textContent = 'Save';
          errEl.textContent = 'Connection error';
          errEl.style.display = 'block';
        });
    };
  }

  // ─── Backups modal ─────────────────────────────────────────────
  function showBackupModal() {
    if (document.querySelector('.omen-backups-modal')) return;
    var uuid = getInstanceUuid();
    if (!uuid) return;

    var modal = buildModal('omen-backups-modal',
      '<h2 class="omen-modal__title">Backups</h2>' +
      '<p class="omen-modal__sub">Cloud backups of this server\'s world and configs.</p>' +
      '<div id="omen-backups-status" style="margin-bottom:14px"></div>' +
      '<button class="omen-btn" id="omen-backups-run" type="button" style="width:100%;margin-bottom:16px">Backup Now</button>' +
      '<div class="omen-mod-heading">History</div>' +
      '<div class="omen-mod-results" id="omen-backups-history"><div class="omen-mod-empty">Loading…</div></div>' +
      '<div class="omen-modal__actions">' +
        '<button class="omen-btn omen-btn--ghost" id="omen-backups-close" type="button">Close</button>' +
      '</div>');

    modal.querySelector('.omen-modal__card').classList.add('omen-modal__card--wide');
    modal.querySelector('#omen-backups-close').onclick = function () { modal.remove(); };

    modal.querySelector('#omen-backups-run').onclick = function () {
      var btn = this;
      btn.disabled = true;
      btn.textContent = 'Starting…';
      fetch('/api/omen/backup/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: uuid })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.error) { btn.disabled = false; btn.textContent = 'Backup Now'; return; }
          setTimeout(function () {
            if (!btn.isConnected) return;
            btn.disabled = false;
            btn.textContent = 'Backup Now';
            loadBackupStatus(uuid);
            loadBackupHistory(uuid);
          }, 1500);
        })
        .catch(function () { btn.disabled = false; btn.textContent = 'Backup Now'; });
    };

    loadBackupStatus(uuid);
    loadBackupHistory(uuid);
  }

  function loadBackupStatus(uuid) {
    var box = document.getElementById('omen-backups-status');
    if (!box) return;
    getJSON('/api/omen/backup/status').then(function (data) {
      if (!box.isConnected) return;
      if (!data || !data.enabled) {
        box.innerHTML = '<div class="omen-msg omen-msg--err" style="margin:0">Cloud backups are not configured for this server.</div>';
        return;
      }
      var st = (data.states && data.states[uuid]) || { state: 'idle' };
      box.innerHTML = '<div class="omen-mod-sub">Status: ' + escapeHtml(st.state || 'idle') + '</div>';
    });
  }

  function loadBackupHistory(uuid) {
    var box = document.getElementById('omen-backups-history');
    if (!box) return;
    getJSON('/api/omen/backup/history?uuid=' + encodeURIComponent(uuid) + '&limit=10').then(function (data) {
      if (!box.isConnected) return;
      if (!data || !data.enabled) {
        box.innerHTML = '<div class="omen-mod-empty">Cloud backups are not configured.</div>';
        return;
      }
      var records = data.records || [];
      if (!records.length) {
        box.innerHTML = '<div class="omen-mod-empty">No backups yet.</div>';
        return;
      }
      box.innerHTML = records.map(function (r) {
        var when = new Date(r.ts).toLocaleString();
        var kind = r.type === 'restore' ? 'Restore' : 'Backup';
        var ok = r.success !== false;
        return '<div class="omen-mod-row">' +
          '<div class="omen-mod-meta">' +
            '<div class="omen-mod-name">' + kind + (ok ? '' : ' — failed') + '</div>' +
            '<div class="omen-mod-sub">' + escapeHtml(when) + (r.sizeBytes ? ' · ' + formatBytes(r.sizeBytes) : '') + '</div>' +
          '</div>' +
        '</div>';
      }).join('');
    });
  }

  // ─── Limbo countdown banner ────────────────────────────────────
  // Shown above the console when the running server is empty and counting
  // down toward auto-sleep, mirroring the reference product's "about to
  // enter limbo" warning with a live countdown and a way to postpone it.
  function formatCountdown(sec) {
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m > 0 ? (m + 'm ' + s + 's') : (s + 's');
  }

  function renderLimboBanner() {
    var uuid = getInstanceUuid();
    var consoleArea = document.querySelector('.terminal-wrapper, .console-wrapper, [class*="terminal"]');
    var existing = document.querySelector('.omen-limbo-banner');

    if (!uuid || !consoleArea) {
      if (existing) existing.remove();
      return;
    }

    getJSON('/api/omen/autosleep/' + uuid).then(function (data) {
      var banner = document.querySelector('.omen-limbo-banner');
      if (!data || data.secondsUntilSleep === null || data.secondsUntilSleep === undefined) {
        if (banner) banner.remove();
        return;
      }

      var area = document.querySelector('.terminal-wrapper, .console-wrapper, [class*="terminal"]');
      if (!area) { if (banner) banner.remove(); return; }

      if (!banner) {
        banner = el('div', 'omen-limbo-banner',
          '<span class="omen-limbo-banner__text">Your server is about to enter limbo in ' +
            '<b id="omen-limbo-countdown">--</b></span>' +
          '<button class="omen-btn omen-btn--ghost" id="omen-limbo-pause" type="button">Pause now</button>');
        area.parentNode.insertBefore(banner, area);
        banner.querySelector('#omen-limbo-pause').addEventListener('click', function () {
          var btn = this;
          btn.disabled = true;
          btn.textContent = 'Pausing…';
          fetch('/api/omen/autosleep/pause', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uuid: getInstanceUuid() })
          }).then(function () { banner.remove(); })
            .catch(function () { btn.disabled = false; btn.textContent = 'Pause now'; });
        });
      }

      var cd = document.getElementById('omen-limbo-countdown');
      if (cd) cd.textContent = formatCountdown(data.secondsUntilSleep);
    });
  }

  var limboBannerTimer = null;

  // ─── Queue ────────────────────────────────────────────────────
  var queueUserUuid = '';
  var queuePollTimer = null;
  var queueHandled = false;

  function stopQueuePoll() {
    if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
  }

  // Original artwork (not a copy of any reference illustration) — simple
  // blob-monster characters, location pins, and an orbit ring around a
  // moon, evoking "searching for a lost server."
  var LIMBO_ILLUSTRATION =
    '<svg width="168" height="118" viewBox="0 0 168 118" xmlns="http://www.w3.org/2000/svg">' +
      '<circle cx="84" cy="50" r="40" fill="#e6e7eb"/>' +
      '<circle cx="27" cy="17" r="1.5" fill="#cfd1d6"/>' +
      '<circle cx="144" cy="25" r="1.5" fill="#cfd1d6"/>' +
      '<circle cx="131" cy="64" r="1.5" fill="#cfd1d6"/>' +
      '<path d="M23 43h5M25.5 40.5v5" stroke="#cfd1d6" stroke-width="1.3" stroke-linecap="round"/>' +
      '<ellipse cx="84" cy="53" rx="54" ry="16" fill="none" stroke="#262b3a" stroke-width="1.2" transform="rotate(-8 84 53)"/>' +
      '<g transform="translate(102,20)"><path d="M0-12c6 0 9 4.5 9 9s-4 9-9 15c-5-6-9-10.5-9-15s3-9 9-9z" fill="#2f6fed"/><circle cy="-3" r="3.2" fill="#fff"/></g>' +
      '<g transform="translate(65,26) scale(.75)"><path d="M0-12c6 0 9 4.5 9 9s-4 9-9 15c-5-6-9-10.5-9-15s3-9 9-9z" fill="#1f2437"/><circle cy="-3" r="3.2" fill="#fff"/></g>' +
      '<g transform="translate(123,40) scale(.7)"><path d="M0-12c6 0 9 4.5 9 9s-4 9-9 15c-5-6-9-10.5-9-15s3-9 9-9z" fill="#c9ccd3"/><circle cy="-3" r="3.2" fill="#fff"/></g>' +
      '<g transform="translate(39,60) scale(.7)"><path d="M0-12c6 0 9 4.5 9 9s-4 9-9 15c-5-6-9-10.5-9-15s3-9 9-9z" fill="#2f6fed"/><circle cy="-3" r="3.2" fill="#fff"/></g>' +
      '<g transform="translate(45,94)">' +
        '<ellipse cy="6" rx="13" ry="14" fill="#20242f"/>' +
        '<path d="M-13-2a13 10 0 0 1 26 0z" fill="#2f6fed"/>' +
        '<circle cx="-3" cy="4" r="4.2" fill="#fff"/><circle cx="-3" cy="4" r="1.8" fill="#20242f"/>' +
        '<line x1="10" y1="0" x2="18" y2="-14" stroke="#20242f" stroke-width="2.4" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="translate(125,94)">' +
        '<ellipse cy="6" rx="13" ry="14" fill="#20242f"/>' +
        '<path d="M-13-2a13 10 0 0 1 26 0z" fill="#2f6fed"/>' +
        '<circle cx="3" cy="4" r="4.2" fill="#fff"/><circle cx="3" cy="4" r="1.8" fill="#20242f"/>' +
        '<circle cx="17" cy="-6" r="6" fill="none" stroke="#20242f" stroke-width="2.2"/>' +
        '<line x1="21.5" y1="-1.5" x2="27" y2="4" stroke="#20242f" stroke-width="2.2" stroke-linecap="round"/>' +
      '</g>' +
      '<g transform="translate(87,102)"><ellipse cy="5" rx="10" ry="11" fill="#2f2f3a"/><ellipse cy="-4" rx="7" ry="6" fill="#2f6fed"/></g>' +
    '</svg>';

  var WAKE_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  var limboModalEl = null;
  var limboRestorePollTimer = null;

  function limboBody(state, data) {
    data = data || {};
    var title = state === 'restoring' ? 'Restoring Server' : 'Server in Limbo';
    var sub = state === 'restoring'
      ? 'Hang tight — your server is starting back up.'
      : state === 'queued'
        ? 'This server is in the cold, dark void — click below to bring it back to life.'
        : 'This server is in limbo to save resources — wake it below to bring it back online.';

    var html = '<div class="omen-limbo__art">' + LIMBO_ILLUSTRATION + '</div>' +
      '<h2 class="omen-limbo__title">' + title + '</h2>' +
      '<p class="omen-limbo__sub">' + sub + '</p>';

    if (state === 'idle') {
      html += '<button class="omen-limbo__btn" id="omen-queue-join-btn" type="button">' + WAKE_ICON + '<span>Wake server</span></button>' +
        '<p class="omen-limbo__caption">Takes about a minute. We’ll bring back the latest save.</p>';
    } else if (state === 'queued') {
      html += '<p class="omen-limbo__queue-line">You are in the queue (' +
          (data.position != null ? data.position : '—') + '/' + (data.queueLength != null ? data.queueLength : '—') +
        ')</p>' +
        '<button class="omen-limbo__btn omen-limbo__btn--leave" id="omen-queue-leave" type="button">Leave Queue</button>';
    } else if (state === 'restoring') {
      html += '<p class="omen-limbo__status">Waking your server…</p>' +
        '<div class="omen-limbo__bar"><div class="omen-limbo__bar-fill"></div></div>';
    }

    html += '<div class="omen-limbo__footer">© ' + new Date().getFullYear() +
      ' OmenHosting<br>You’re currently connected to the OmenHosting panel</div>';
    return html;
  }

  function bindLimboHandlers() {
    if (!limboModalEl) return;
    var joinBtn = limboModalEl.querySelector('#omen-queue-join-btn');
    if (joinBtn) joinBtn.addEventListener('click', onWakeServerClick);
    var leaveBtn = limboModalEl.querySelector('#omen-queue-leave');
    if (leaveBtn) leaveBtn.addEventListener('click', onLeaveQueueClick);
  }

  function setLimboState(state, data) {
    if (!limboModalEl) return;
    var card = limboModalEl.querySelector('.omen-modal__card');
    card.innerHTML = limboBody(state, data);
    bindLimboHandlers();
    if (state === 'restoring') startRestorePoll();
  }

  function onWakeServerClick() {
    var btn = this;
    btn.disabled = true;
    fetch('/api/omen/queue/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: queueUserUuid })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        queueHandled = true;
        if (data.position === 0) {
          setLimboState('restoring');
        } else {
          setLimboState('queued', data);
          startQueuePoll();
        }
      })
      .catch(function () { btn.disabled = false; });
  }

  function onLeaveQueueClick() {
    fetch('/api/omen/queue/leave', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: queueUserUuid })
    }).catch(function () {});
    stopQueuePoll();
    if (limboModalEl) { limboModalEl.remove(); limboModalEl = null; }
  }

  function startQueuePoll() {
    stopQueuePoll();
    queuePollTimer = setInterval(function () {
      if (document.hidden || !limboModalEl) return;
      getJSON('/api/omen/queue/position?uuid=' + queueUserUuid).then(function (data) {
        if (!data || !limboModalEl) return;
        if (data.position === 0 || data.position === null) {
          stopQueuePoll();
          setLimboState('restoring');
        } else {
          setLimboState('queued', data);
        }
      });
    }, 3000);
  }

  /**
   * The "Restoring Server" screen polls for the console's own status tag to
   * actually say Running rather than guessing a fixed delay — a slow boot
   * (first-time jar download, big world restore) shouldn't cut the screen
   * away early, and a fast one shouldn't leave it hanging. Capped at ~80s so
   * a tag-detection miss can't strand the screen forever.
   */
  function startRestorePoll() {
    if (limboRestorePollTimer) return;
    var attempts = 0;
    limboRestorePollTimer = setInterval(function () {
      attempts++;
      var tags = document.querySelectorAll('.ant-tag');
      var running = false;
      for (var i = 0; i < tags.length; i++) {
        if (tags[i].textContent.trim().toLowerCase() === 'running') { running = true; break; }
      }
      if (running || attempts > 40) {
        clearInterval(limboRestorePollTimer);
        limboRestorePollTimer = null;
        if (limboModalEl) { limboModalEl.remove(); limboModalEl = null; }
      }
    }, 2000);
  }

  function showQueueModal() {
    if (limboModalEl || !queueUserUuid) return;
    limboModalEl = el('div', 'omen-modal omen-limbo-modal',
      '<div class="omen-modal__card omen-limbo__card">' + limboBody('idle') + '</div>');
    document.body.appendChild(limboModalEl);
    bindLimboHandlers();
  }

  function checkQueueStatus() {
    var uuid = getInstanceUuid();
    if (!uuid || queueHandled) return;
    if (limboModalEl) return;

    var tags = document.querySelectorAll('.ant-tag');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].textContent.trim().toLowerCase() === 'running') {
        queueHandled = false;
        return;
      }
    }

    queueUserUuid = uuid;
    showQueueModal();
  }

  window.addEventListener('beforeunload', function () {
    if (queueUserUuid) {
      navigator.sendBeacon('/api/omen/queue/leave', JSON.stringify({ uuid: queueUserUuid }));
    }
  });

  // ─── Modpack Installer & Plugin Manager ───────────────────────
  // Two extra entries in the panel's "Manage Instance" list. The cards are
  // cloned from an existing entry so they inherit the panel's exact markup and
  // styling rather than guessing at its classes.

  var MOD_CARDS = [
    {
      key: 'modpack',
      title: 'Modpack Installer',
      open: function () { openModBrowser('modpack'); }
    },
    {
      key: 'plugins',
      title: 'Plugin Manager',
      open: function () { openModBrowser('plugin'); }
    }
  ];

  function addManageInstanceCards() {
    var list = document.querySelector('.function-btns-container');
    if (!list) return;

    // Anything with a "Go" affordance is a usable template.
    var template = null;
    var children = list.children;
    for (var i = 0; i < children.length; i++) {
      if (!children[i].hasAttribute('data-omen-card')) { template = children[i]; break; }
    }
    if (!template) return;

    for (var c = 0; c < MOD_CARDS.length; c++) {
      (function (spec) {
        if (list.querySelector('[data-omen-card="' + spec.key + '"]')) return;

        var card = template.cloneNode(true);
        card.setAttribute('data-omen-card', spec.key);

        // The title is the deepest element holding the template's own label;
        // rewriting only that leaves the "Go" row and icon untouched.
        var titleNode = deepestTextNode(card, template.getAttribute('data-omen-title') || null);
        if (titleNode) titleNode.textContent = spec.title;

        // Vue attached its handler to the original node, so strip anchors that
        // would navigate and own the click ourselves.
        card.querySelectorAll('a[href]').forEach(function (a) {
          a.removeAttribute('href');
          a.style.cursor = 'pointer';
        });
        card.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          spec.open();
        }, true);

        list.appendChild(card);
      })(MOD_CARDS[c]);
    }
  }

  /**
   * MCSManager's own "Mod & Plugin Manager" card duplicates our injected mod
   * browser (one of MOD_CARDS above) and isn't wired to anything host-scoped
   * the way ours is, so it's removed outright rather than left as a second,
   * confusing entry point.
   */
  function removeModManagerCard() {
    var list = document.querySelector('.function-btns-container');
    if (!list) return;
    var textEl = findExactText('Mod & Plugin Manager');
    if (!textEl) return;
    var node = textEl;
    while (node && node.parentNode !== list) node = node.parentNode;
    if (node && node.parentNode === list) node.remove();
  }

  // ─── Instances list: avatar circle per row ────────────────────
  // A real inline SVG (chip(), same as every other icon in this panel)
  // inserted as each card's actual first child, rather than a CSS ::before
  // with a raw emoji character — see the comment on .omen-instance-avatar
  // in theme.css for why.
  var INSTANCE_AVATAR = chip('<rect x="6" y="6" width="12" height="3.2" rx="1"/><rect x="6" y="10.4" width="12" height="3.2" rx="1"/><rect x="6" y="14.8" width="12" height="3.2" rx="1"/><circle cx="8.2" cy="7.6" r=".6" fill="#fff" stroke="none"/><circle cx="8.2" cy="12" r=".6" fill="#fff" stroke="none"/><circle cx="8.2" cy="16.4" r=".6" fill="#fff" stroke="none"/>');

  function addInstanceListAvatars() {
    var cards = document.querySelectorAll('.instance-card:not([data-omen-avatar])');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      card.setAttribute('data-omen-avatar', '1');
      var avatar = el('div', 'omen-instance-avatar', INSTANCE_AVATAR);
      card.insertBefore(avatar, card.firstChild);
    }
  }

  /**
   * Find the element most likely to be the card's title: the deepest node that
   * still carries a short, non-"Go" text label.
   */
  function deepestTextNode(root) {
    var best = null;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
    var node = walker.currentNode;
    while (node) {
      var text = (node.textContent || '').trim();
      if (text && text.length < 60 && !/^go$/i.test(text) && node.children.length === 0) {
        if (!best) best = node;
      }
      node = walker.nextNode();
    }
    return best;
  }

  // ─── Browser modal ────────────────────────────────────────────

  var modState = { type: 'plugin', results: [], busy: false };

  function openModBrowser(type) {
    if (document.querySelector('.omen-mod-modal')) return;
    modState.type = type;

    var isPack = type === 'modpack';
    var modal = buildModal('omen-mod-modal',
      '<h2 class="omen-modal__title">' + (isPack ? 'Modpack Installer' : 'Plugin Manager') + '</h2>' +
      '<p class="omen-modal__sub">' +
        (isPack
          ? 'Install a modpack from Modrinth. The server must be stopped.'
          : 'Search Modrinth and install plugins into this server.') +
      '</p>' +
      '<div class="omen-field">' +
        '<input id="omen-mod-search" type="text" placeholder="' +
        (isPack ? 'Search modpacks…' : 'Search plugins…') + '">' +
      '</div>' +
      '<div class="omen-mod-results" id="omen-mod-results"></div>' +
      (isPack ? '' : '<div class="omen-mod-installed" id="omen-mod-installed"></div>') +
      '<div class="omen-msg omen-msg--err" id="omen-mod-error" style="display:none"></div>' +
      '<div class="omen-modal__actions">' +
        '<button class="omen-btn omen-btn--ghost" id="omen-mod-close" type="button">Close</button>' +
      '</div>');

    modal.querySelector('.omen-modal__card').classList.add('omen-modal__card--wide');
    modal.querySelector('#omen-mod-close').onclick = function () { modal.remove(); };

    var input = modal.querySelector('#omen-mod-search');
    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { runModSearch(input.value); }, 350);
    });

    runModSearch('');
    if (!isPack) refreshInstalled();
    input.focus();
  }

  function modError(message) {
    var el = document.getElementById('omen-mod-error');
    if (!el) return;
    if (!message) { el.style.display = 'none'; return; }
    el.textContent = message;
    el.style.display = 'block';
  }

  function runModSearch(query) {
    var box = document.getElementById('omen-mod-results');
    if (!box) return;
    box.innerHTML = '<div class="omen-mod-empty">Searching…</div>';
    modError('');

    getJSON('/api/omen/mods/search?type=' + encodeURIComponent(modState.type) +
            '&q=' + encodeURIComponent(query || '') + '&limit=20')
      .then(function (data) {
        if (!data || data.error) {
          box.innerHTML = '';
          return modError((data && data.error) || 'Search failed');
        }
        modState.results = data.results || [];
        if (!modState.results.length) {
          box.innerHTML = '<div class="omen-mod-empty">No results.</div>';
          return;
        }
        box.innerHTML = modState.results.map(function (r, i) {
          return '<div class="omen-mod-row">' +
            (r.icon ? '<img class="omen-mod-icon" src="' + escapeHtml(r.icon) + '" alt="">'
                    : '<div class="omen-mod-icon"></div>') +
            '<div class="omen-mod-meta">' +
              '<div class="omen-mod-name">' + escapeHtml(r.title) + '</div>' +
              '<div class="omen-mod-desc">' + escapeHtml(r.description || '') + '</div>' +
              '<div class="omen-mod-sub">' + formatCount(r.downloads) + ' downloads' +
                (r.author ? ' · ' + escapeHtml(r.author) : '') + '</div>' +
            '</div>' +
            '<button class="omen-btn omen-mod-install" data-index="' + i + '" type="button">Install</button>' +
          '</div>';
        }).join('');

        box.querySelectorAll('.omen-mod-install').forEach(function (btn) {
          btn.addEventListener('click', function () {
            installProject(modState.results[Number(btn.getAttribute('data-index'))], btn);
          });
        });
      });
  }

  function installProject(project, btn) {
    if (!project || modState.busy) return;
    var uuid = getInstanceUuid();
    if (!uuid) return modError('Open a server first — no instance is selected.');

    modState.busy = true;
    btn.disabled = true;
    btn.textContent = 'Checking…';
    modError('');

    getJSON('/api/omen/mods/versions?projectId=' + encodeURIComponent(project.id))
      .then(function (data) {
        var list = (data && data.versions) || [];
        if (!list.length) throw new Error('No installable versions for this project');
        btn.textContent = 'Installing…';
        return fetch('/api/omen/mods/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid: uuid, versionId: list[0].id, type: modState.type })
        }).then(function (r) { return r.json(); });
      })
      .then(function (result) {
        if (!result || result.error) throw new Error((result && result.error) || 'Install failed');
        btn.textContent = 'Installed';
        btn.classList.add('omen-btn--ok');
        if (modState.type !== 'modpack') refreshInstalled();
      })
      .catch(function (err) {
        modError(err.message);
        btn.disabled = false;
        btn.textContent = 'Install';
      })
      .then(function () { modState.busy = false; });
  }

  function refreshInstalled() {
    var box = document.getElementById('omen-mod-installed');
    var uuid = getInstanceUuid();
    if (!box || !uuid) return;

    getJSON('/api/omen/mods/installed?uuid=' + encodeURIComponent(uuid)).then(function (data) {
      var items = (data && data.plugins) || [];
      if (!items.length) {
        box.innerHTML = '<div class="omen-mod-heading">Installed</div>' +
          '<div class="omen-mod-empty">No plugins installed yet.</div>';
        return;
      }
      box.innerHTML = '<div class="omen-mod-heading">Installed (' + items.length + ')</div>' +
        items.map(function (p) {
          return '<div class="omen-mod-row omen-mod-row--installed">' +
            '<div class="omen-mod-meta">' +
              '<div class="omen-mod-name">' + escapeHtml(p.name) + '</div>' +
              '<div class="omen-mod-sub">' + formatBytes(p.size) +
                (p.disabled ? ' · disabled' : '') + '</div>' +
            '</div>' +
            '<button class="omen-btn omen-btn--ghost omen-mod-toggle" data-file="' + escapeHtml(p.name) + '" type="button">' +
              (p.disabled ? 'Enable' : 'Disable') + '</button>' +
            '<button class="omen-btn omen-btn--danger omen-mod-remove" data-file="' + escapeHtml(p.name) + '" type="button">Remove</button>' +
          '</div>';
        }).join('');

      box.querySelectorAll('.omen-mod-toggle').forEach(function (b) {
        b.addEventListener('click', function () { modAction('/api/omen/mods/toggle', b.getAttribute('data-file'), b); });
      });
      box.querySelectorAll('.omen-mod-remove').forEach(function (b) {
        b.addEventListener('click', function () { modAction('/api/omen/mods/remove', b.getAttribute('data-file'), b); });
      });
    });
  }

  function modAction(endpoint, filename, btn) {
    btn.disabled = true;
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: getInstanceUuid(), folder: 'plugins', filename: filename })
    })
      .then(function (r) { return r.json(); })
      .then(function (result) {
        if (result && result.error) modError(result.error);
        refreshInstalled();
      })
      .catch(function () { btn.disabled = false; });
  }

  function formatCount(n) {
    if (!n) return '0';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }

  function formatBytes(b) {
    if (!b) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
    return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + units[i];
  }

  // ─── Resource usage (CPU / RAM / storage) ─────────────────────
  // Appended right after the panel's own "Basic Infomation" card. The daemon
  // only exposes this over a live terminal session, so it's polled from our
  // own endpoint instead and rendered as a sibling card — never as a child of
  // that card, since it auto-refreshes and would wipe an injected node.

  var resourceStats = null;   // { uuid, running, cpuPercent, memoryBytes, memoryPercent, systemMemoryBytes, diskBytes }
  var resourcePollTimer = null;

  function fetchResourceStats() {
    if (document.hidden) return;
    var uuid = getInstanceUuid();
    if (!uuid) { resourceStats = null; return; }
    getJSON('/api/omen/instance-stats?uuid=' + encodeURIComponent(uuid)).then(function (data) {
      if (!data || data.error) return;
      resourceStats = Object.assign({ uuid: uuid }, data);
      renderResourceUsage();
    });
  }

  function setResourcePoll() {
    if (resourcePollTimer) return;
    resourcePollTimer = setInterval(fetchResourceStats, 5000);
  }

  function findExactText(text) {
    var all = document.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && all[i].textContent.trim() === text) return all[i];
    }
    return null;
  }

  // Same tinted-circle-plus-green-glyph chip as the sidebar — see chip()'s
  // comment for why this replaced a different-hue-per-icon scheme.
  var RESOURCE_ICONS = {
    uptime: chip('<circle cx="12" cy="12.5" r="6"/><path d="M12 9v3.5l2.5 1.5" stroke-width="1.5"/>'),
    cpu: chip('<rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="4" height="4"/><path d="M9 4v2M15 4v2M9 18v2M15 18v2M4 9h2M4 15h2M18 9h2M18 15h2" stroke-width="1.4"/>'),
    ram: chip('<rect x="4" y="9" width="16" height="7" rx="1"/><path d="M7 9V6.5M11 9V6.5M15 9V6.5M7 16v2.5M11 16v2.5M15 16v2.5" stroke-width="1.4"/>'),
    storage: chip('<ellipse cx="12" cy="7" rx="7" ry="2.6"/><path d="M5 7v10c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6V7M5 12c0 1.4 3.1 2.6 7 2.6s7-1.2 7-2.6" stroke-width="1.4"/>')
  };

  /**
   * @param {string} icon RESOURCE_ICONS key
   * @param {string} label
   * @param {string} value  Big headline value (percentage, or "Offline").
   * @param {number|null} pct  0-100 bar fill, or null to omit the bar.
   * @param {boolean} offline
   * @param {string} [sub]  Small caption under the value, e.g. "1.2% of 5 GB used".
   */
  function resourceRow(icon, label, value, pct, offline, sub) {
    return '<div class="omen-resource-row' + (offline ? ' omen-resource-row--offline' : '') + '">' +
      '<div class="omen-resource-row__head">' +
        '<span class="omen-resource-row__icon">' + RESOURCE_ICONS[icon] + '</span>' +
        '<span class="omen-resource-row__label">' + label + '</span>' +
      '</div>' +
      '<span class="omen-resource-row__value">' + escapeHtml(value) + '</span>' +
      (pct !== null
        ? '<div class="omen-resource-row__bar"><div class="omen-resource-row__fill" style="width:' + pct + '%"></div></div>'
        : '') +
      (sub ? '<span class="omen-resource-row__sub">' + escapeHtml(sub) + '</span>' : '') +
    '</div>';
  }

  function renderResourceUsage() {
    var uuid = getInstanceUuid();
    var existing = document.querySelector('.omen-resource-box');

    if (!uuid) {
      if (existing) existing.remove();
      return;
    }

    // Sits beside the console itself rather than below the "Basic Infomation"
    // card: found via the console/terminal element's own ant-design grid
    // column, then inserted as a sibling column in the same row so the
    // panel's flex-wrap (already in place for its own responsive layout)
    // naturally drops it to a new line on narrow screens.
    var consoleArea = document.querySelector('.console-wrapper, .terminal-wrapper, [class*="terminal"]');
    var col = consoleArea && consoleArea.closest('.layout-card-col');
    var row = col && col.parentElement;
    if (!row) {
      // Not on the console page right now.
      if (existing) existing.remove();
      return;
    }

    var box = existing;
    if (!box || box.getAttribute('data-uuid') !== uuid || box.parentElement !== row) {
      if (existing) existing.remove();
      box = el('div', 'omen-resource-box');
      box.setAttribute('data-uuid', uuid);
      row.insertBefore(box, col.nextSibling);
    }

    if (!resourceStats || resourceStats.uuid !== uuid) {
      if (!box.dataset.sig) {
        box.innerHTML = '<div class="omen-resource-box__title">Resource Usage</div>' +
          '<div class="omen-resource-grid">' +
            resourceRow('uptime', 'Uptime', '—', null, true) +
            resourceRow('cpu', 'CPU Load', '—', null, true) +
            resourceRow('ram', 'Memory', '—', null, true) +
            resourceRow('storage', 'Disk', '—', null, true) +
          '</div>';
      }
      return;
    }

    var sig = JSON.stringify(resourceStats);
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;

    var running = resourceStats.running;
    var cpuPct = Math.max(0, Math.min(100, resourceStats.cpuPercent));
    var memPct = Math.max(0, Math.min(100, resourceStats.memoryPercent));

    var quotaBytes = resourceStats.quotaBytes || (5 * 1024 * 1024 * 1024);
    var diskPct = Math.max(0, Math.min(100, (resourceStats.diskBytes / quotaBytes) * 100));
    var diskSub = diskPct.toFixed(1) + '% of ' + formatBytes(quotaBytes) + ' used';

    box.innerHTML =
      '<div class="omen-resource-box__title">Resource Usage</div>' +
      '<div class="omen-resource-grid">' +
        resourceRow('uptime', 'Uptime', running ? formatUptime(resourceStats.uptimeSeconds) : 'Offline', null, !running) +
        resourceRow('cpu', 'CPU Load', running ? cpuPct.toFixed(1) + '%' : 'Offline', running ? cpuPct : null, !running) +
        resourceRow('ram', 'Memory', running ? formatBytes(resourceStats.memoryBytes) : 'Offline', running ? memPct : null, !running) +
        resourceRow('storage', 'Disk', formatBytes(resourceStats.diskBytes), diskPct, false, diskSub) +
      '</div>';
  }

  /** e.g. 3905 -> "1h 5m 5s"; falls back to "—" when the OS didn't report one. */
  function formatUptime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  // ─── The single debounced DOM pass ────────────────────────────
  var passScheduled = false;

  function runPass() {
    passScheduled = false;
    addIpBox();
    addStatusIndicator();
    addSignupLink();
    addCreateServerButton();
    checkQueueStatus();
    renderBackupBox();
    addManageInstanceCards();
    removeModManagerCard();
    addInstanceListAvatars();
    renderResourceUsage();
    renderSidebar();
    renderLimboBanner();
  }

  function schedulePass() {
    if (passScheduled) return;
    passScheduled = true;
    requestAnimationFrame(function () { IDLE(runPass); });
  }

  // Console output mutates the DOM constantly; nothing we render lives
  // inside the terminal, so those records are dropped before any work.
  function isTerminalOnly(records) {
    for (var i = 0; i < records.length; i++) {
      var t = records[i].target;
      if (!t || !t.closest) return false;
      if (!t.closest('.xterm, .terminal-wrapper, .console-wrapper, .cm-editor')) return false;
    }
    return true;
  }

  var observer = new MutationObserver(function (records) {
    if (isTerminalOnly(records)) return;
    schedulePass();
  });

  function boot() {
    observer.observe(document.body, { childList: true, subtree: true });

    fetchBackupStatus();
    fetchResourceStats();
    schedulePass();
    setTimeout(schedulePass, 1500);

    setBackupPoll(15000);
    setResourcePoll();
    if (!limboBannerTimer) limboBannerTimer = setInterval(renderLimboBanner, 5000);

    // Catch up immediately when the tab comes back into view.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        fetchBackupStatus();
        fetchResourceStats();
        schedulePass();
      }
    });

    window.addEventListener('hashchange', function () {
      var newUuid = getInstanceUuid();
      if (newUuid && newUuid !== queueUserUuid) queueHandled = false;
      fetchResourceStats();
      schedulePass();
    });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot, { once: true });
})();
