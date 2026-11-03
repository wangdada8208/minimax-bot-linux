/**
 * The update control for the Bot page.
 *
 * This file is served by the host, not by the plugin, and the host injects one
 * script tag into the page it proxies. Keeping it outside the plugin means the
 * Mini App stays a byte-for-byte upstream copy while the button still lives in
 * the Bot interface, next to Tasks and Settings.
 *
 * It talks to the host's own endpoints: GET /api/update to look, POST
 * /api/update/apply to fast-forward. The host decides when updating is unsafe
 * and this page only reports that decision.
 */
(function () {
  var LANG = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
  var ZH = LANG.indexOf('zh') === 0;
  var text = function (zh, en) { return ZH ? zh : en; };

  var CSS = '' +
    '.host-update-btn{position:relative}' +
    '.host-update-btn .host-update-dot{position:absolute;top:8px;right:8px;width:7px;height:7px;border-radius:50%;background:var(--star,#ff9800);box-shadow:0 0 0 2px var(--sidebar,#f7f7f7);display:none}' +
    '.host-update-btn[data-has-update="1"] .host-update-dot{display:block}' +
    '.host-update-scrim{position:fixed;inset:0;background:var(--scrim,rgba(10,10,10,.28));display:flex;align-items:center;justify-content:center;z-index:90;padding:24px}' +
    '.host-update-dialog{width:min(520px,100%);max-height:80vh;overflow:auto;background:var(--surface,#fff);color:var(--ink,#141414);border:1px solid var(--line,rgba(20,20,20,.08));border-radius:16px;box-shadow:var(--shadow-pop,0 8px 28px -6px rgba(0,0,0,.14));padding:22px}' +
    '.host-update-dialog h2{margin:0 0 4px;font-size:17px;font-weight:650}' +
    '.host-update-sub{margin:0 0 16px;color:var(--muted,#6e6e6e);font-size:13px}' +
    '.host-update-row{display:flex;justify-content:space-between;gap:16px;padding:7px 0;font-size:13.5px}' +
    '.host-update-row+.host-update-row{border-top:1px solid var(--line,rgba(20,20,20,.08))}' +
    '.host-update-row span:first-child{color:var(--muted,#6e6e6e)}' +
    '.host-update-row code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bubble,#efefef);border-radius:6px;padding:1px 7px}' +
    '.host-update-status{margin-top:14px;font-size:13.5px;line-height:1.6}' +
    '.host-update-status.ok{color:var(--success,#12a150)}' +
    '.host-update-status.warn{color:var(--warning,#e46a12)}' +
    '.host-update-status.bad{color:var(--danger,#e5323f)}' +
    '.host-update-commits{margin:10px 0 0;padding-left:18px;font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted,#6e6e6e);max-height:150px;overflow:auto}' +
    '.host-update-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}' +
    '.host-update-actions button{font:inherit;font-size:13.5px;font-weight:600;border-radius:9px;padding:9px 18px;cursor:pointer;border:1px solid var(--line-strong,rgba(20,20,20,.16));background:transparent;color:var(--ink,#141414)}' +
    '.host-update-actions button.primary{background:var(--user,#0a0a0a);color:var(--user-ink,#fcfcfc);border-color:transparent}' +
    '.host-update-actions button:disabled{opacity:.45;cursor:not-allowed}';

  function addStyle() {
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function short(sha) { return String(sha || '').slice(0, 7) || '—'; }

  function fetchJson(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}))
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, reason: text('无法连接宿主。', 'Cannot reach the host.') }; });
  }

  /** Builds the dialog and wires its buttons; returns an opener. */
  function makeDialog() {
    function open(info, onRetry) {
      var scrim = document.createElement('div');
      scrim.className = 'host-update-scrim';

      var dialog = document.createElement('div');
      dialog.className = 'host-update-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');

      var title = document.createElement('h2');
      title.textContent = text('软件更新', 'Software update');
      var sub = document.createElement('p');
      sub.className = 'host-update-sub';
      sub.textContent = text('更新只写入磁盘，重启宿主后生效。', 'An update lands on disk and applies after the host restarts.');
      dialog.appendChild(title);
      dialog.appendChild(sub);

      var rowEls = {};
      function row(key, label, value) {
        var r = document.createElement('div');
        r.className = 'host-update-row';
        var a = document.createElement('span'); a.textContent = label;
        var b = document.createElement('code'); b.textContent = value;
        r.appendChild(a); r.appendChild(b);
        dialog.appendChild(r);
        rowEls[key] = b;
      }
      row('running', text('正在运行', 'Running'), short(info && (info.running || info.current)));
      row('disk', text('磁盘上', 'On disk'), short(info && (info.disk || info.current)));
      row('remote', text('远端最新', 'Remote'), short(info && info.remote));

      var status = document.createElement('div');
      status.className = 'host-update-status';
      dialog.appendChild(status);

      var commits = document.createElement('ul');
      commits.className = 'host-update-commits';
      dialog.appendChild(commits);

      var actions = document.createElement('div');
      actions.className = 'host-update-actions';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.textContent = text('关闭', 'Close');
      var applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'primary';
      applyBtn.textContent = text('更新到最新', 'Update now');
      applyBtn.disabled = true;
      actions.appendChild(closeBtn);
      actions.appendChild(applyBtn);
      dialog.appendChild(actions);

      function close() { if (scrim.parentNode) scrim.parentNode.removeChild(scrim); }
      closeBtn.addEventListener('click', close);
      scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });

      function render(next) {
        status.className = 'host-update-status';
        commits.textContent = '';
        applyBtn.disabled = true;
        // Keep the version rows honest after an update changes what is on disk.
        if (next && next.ok) {
          if (next.running || next.current) rowEls.running.textContent = short(next.running || next.current);
          if (next.disk || next.to) rowEls.disk.textContent = short(next.disk || next.to);
          if (next.remote || next.to) rowEls.remote.textContent = short(next.remote || next.to);
        }
        if (!next || !next.ok) {
          status.classList.add('bad');
          status.textContent = (next && next.reason) || text('检查失败。', 'Check failed.');
          return;
        }
        // Updating first when the remote is ahead: a checkout that is both
        // behind and different from the running process should be brought up to
        // date, then restarted, so the restart hint must not win here.
        if (next.updateAvailable) {
          if (!next.canUpdate) {
            status.classList.add('bad');
            status.textContent = text('不要更新：', 'Do not update: ') + (next.blockedReason || text('本地改动会导致冲突。', 'local changes would conflict.'));
            return;
          }
          status.classList.add('ok');
          status.textContent = text('有 ' + next.behind + ' 个新提交，可以安全更新。', next.behind + ' new commit(s); safe to update.');
          applyBtn.disabled = false;
          (next.commits || []).slice(0, 12).forEach(function (line) {
            var li = document.createElement('li');
            li.textContent = line;
            commits.appendChild(li);
          });
          return;
        }
        if (next.restartRequired) {
          status.classList.add('warn');
          status.textContent = text(
            '磁盘上的代码比正在运行的进程新，重启宿主后生效。看守进程会在进程退出后约 30 秒自动拉起。',
            'The checkout is newer than the running process. Restart the host; the watchdog brings it back within about 30 seconds.',
          );
          return;
        }
        status.classList.add('ok');
        status.textContent = text('已是最新版本。', 'Already up to date.');
      }

      applyBtn.addEventListener('click', function () {
        applyBtn.disabled = true;
        status.className = 'host-update-status';
        status.textContent = text('正在更新…', 'Updating…');
        fetchJson('/api/update/apply', { method: 'POST' }).then(function (result) {
          if (!result.ok) { render({ ok: false, reason: result.reason }); return; }
          render({
            ok: true,
            running: result.running,
            disk: result.disk || result.to,
            remote: result.to || result.disk,
            updateAvailable: false,
            canUpdate: true,
            restartRequired: result.restartRequired,
          });
          if (typeof onRetry === 'function') onRetry();
        });
      });

      render(info);
      scrim.appendChild(dialog);
      document.body.appendChild(scrim);
      closeBtn.focus();
    }
    return open;
  }

  function install(open) {
    // `#rail` is the filter list and the page re-renders it, which would drop
    // anything added there. The side rail that holds Tasks and Settings is the
    // surrounding `.rail` element.
    var rail = document.querySelector('.rail');
    if (!rail) return false;
    if (document.getElementById('host-update-btn')) return true;

    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'host-update-btn';
    button.className = 'rail-me host-update-btn';
    button.setAttribute('aria-label', text('软件更新', 'Software update'));
    button.title = text('软件更新', 'Software update');
    button.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg><span class="host-update-dot"></span>';

    function refreshBadge() {
      fetchJson('/api/update').then(function (info) {
        var has = Boolean(info && info.ok && (info.updateAvailable || info.restartRequired));
        button.setAttribute('data-has-update', has ? '1' : '0');
        button._lastInfo = info;
      });
    }

    button.addEventListener('click', function () {
      open(button._lastInfo || null, refreshBadge);
      refreshBadge();
    });

    // Sit with the other rail controls, just above Tasks.
    var tasks = document.getElementById('tasks-btn');
    var me = document.getElementById('me-btn');
    if (tasks && tasks.parentNode === rail) rail.insertBefore(button, tasks);
    else if (me && me.parentNode === rail) rail.insertBefore(button, me);
    else rail.appendChild(button);

    refreshBadge();
    return true;
  }

  function boot() {
    addStyle();
    var open = makeDialog();
    if (install(open)) return;
    // The rail is static in the served HTML; if a future version renders it
    // later, wait for it rather than failing silently.
    var observer = new MutationObserver(function () {
      if (install(open)) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
