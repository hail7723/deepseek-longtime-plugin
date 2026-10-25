window.__ModuleLoader__.load({
  id: 'dsh-longtime-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useMemo, useState } = React;

    function jsonObjectCodec(symbol) {
      return Object.freeze({
        mode: 'strict',
        typeSymbol: `dsh-longtime-memory#${symbol}`,
        create: () => ({ parse(value) {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${symbol} must be a JSON object`);
          const seen = new Set();
          function visit(item) {
            if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
            if (typeof item === 'number' && Number.isFinite(item)) return;
            if (typeof item !== 'object' || seen.has(item)) throw new TypeError(`${symbol} must contain only JSON values`);
            seen.add(item);
            if (Array.isArray(item)) item.forEach(visit);
            else {
              if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new TypeError(`${symbol} must be a plain JSON object`);
              Object.values(item).forEach(visit);
            }
            seen.delete(item);
          }
          visit(value);
          return value;
        } }),
      });
    }
    const requestCodec = jsonObjectCodec('Request');
    const resultCodec = jsonObjectCodec('Result');

    const PROJECT_MEMORY_REMOTE = Object.freeze({
      package: 'dsh-longtime-memory',
      descriptors: Object.freeze(['workspace', 'snapshot', 'startTask', 'useTask', 'listTasks', 'setTaskState', 'commit', 'bootstrap', 'claim', 'checkpoint', 'leaseStatus', 'deferred', 'discardDeferred', 'search', 'proposeContract'].map(method => Object.freeze({
        id: `dsh-longtime-memory#projectMemory/${method}`,
        service: 'projectMemory',
        namespace: 'projectMemory',
        method,
        invocation: Object.freeze({ kind: 'direct' }),
        parameters: Object.freeze([Object.freeze({
          name: 'request', wire: 'request', source: 'json', codec: requestCodec,
        })]),
        result: resultCodec,
      }))),
    });

    const TEXT = {
      title: '项目记忆', overview: '概览', tasks: '任务', contracts: '契约', history: '历史',
      cwd: '当前工作区', refresh: '刷新', refreshing: '刷新中…', uninitialized: '当前工作区尚未初始化项目记忆',
      bootstrap: '初始化项目', claim: '领取当前任务', checkpoint: '创建 Checkpoint', search: '搜索历史',
      propose: '提出契约变更', submit: '提交', success: '操作成功', empty: '暂无数据',
      savedAt: iso => `已保存于 ${formatRelative(iso)}`, saving: '正在保存',
      waitingLease: seconds => `等待另一会话保存（约 ${Math.max(1, Math.round(seconds))} 秒后可重试）`,
      unsaved: '未保存 — 可重试', retrySave: '重试保存', keepDraft: '保留为待同步草稿',
      waitRetry: seconds => `等待约 ${Math.max(1, Math.round(seconds))} 秒后自动重试`,
      cancelWait: '取消等待', willRetryIn: seconds => `将在约 ${Math.max(1, Math.round(seconds))} 秒后自动重试保存`,
      discardDraft: '取消草稿', diagnostics: '诊断详情', draftKept: '草稿已保留在本面板，稍后可重试保存',
    };

    function formatRelative(iso) {
      const time = Date.parse(iso);
      if (!Number.isFinite(time)) return first(iso, '—');
      const seconds = Math.round((Date.now() - time) / 1000);
      if (seconds < 45) return '刚刚';
      if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`;
      if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`;
      if (seconds < 172800) return `昨天 ${new Date(time).toTimeString().slice(0, 5)}`;
      return new Date(time).toLocaleString();
    }

    // UI-safe Chinese copy per error code.  Raw codes, owners, ISO timestamps
    // and fences are only shown inside the diagnostics area.
    const CODE_TEXT = {
      LEASE_CONFLICT: e => `另一会话正在保存，约 ${Math.max(1, Math.round(Number(e.retryAfterSeconds ?? 60)))} 秒后可重试`,
      SESSION_REQUIRED: () => '本面板需要知道当前会话；请在项目会话激活的窗口中使用，然后点“刷新”',
      WORKSPACE_UNAVAILABLE: () => '当前没有带工作区的项目会话；请在本窗口打开或新建一个项目会话，然后点“刷新”',
      WORKSPACE_SELECTION_REQUIRED: () => '存在多个活动工作区；请在面板顶部的候选框中选择一个',
      WORKSPACE_PICK_REQUIRED: () => '请选择一个项目工作区',
      TASK_SELECTION_REQUIRED: () => '有多个未完成任务，请先明确选择一个任务',
      NOT_FOUND: () => '未找到对应记录，请刷新后重试',
      PROJECT_MEMORY_NOT_INITIALIZED: () => '当前工作区尚未初始化项目记忆',
      PROJECT_MEMORY_ERROR: () => '本地记忆存储读写失败，请查看诊断详情',
      TASK_REVISION_CONFLICT: () => '任务已被其他会话更新，请刷新后基于最新状态重试',
      CONTRACT_REVISION_CONFLICT: () => '契约已被更新，请刷新后基于最新状态重试',
      IDEMPOTENCY_CONFLICT: () => '重复的提交被拒绝',
      DEFERRED_OWNER_CONFLICT: () => '只有创建该草稿的会话可以取消它',
      DEFERRED_STATE_CONFLICT: () => '草稿状态已变化，请刷新后重试',
    };

    const CSS = `
      .pm-root{height:100%;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit}
      .pm-shell{max-width:1180px;margin:0 auto;padding:24px 28px 48px}
      .pm-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding-bottom:20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
      .pm-title{margin:0;font-size:24px;line-height:32px;font-weight:650;letter-spacing:0}.pm-subtitle{margin:5px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;overflow-wrap:anywhere}
      .pm-actions,.pm-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pm-btn{min-height:34px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 12px;font:inherit;font-size:13px;cursor:pointer}.pm-btn:hover{border-color:var(--dsw-alias-brand-primary)}.pm-btn:disabled{cursor:not-allowed;opacity:.55}.pm-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base)}
      .pm-tabs{display:flex;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:22px}.pm-tab{border:0;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:14px 2px 12px;font:inherit;font-size:14px;cursor:pointer}.pm-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}
      .pm-workspace{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:10px;margin:18px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}.pm-workspace-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.pm-workspace-path{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;overflow-wrap:anywhere}.pm-input,.pm-textarea,.pm-select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:8px 10px;outline:none}.pm-input:focus,.pm-textarea:focus,.pm-select:focus{border-color:var(--dsw-alias-brand-primary)}.pm-textarea{min-height:86px;resize:vertical;line-height:1.45}
      .pm-save{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:16px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-state-success-primary);border-radius:6px;background:var(--dsw-alias-bg-layer-1);font-size:13px}.pm-save-label{font-weight:600}.pm-save-saving{border-left-color:var(--dsw-alias-state-idle-primary)}.pm-save-waiting{border-left-color:var(--dsw-alias-state-warn-primary)}.pm-save-unsaved{border-left-color:var(--dsw-alias-state-error-primary)}.pm-save-toggle{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;padding:0}.pm-save-toggle:hover{color:var(--dsw-alias-label-primary)}.pm-save-note{flex-basis:100%;color:var(--dsw-alias-label-secondary);font-size:12px}
      .pm-draft-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:10px;align-items:center}
      .pm-status{margin:16px 0;padding:10px 12px;border-left:3px solid var(--dsw-alias-state-idle-primary);background:var(--dsw-alias-bg-layer-1);font-size:13px;white-space:pre-wrap;overflow-wrap:anywhere}.pm-status-success{border-left-color:var(--dsw-alias-state-success-primary)}.pm-status-error{border-left-color:var(--dsw-alias-state-error-primary)}.pm-status-conflict{border-left-color:var(--dsw-alias-state-warn-primary)}
      .pm-metrics{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));border:1px solid var(--dsw-alias-border-l1);border-radius:6px;margin:20px 0}.pm-metric{padding:14px 16px;border-right:1px solid var(--dsw-alias-border-l1)}.pm-metric:last-child{border-right:0}.pm-metric-label{font-size:12px;color:var(--dsw-alias-label-secondary)}.pm-metric-value{margin-top:5px;font-size:16px;font-weight:600;overflow-wrap:anywhere}
      .pm-section{padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.pm-section:last-child{border-bottom:0}.pm-section-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.pm-h2{margin:0;font-size:16px;line-height:22px;font-weight:650}.pm-muted{color:var(--dsw-alias-label-secondary);font-size:13px}.pm-copy{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:1.6}
      .pm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 28px}.pm-field{margin-bottom:14px}.pm-label{display:block;margin-bottom:6px;color:var(--dsw-alias-label-secondary);font-size:12px}.pm-span{grid-column:1/-1}.pm-list{margin:0;padding:0;list-style:none;border-top:1px solid var(--dsw-alias-border-l1)}.pm-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px;padding:11px 2px;border-bottom:1px solid var(--dsw-alias-border-l1);align-items:start}.pm-row-title{font-size:13px;font-weight:600;overflow-wrap:anywhere}.pm-row-detail{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.pm-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px}.pm-badge{display:inline-flex;align-items:center;min-height:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}.pm-badge-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
      .pm-conflict{margin-top:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}.pm-pre{max-height:220px;overflow:auto;margin:8px 0 0;padding:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;font-size:11px;white-space:pre-wrap}
      .pm-icon-button{display:grid;place-items:center;width:100%;height:100%;min-width:32px;min-height:32px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}.pm-icon-button[data-active=true]{color:var(--dsw-alias-brand-primary)}.pm-icon-button svg{display:block}
      @media(max-width:760px){.pm-shell{padding:18px 16px 36px}.pm-header{display:block}.pm-actions{margin-top:14px}.pm-workspace{grid-template-columns:1fr}.pm-tabs{gap:14px;overflow-x:auto}.pm-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.pm-metric:nth-child(2){border-right:0}.pm-metric:nth-child(-n+2){border-bottom:1px solid var(--dsw-alias-border-l1)}.pm-grid{grid-template-columns:1fr}.pm-span{grid-column:auto}}
      @media(max-width:430px){.pm-metrics{grid-template-columns:1fr}.pm-metric{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)!important}.pm-metric:last-child{border-bottom:0!important}}
    `;

    function asArray(value) { return Array.isArray(value) ? value : []; }
    function first(value, fallback) { return value === undefined || value === null || value === '' ? fallback : value; }
    function json(value) { try { return JSON.stringify(value, null, 2); } catch { return String(value); } }
    function errorInfo(error) {
      const value = error && typeof error === 'object' ? error : { message: String(error) };
      const code = String(value.code || value.errorCode || value.name || 'ERROR');
      const mapped = CODE_TEXT[code];
      const message = mapped ? mapped(value) : (value.message || value.reason || '操作失败');
      const conflict = /CONFLICT|REVISION|LEASE|FENCE|STALE/i.test(code + ' ' + String(value.message || ''));
      return { type: conflict ? 'conflict' : 'error', title: conflict ? '保存冲突' : '操作失败', message, code, detail: value };
    }
    function field(label, child, extra) { return h('label', { className: `pm-field${extra ? ` ${extra}` : ''}` }, h('span', { className: 'pm-label' }, label), child); }
    function input(value, onChange, props) { return h('input', { className: 'pm-input', value, onChange: e => onChange(e.target.value), ...props }); }
    function textarea(value, onChange, props) { return h('textarea', { className: 'pm-textarea', value, onChange: e => onChange(e.target.value), ...props }); }
    function button(label, onClick, primary, disabled) { return h('button', { type: 'button', className: `pm-btn${primary ? ' pm-btn-primary' : ''}`, onClick, disabled }, label); }
    function section(title, content, action) { return h('section', { className: 'pm-section' }, h('div', { className: 'pm-section-head' }, h('h2', { className: 'pm-h2' }, title), action || null), content); }
    function rows(items, render, empty) { return items.length ? h('ul', { className: 'pm-list' }, items.map(render)) : h('p', { className: 'pm-muted' }, empty || TEXT.empty); }

    function MemoryIcon({ size = 20, active = false }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('ellipse', { cx: 12, cy: 5, rx: 7, ry: 3 }), h('path', { d: 'M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5' }), h('path', { d: 'M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6' }), active ? h('circle', { cx: 19, cy: 18, r: 2, fill: 'currentColor', stroke: 'none' }) : null);
    }

    function SidebarEntry(props) {
      return h(MemoryIcon, { size: props.size || 20, active: props.active });
    }

    function Feedback({ value, onReload }) {
      if (!value) return null;
      return h('div', { className: `pm-status pm-status-${value.type}`, role: value.type === 'error' || value.type === 'conflict' ? 'alert' : 'status' },
        h('strong', null, value.title), h('div', null, value.message || ''),
        value.type === 'conflict' ? h('div', { className: 'pm-conflict' }, button('重新加载最新状态', onReload, false, false), h('pre', { className: 'pm-pre' }, json(value.detail))) : null);
    }

    function SaveStatus({ lease, deferred, checkpointAt, busy, draftKept, pendingWait, onWait, onCancelWait, onRetry, onDiscard, onReload }) {
      const [showDiagnostics, setShowDiagnostics] = useState(false);
      let tone = 'saved'; let label = checkpointAt ? TEXT.savedAt(checkpointAt) : '尚未保存过';
      if (busy) { tone = 'saving'; label = TEXT.saving; }
      else if (pendingWait) { tone = 'waiting'; label = pendingWait.label; }
      else if (lease && lease.heldBy === 'other-session') { tone = 'waiting'; label = TEXT.waitingLease(lease.retryAfterSeconds ?? lease.remainingSeconds ?? 60); }
      else if ((deferred && deferred.queued > 0) || draftKept) { tone = 'unsaved'; label = TEXT.unsaved; }
      const actions = [];
      if (pendingWait) actions.push(button(TEXT.cancelWait, onCancelWait, false, Boolean(busy)));
      else if (tone === 'waiting') {
        const waitSeconds = lease.retryAfterSeconds ?? lease.remainingSeconds ?? 60;
        actions.push(button(TEXT.waitRetry(waitSeconds), () => onWait(waitSeconds), false, Boolean(busy)));
        actions.push(button(TEXT.retrySave, onRetry, false, Boolean(busy)));
      }
      if (tone === 'unsaved') actions.push(button(TEXT.retrySave, onRetry, false, Boolean(busy)));
      if (deferred && deferred.queued > 0) actions.push(button(TEXT.discardDraft, onDiscard, false, Boolean(busy)));
      const diagnostics = lease && lease.diagnostics;
      return h('div', { className: `pm-save pm-save-${tone}`, role: 'status' },
        h('span', { className: 'pm-save-label' }, label),
        actions.length ? h('span', { className: 'pm-inline' }, actions) : null,
        diagnostics ? h('button', { type: 'button', className: 'pm-save-toggle', onClick: () => setShowDiagnostics(v => !v) }, TEXT.diagnostics) : null,
        draftKept && tone !== 'saving' ? h('div', { className: 'pm-save-note' }, TEXT.draftKept) : null,
        showDiagnostics && diagnostics ? h('pre', { className: 'pm-pre' }, json(diagnostics)) : null,
      );
    }

    function ProjectMemoryPanel({ api, sessionId: scopedSessionId }) {
      const [tab, setTab] = useState('overview');
      const [cwd, setCwd] = useState('');
      const [sessionId, setSessionId] = useState(typeof scopedSessionId === 'string' && scopedSessionId ? scopedSessionId : '');
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState('');
      const [feedback, setFeedback] = useState(null);
      const [bootstrap, setBootstrap] = useState({ taskId: '', objective: '', criteria: '', constraints: '' });
      const [commit, setCommit] = useState({ progress: '', nextAction: '', blockers: '', evidence: '' });
      const [newTask, setNewTask] = useState({ objective: '', criteria: '', constraints: '' });
      const [search, setSearch] = useState({ query: '', limit: '20' });
      const [results, setResults] = useState([]);
      const [proposal, setProposal] = useState({ sourceRef: '', diff: '' });
      const [lastCommitArgs, setLastCommitArgs] = useState(null);
      const [draftKept, setDraftKept] = useState(false);
      // When the Host cannot map exactly one workspace, the panel asks the
      // user to pick from its candidate list instead of guessing.
      // When the user chooses to wait out another session's lease, a real
      // timer retries the save once and can be cancelled before it fires.
      const [pendingWait, setPendingWait] = useState(null);
      function startWaitRetry(seconds) {
        const waitSeconds = Math.max(1, Math.round(Number(seconds) || 1));
        const timer = setTimeout(() => { setPendingWait(null); retrySave(); }, waitSeconds * 1000);
        setPendingWait({ label: TEXT.willRetryIn(waitSeconds), cancel: () => { clearTimeout(timer); setPendingWait(null); } });
      }
      // When the Host cannot map exactly one workspace, the panel asks the
      // user to pick from its candidate list instead of guessing.
      const [workspaceChoices, setWorkspaceChoices] = useState(null);

      const task = data && (data.task || data.currentTask) || {};
      const contract = data && (data.contract || data.confirmedContract) || {};
      const taskRevision = first(task.taskVersion, first(task.revision, first(data && (data.task_revision || data.taskRevision), 0)));
      const contractRevision = first(task.contractVersion, first(contract.revision, first(data && (data.contract_revision || data.contractRevision), 0)));
      const leaseToken = first(task.lease_token, first(task.leaseToken, data && (data.lease_token || data.leaseToken)));
      const taskId = first(task.id, first(task.task_id, bootstrap.taskId));
      const initialized = Boolean(data && first(data.initialized, data.project_id || data.projectId || task.id || task.task_id));

      async function invoke(method, args, successMessage, refreshAfter) {
        setBusy(method); setFeedback(null);
        try {
          const result = await api(method, args || {});
          if (result && result.ok === false) throw result.error || result;
          setFeedback({ type: 'success', title: TEXT.success, message: successMessage || `${method} 已完成` });
          if (refreshAfter) await load(true);
          return result;
        } catch (error) { setFeedback(errorInfo(error)); return null; }
        finally { setBusy(''); }
      }
      async function resolveWorkspace() {
        // The session-scoped slot prop wins; without it the Host's
        // sole-candidate answer is the single-window fallback.
        let workspace = sessionId ? await api('workspace', { session_id: sessionId }) : await api('workspace', {});
        if ((!workspace || workspace.ok === false || !workspace.cwd) && sessionId) workspace = await api('workspace', {});
        if (workspace && workspace.ok !== false && workspace.cwd) {
          setCwd(workspace.cwd);
          setWorkspaceChoices(null);
          if (!sessionId && workspace.sessionId) setSessionId(workspace.sessionId);
          return workspace.cwd;
        }
        const candidates = Array.isArray(workspace && workspace.candidates) ? workspace.candidates : [];
        if (candidates.length > 0) {
          setWorkspaceChoices(candidates);
          const pick = new Error('请选择一个项目工作区');
          pick.code = 'WORKSPACE_PICK_REQUIRED';
          throw pick;
        }
        throw (workspace && workspace.error) || new Error('当前没有带工作区的项目会话；请在本窗口打开或新建一个项目会话，然后点“刷新”');
      }
      async function pickWorkspace(choice) {
        setWorkspaceChoices(null);
        await load(false, choice.cwd);
      }
      async function switchWorkspace() {
        setCwd('');
        setWorkspaceChoices(null);
        setSessionId(typeof scopedSessionId === 'string' && scopedSessionId ? scopedSessionId : '');
        try {
          const next = await resolveWorkspace();
          if (next) await load(true, next);
        } catch { /* the picker or the empty hint is now visible */ }
      }
      async function load(quiet, requestedCwd) {
        setBusy('snapshot'); if (!quiet) setFeedback(null);
        try {
          const activeCwd = requestedCwd || cwd || await resolveWorkspace();
          const next = await api('snapshot', { cwd: activeCwd, ...(sessionId ? { session_id: sessionId } : {}) });
          if (next && next.ok === false) throw next.error || next;
          setData(next || {});
          const nextCwd = next && (next.cwd || next.workingDirectory || next.root);
          if (nextCwd) setCwd(nextCwd);
          if (!bootstrap.taskId && next && next.task && (next.task.id || next.task.task_id)) setBootstrap(v => ({ ...v, taskId: next.task.id || next.task.task_id }));
        } catch (error) {
          // The picker itself is the UI for this state; no error banner.
          if (error && error.code !== 'WORKSPACE_PICK_REQUIRED') setFeedback(errorInfo(error));
        }
        finally { setBusy(''); }
      }
      useEffect(() => { let live = true; resolveWorkspace().then(activeCwd => { if (live) return load(true, activeCwd); return null; }).catch(error => { if (live && error && error.code !== 'WORKSPACE_PICK_REQUIRED') setFeedback(errorInfo(error)); }); return () => { live = false; }; }, [api]);

      async function doBootstrap() {
        const criteria = bootstrap.criteria.split('\n').map(x => x.trim()).filter(Boolean);
        const constraints = bootstrap.constraints.split('\n').map(x => x.trim()).filter(Boolean);
        await invoke('bootstrap', { cwd, task_id: bootstrap.taskId.trim(), objective: bootstrap.objective.trim(), acceptance_criteria: criteria, constraints, source_ref: 'project-memory-ui' }, '项目记忆已初始化', true);
      }
      function requireSession(label) {
        if (!sessionId) {
          const error = new Error('本面板需要知道当前会话；请在项目会话激活的窗口中使用，然后点“刷新”');
          error.code = 'SESSION_REQUIRED';
          setFeedback(errorInfo(error));
          return null;
        }
        return sessionId;
      }
      async function doStartTask() {
        const who = requireSession(); if (!who) return;
        const criteria = newTask.criteria.split('\n').map(x => x.trim()).filter(Boolean);
        const constraints = newTask.constraints.split('\n').map(x => x.trim()).filter(Boolean);
        const result = await invoke('startTask', { cwd, session_id: who, objective: newTask.objective.trim(), acceptance_criteria: criteria, constraints }, '任务已创建并绑定到当前会话', true);
        if (result) setNewTask({ objective: '', criteria: '', constraints: '' });
      }
      async function doUseTask(taskId) {
        const who = requireSession(); if (!who) return;
        await invoke('useTask', { cwd, session_id: who, task_id: taskId }, '已切换当前会话的任务', true);
      }
      async function doSetTaskState(taskId, state, label) {
        await invoke('setTaskState', { cwd, task_id: taskId, state }, `任务已${label}`, true);
      }
      async function doCommit() {
        const who = requireSession(); if (!who) return;
        const blockers = commit.blockers.split('\n').map(x => x.trim()).filter(Boolean);
        const evidenceRefs = commit.evidence.split('\n').map(x => x.trim()).filter(Boolean);
        const args = { cwd, session_id: who, progress: commit.progress, next_action: commit.nextAction || undefined, blockers, evidence_refs: evidenceRefs };
        setLastCommitArgs(args); setDraftKept(false);
        const result = await invoke('commit', args, '进度已保存', true);
        if (result) { setCommit({ progress: '', nextAction: '', blockers: '', evidence: '' }); }
        else setDraftKept(true);
      }
      async function retrySave() {
        // An immediate retry supersedes any scheduled wait.
        if (pendingWait) pendingWait.cancel();
        if (lastCommitArgs) {
          setDraftKept(false);
          const result = await invoke('commit', lastCommitArgs, '进度已保存', true);
          if (result) setCommit({ progress: '', nextAction: '', blockers: '', evidence: '' });
        } else { await load(false); }
      }
      async function discardDraft(id) {
        await invoke('discardDeferred', { cwd, id }, '草稿已取消，不会再同步', true);
      }
      async function doSearch() {
        setBusy('search'); setFeedback(null);
        try {
          const out = await api('search', { cwd, session_id: sessionId || undefined, task_id: taskId || undefined, query: search.query, limit: Number(search.limit) || 20 });
          if (out && out.ok === false) throw out.error || out;
          const found = asArray(out && (out.results || out.items || out));
          const scopeLabel = { current: '当前工作区（所选任务）', task: '指定任务的全部工作区', project: '整个项目' }[out && out.scope] || '当前工作区';
          setResults(found);
          setFeedback({ type: 'success', title: '搜索完成', message: `找到 ${found.length} 条历史结果；范围：${scopeLabel}。${found.length ? '' : '未命中不代表未写入，请检查作用域、查询方式或待同步草稿。'}${out && out.queuedDeferredCount ? ` 范围内有 ${out.queuedDeferredCount} 条待同步草稿，尚未确认。` : ''}${out && out.budget && out.budget.truncated ? ' 部分结果受数量或字节预算限制，请缩小查询。' : ''}` });
        }
        catch (error) { setFeedback(errorInfo(error)); } finally { setBusy(''); }
      }
      async function doPropose() {
        let diff;
        try { diff = JSON.parse(proposal.diff); } catch (error) { setFeedback({ type: 'error', title: '输入格式错误', message: `契约差异必须是 JSON：${error.message}` }); return; }
        await invoke('proposeContract', { cwd, task_id: taskId, expected_contract_revision: Number(contractRevision), source_ref: proposal.sourceRef || 'project-memory-ui', diff, idempotency_key: `ui-contract-${Date.now()}` }, '契约变更候选已提交', true);
      }

      const metrics = [
        ['Project ID', first(data && (data.project_id || data.projectId), '—')],
        ['Task revision', taskRevision], ['Contract revision', contractRevision], ['Event seq', first(data && (data.event_seq || data.eventSeq), '—')],
      ];
      const deferredItems = asArray(data && data.deferredItems);
      const deferredCounts = (data && data.deferredCounts) || { queued: 0, flushed: 0, conflict: 0, discarded: 0 };
      const leaseStatus = data && data.leaseStatus;
      const saveBar = h(SaveStatus, {
        lease: leaseStatus, deferred: deferredCounts, checkpointAt: data && data.checkpoint && data.checkpoint.createdAt,
        busy: Boolean(busy && busy !== 'snapshot' && busy !== 'search'), draftKept, pendingWait,
        onWait: startWaitRetry, onCancelWait: () => { if (pendingWait) pendingWait.cancel(); },
        onRetry: retrySave, onDiscard: () => { const queued = deferredItems.find(item => item.status === 'queued'); if (queued) discardDraft(queued.id); }, onReload: () => load(false),
      });
      const tabs = [['overview', TEXT.overview], ['tasks', TEXT.tasks], ['contracts', TEXT.contracts], ['history', TEXT.history]];
      const overview = h(React.Fragment, null,
        h('div', { className: 'pm-metrics' }, metrics.map(([label, value]) => h('div', { className: 'pm-metric', key: label }, h('div', { className: 'pm-metric-label' }, label), h('div', { className: 'pm-metric-value pm-code' }, String(value))))),
        section('当前目标', h('p', { className: 'pm-copy' }, first(task.objective, first(contract.objective, task.title || '尚未设置目标')))),
        section('验收条件', rows(asArray(task.acceptance_criteria || task.acceptanceCriteria || contract.acceptanceCriteria), (item, i) => h('li', { className: 'pm-row', key: i }, h('div', { className: 'pm-row-title' }, typeof item === 'string' ? item : json(item))))),
        section('下一步', h('p', { className: 'pm-copy' }, first(task.next_action || task.nextAction, first(data && (data.next_action || data.nextAction), '尚未记录下一步')))),
        section('Pending 操作', rows(asArray(data && (data.pending_operations || data.pendingOperations)), (item, i) => h('li', { className: 'pm-row', key: i }, h('div', null, h('div', { className: 'pm-row-title' }, typeof item === 'string' ? item : first(item.name, `操作 ${i + 1}`)), h('div', { className: 'pm-row-detail' }, typeof item === 'string' ? '' : json(item))), h('span', { className: 'pm-badge pm-badge-warn' }, 'Pending'))))
      );
      const openTasks = asArray(data && data.tasks).filter(item => !['completed', 'archived'].includes(item.state));
      const selectionBanner = data && data.selectionRequired ? h('div', { className: 'pm-status pm-status-conflict', role: 'alert' },
        h('strong', null, '请选择一个任务'), h('div', null, '当前会话尚未绑定任务；请从下面的列表选择，不要按顺序猜测。'),
        rows(asArray(data && data.taskCandidates), item => h('li', { className: 'pm-row', key: item.id },
          h('div', null, h('div', { className: 'pm-row-title' }, first(item.title, item.id)), h('div', { className: 'pm-row-detail' }, `${item.id} · ${item.state}`)),
          button('选择此任务', () => doUseTask(item.id), false, Boolean(busy) || !sessionId),
        ))) : null;
      const taskRow = item => h('li', { className: 'pm-row', key: item.id },
        h('div', null, h('div', { className: 'pm-row-title' }, first(item.title, item.id)), h('div', { className: 'pm-row-detail' }, `${item.id} · ${item.state}${item.id === taskId ? ' · 当前会话已绑定' : ''}`)),
        h('span', { className: 'pm-inline' },
          item.id === taskId ? null : button('选择', () => doUseTask(item.id), false, Boolean(busy) || !sessionId),
          item.state === 'paused' ? button('继续', () => doSetTaskState(item.id, 'active', '继续'), false, Boolean(busy)) : item.state === 'active' ? button('暂停', () => doSetTaskState(item.id, 'paused', '暂停'), false, Boolean(busy)) : null,
          button('完成', () => doSetTaskState(item.id, 'completed', '标记完成'), false, Boolean(busy)),
          button('归档', () => doSetTaskState(item.id, 'archived', '归档'), false, Boolean(busy)),
        ));
      const taskView = h(React.Fragment, null,
        selectionBanner,
        section('未完成任务', rows(openTasks, taskRow, '没有未完成任务；可在下方新建')),
        section('新建任务', h('div', { className: 'pm-grid' }, field('目标', input(newTask.objective, value => setNewTask(v => ({ ...v, objective: value }))), { placeholder: '描述要完成的结果' })), button(busy === 'startTask' ? '创建中…' : '新建并绑定到当前会话', doStartTask, true, Boolean(busy || !sessionId || !newTask.objective.trim()))),
        section('保存进度', h('div', { className: 'pm-grid' }, field('阶段摘要', textarea(commit.progress, value => setCommit(v => ({ ...v, progress: value }))), 'pm-span'), field('下一步', textarea(commit.nextAction, value => setCommit(v => ({ ...v, nextAction: value }))), 'pm-span'), field('阻塞项（每行一项）', textarea(commit.blockers, value => setCommit(v => ({ ...v, blockers: value }))), 'pm-span'), field('证据引用（每行一项）', textarea(commit.evidence, value => setCommit(v => ({ ...v, evidence: value })), { placeholder: 'test:unit' }), 'pm-span')), button(busy === 'commit' ? '保存中…' : '保存进度', doCommit, true, Boolean(busy || !taskId || !sessionId))),
        section('待同步草稿', rows(deferredItems.filter(item => item.status === 'queued' || item.status === 'conflict'), item => h('li', { className: 'pm-row', key: item.id },
          h('div', null, h('div', { className: 'pm-row-title' }, first(item.summary, '（无摘要）')), h('div', { className: 'pm-row-detail' }, `${item.sessionId} · 排队于 ${formatRelative(item.createdAt)}${item.reason ? ` · ${item.reason}` : ''}`)),
          h('span', { className: 'pm-inline' }, item.status === 'conflict' ? h('span', { className: 'pm-badge pm-badge-warn' }, '需要复核') : h('span', { className: 'pm-badge' }, '排队中'), item.status === 'queued' ? button(TEXT.discardDraft, () => discardDraft(item.id), false, Boolean(busy)) : null),
        ), '没有排队或需要复核的草稿'))
      );
      const contractView = h(React.Fragment, null,
        section(`已确认契约 v${contractRevision}`, h('pre', { className: 'pm-pre' }, json(contract.data || contract.value || contract))),
        section('候选变更', rows(asArray(data && (data.contract_candidates || data.contractCandidates || data.proposals)), (item, i) => h('li', { className: 'pm-row', key: item.id || i }, h('div', null, h('div', { className: 'pm-row-title' }, first(item.title, `候选 #${first(item.id, i + 1)}`)), h('div', { className: 'pm-row-detail' }, json(item))), h('span', { className: 'pm-badge pm-badge-warn' }, '候选')))),
        section(TEXT.propose, h('div', { className: 'pm-grid' }, field('来源引用', input(proposal.sourceRef, value => setProposal(v => ({ ...v, sourceRef: value })), { placeholder: '用户消息或文档' })), field('契约差异 JSON', textarea(proposal.diff, value => setProposal(v => ({ ...v, diff: value })), { placeholder: '{"acceptance_criteria":{"add":["..."]}}' }), 'pm-span')), button(busy === 'proposeContract' ? '提交中…' : TEXT.propose, doPropose, true, Boolean(busy || !proposal.diff.trim())))
      );
      const historyView = h(React.Fragment, null,
        section(
          TEXT.search,
          h('div', { className: 'pm-grid' },
            field('关键词', input(search.query, value => setSearch(v => ({ ...v, query: value })), { placeholder: '测试、文件或事件内容' })),
            field('最多结果', input(search.limit, value => setSearch(v => ({ ...v, limit: value })), { type: 'number', min: 1, max: 100 })),
          ),
          button(busy === 'search' ? '搜索中…' : TEXT.search, doSearch, true, Boolean(busy || !search.query.trim())),
        ),
        section('搜索结果', rows(results, (item, i) => {
          const visibility = item.visibility === 'queued' ? '待同步 · 未确认' : item.visibility === 'confirmed' ? '已同步历史' : '';
          const title = `${first(item.type, first(item.title, first(item.source, `结果 ${i + 1}`)))}${visibility ? ` · ${visibility}` : ''}${item.freshness === 'unknown' ? ' · 时效未核验' : ''}`;
          const detail = first(item.snippet, first(item.summary, first(item.text, json(item))));
          const marker = first(item.event_seq || item.eventSeq, first(item.created_at || item.createdAt, '记录'));
          return h('li', { className: 'pm-row', key: item.id || item.event_seq || i },
            h('div', null, h('div', { className: 'pm-row-title' }, title), h('div', { className: 'pm-row-detail' }, detail)),
            h('span', { className: 'pm-badge' }, marker),
          );
        })),
        section('最近事件', rows(asArray(data && (data.events || data.recent_events || data.recentEvents)), (item, i) => {
          const marker = String(first(item.event_seq || item.eventSeq, '—'));
          return h('li', { className: 'pm-row', key: item.event_seq || item.id || i },
            h('div', null, h('div', { className: 'pm-row-title' }, first(item.type, '事件')), h('div', { className: 'pm-row-detail' }, json(item))),
            h('span', { className: 'pm-badge' }, marker),
          );
        })),
      );

      const bootstrapView = section(TEXT.bootstrap, h('div', { className: 'pm-grid' }, field('任务 ID', input(bootstrap.taskId, value => setBootstrap(v => ({ ...v, taskId: value })), { placeholder: 'project-main-task' })), field('目标', input(bootstrap.objective, value => setBootstrap(v => ({ ...v, objective: value })), { placeholder: '描述要完成的结果' })), field('验收条件（每行一项）', textarea(bootstrap.criteria, value => setBootstrap(v => ({ ...v, criteria: value })))), field('约束（每行一项）', textarea(bootstrap.constraints, value => setBootstrap(v => ({ ...v, constraints: value }))))), button(busy === 'bootstrap' ? '初始化中…' : TEXT.bootstrap, doBootstrap, true, Boolean(busy || !cwd.trim() || !bootstrap.taskId.trim() || !bootstrap.objective.trim())));

      return h('main', { className: 'pm-root' }, h('style', null, CSS), h('div', { className: 'pm-shell' },
        h('header', { className: 'pm-header' }, h('div', null, h('h1', { className: 'pm-title' }, TEXT.title), h('p', { className: 'pm-subtitle' }, initialized ? `本地 SQLite · ${first(data && (data.branch || data.git_branch), '当前分支')}` : TEXT.uninitialized)), h('div', { className: 'pm-actions' }, button(busy === 'snapshot' ? TEXT.refreshing : TEXT.refresh, () => load(false), false, Boolean(busy)))),
        h('div', { className: 'pm-workspace' }, h('span', { className: 'pm-workspace-label' }, TEXT.cwd), h('code', { className: 'pm-workspace-path' }, cwd || '等待选择项目工作区…'), cwd ? button('切换项目', switchWorkspace, false, Boolean(busy)) : null),
        workspaceChoices && workspaceChoices.length ? section('选择项目工作区', rows(workspaceChoices, item => h('li', { className: 'pm-row', key: item.sessionId || item.cwd },
          h('div', null, h('div', { className: 'pm-row-title pm-code' }, item.cwd), h('div', { className: 'pm-row-detail' }, `会话 ${item.sessionId ?? '—'}`)),
          button('打开此项目', () => pickWorkspace(item), true, Boolean(busy)),
        ), 'Host 没有报告任何候选')) : null,
        h(Feedback, { value: feedback, onReload: () => load(false) }),
        initialized ? h(React.Fragment, null, saveBar, h('nav', { className: 'pm-tabs', 'aria-label': '项目记忆视图' }, tabs.map(([id, label]) => h('button', { type: 'button', role: 'tab', className: 'pm-tab', 'aria-selected': tab === id, key: id, onClick: () => setTab(id) }, label))), tab === 'overview' ? overview : tab === 'tasks' ? taskView : tab === 'contracts' ? contractView : historyView) : bootstrapView
      ));
    }

    return {
      inject: ['slots', 'remote'],
      async apply(ctx) {
        let unmountRemote = async () => {};
        let transportError;
        try {
          unmountRemote = await ctx.remote.$mount(PROJECT_MEMORY_REMOTE);
        } catch (error) {
          transportError = error;
          ctx.logger?.error('Project Memory Remote initialization failed', error);
        }
        const layout = ctx.get('layout');
        const api = async (method, args) => {
          if (transportError) throw transportError;
          const request = Object.fromEntries(Object.entries(args ?? {}).filter(([, value]) => value !== undefined));
          requestCodec.create().parse(request);
          const namespace = ctx.get('remote.projectMemory');
          if (!namespace) throw new Error('Project Memory Remote namespace is unavailable');
          const carried = await namespace[method](request);
          if (!carried.ok) throw carried.error;
          return resultCodec.create().parse(carried.value);
        };
        const disposeSidebar = ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'project-memory', order: 20, label: () => TEXT.title }, props => h(SidebarEntry, { ...props, layout })));
        const disposeMain = ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'project-memory' }, props => h(ProjectMemoryPanel, { ...props, api })));
        return async () => {
          await disposeMain();
          await disposeSidebar();
          await unmountRemote();
        };
      },
    };
  },
});
