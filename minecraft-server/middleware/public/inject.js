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

  // ─── Queue ────────────────────────────────────────────────────
  var queueUserUuid = '';
  var queuePollTimer = null;
  var queueHandled = false;

  function stopQueuePoll() {
    if (queuePollTimer) { clearInterval(queuePollTimer); queuePollTimer = null; }
  }

  function startQueuePoll() {
    stopQueuePoll();
    queuePollTimer = setInterval(function () {
      if (document.hidden) return;
      getJSON('/api/omen/queue/position?uuid=' + queueUserUuid).then(function (data) {
        if (!data) return;
        var posEl = document.getElementById('omen-queue-position');
        var runEl = document.getElementById('omen-queue-running');
        if (posEl) posEl.textContent = data.position || '-';
        if (runEl) runEl.textContent = data.running + ' / ' + data.max + ' running';
        if (data.position === 0 || data.position === null) {
          var m = document.querySelector('.omen-queue-modal');
          if (m) m.remove();
          stopQueuePoll();
        }
      });
    }, 3000);
  }

  function showQueueModal() {
    if (document.querySelector('.omen-queue-modal') || !queueUserUuid) return;

    var modal = buildModal('omen-queue-modal',
      '<div class="omen-queue__icon" style="text-align:center">' +
        '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">' +
        '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="8" y1="2" x2="8" y2="6"/>' +
        '<line x1="16" y1="2" x2="16" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>' +
      '</div>' +
      '<h2 class="omen-modal__title">Server Queue</h2>' +
      '<p class="omen-modal__sub">Your server starts automatically when a slot opens up.</p>' +
      '<div id="omen-queue-position-box" style="display:none;text-align:center">' +
        '<div class="omen-queue__position">#<span id="omen-queue-position">-</span></div>' +
        '<p class="omen-modal__sub" style="margin:0 0 4px">Your position in queue</p>' +
        '<p class="omen-queue__meta" id="omen-queue-running">0 / 0 running</p>' +
      '</div>' +
      '<button class="omen-btn" id="omen-queue-join-btn" type="button" style="width:100%">Join Queue</button>' +
      '<p class="omen-queue__leave" id="omen-queue-leave" style="display:none;text-align:center">Leave queue</p>');

    var joinBtn = modal.querySelector('#omen-queue-join-btn');

    joinBtn.addEventListener('click', function () {
      joinBtn.disabled = true;
      joinBtn.textContent = 'Joining…';
      fetch('/api/omen/queue/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: queueUserUuid })
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          queueHandled = true;
          if (data.position === 0) {
            modal.remove();
            stopQueuePoll();
          } else {
            modal.querySelector('#omen-queue-position-box').style.display = 'block';
            modal.querySelector('#omen-queue-position').textContent = data.position;
            modal.querySelector('#omen-queue-running').textContent =
              data.running + ' / ' + data.max + ' running';
            joinBtn.style.display = 'none';
            modal.querySelector('#omen-queue-leave').style.display = 'block';
            startQueuePoll();
          }
        })
        .catch(function () { joinBtn.disabled = false; joinBtn.textContent = 'Join Queue'; });
    });

    modal.querySelector('#omen-queue-leave').addEventListener('click', function () {
      fetch('/api/omen/queue/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: queueUserUuid })
      }).catch(function () {});
      stopQueuePoll();
      modal.remove();
    });
  }

  function checkQueueStatus() {
    var uuid = getInstanceUuid();
    if (!uuid || queueHandled) return;
    if (document.querySelector('.omen-queue-modal')) return;

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

  var RESOURCE_ICONS = {
    cpu: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/></svg>',
    ram: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="7" width="18" height="10" rx="1"/><path d="M7 7V4M12 7V4M17 7V4M7 20v-3M12 20v-3M17 20v-3"/></svg>',
    storage: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/></svg>'
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

    var titleEl = findExactText('Basic Infomation');
    var card = titleEl && titleEl.closest('.card-panel');
    if (!card) {
      // Not on a page showing that card right now.
      if (existing) existing.remove();
      return;
    }

    var box = existing;
    if (!box || box.getAttribute('data-uuid') !== uuid || box.previousElementSibling !== card) {
      if (existing) existing.remove();
      box = el('div', 'omen-resource-box');
      box.setAttribute('data-uuid', uuid);
      card.parentNode.insertBefore(box, card.nextSibling);
    }

    if (!resourceStats || resourceStats.uuid !== uuid) {
      if (!box.dataset.sig) {
        box.innerHTML = '<div class="omen-resource-box__title">Resource Usage</div>' +
          '<div class="omen-resource-grid">' +
            resourceRow('cpu', 'CPU', '—', null, true) +
            resourceRow('ram', 'RAM', '—', null, true) +
            resourceRow('storage', 'Storage', '—', null, true) +
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
        resourceRow('cpu', 'CPU', running ? cpuPct.toFixed(1) + '%' : 'Offline', running ? cpuPct : null, !running) +
        resourceRow('ram', 'RAM', running ? formatBytes(resourceStats.memoryBytes) : 'Offline', running ? memPct : null, !running) +
        resourceRow('storage', 'Storage', formatBytes(resourceStats.diskBytes), diskPct, false, diskSub) +
      '</div>';
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
    renderResourceUsage();
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
