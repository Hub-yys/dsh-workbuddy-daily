/**
 * dsh-workbuddy-daily — browser half.
 *
 * One settings card. It reports what the last launch did and what the next launch
 * would do, which is the question a user actually has: "is there anything left to
 * claim today?"
 *
 * Read-mostly by design: the only action is "run now". Everything else (the
 * schedule, the claim policy) lives in the settings schema.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-daily',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    let react = require('react')
    let jsx = require('react/jsx-runtime')

    const NS = 'dsh-workbuddy-daily'
    const ROUTE = {
      status: '/plugins/dsh-workbuddy-daily/status',
      run: '/plugins/dsh-workbuddy-daily/run',
    }
    const CARD_ID = 'dsh-workbuddy-daily-card'
    const STYLE_TAG_ID = 'dsh-workbuddy-daily/card.css'
    const POLL_MS = 20000

    //#region locale
    const DICT_ZH = {
      'card.title': 'WorkBuddy 每日积分',
      'card.summary': '启动时后台自动签到并领取已达成的任务奖励',
      'state.signedIn': '已登录',
      'state.signedOut': '未登录',
      'state.running': '正在执行',
      'state.doneToday': '今日已完成',
      'state.pending': '今日待执行',
      'action.run': '立即执行',
      'section.today': '今日',
      'today.ran': '今日已执行',
      'today.notRan': '今日尚未执行',
      'today.nextSweep': '下次启动会扫描任务',
      'today.nextSkip': '下次启动只查签到状态（任务已扫过）',
      'today.claimedTasks': '今日已领取任务',
      'section.lastRun': '上次执行',
      'lastRun.none': '本次进程尚未执行',
      'lastRun.summary.claimed': '已领取奖励',
      'lastRun.summary.acted': '已执行',
      'lastRun.summary.nothing-to-do': '无事可做',
      'lastRun.summary.partial': '部分成功',
      'lastRun.summary.failed': '失败',
      'lastRun.summary.no-credentials': '未登录账号',
      'lastRun.summary.unknown': '未知',
      'row.checkin': '签到',
      'row.tasks': '任务',
      'row.travel': '猫猫旅行',
      'row.streak': '连登',
      'row.duration': '耗时',
      'row.credits': '本次获得',
      'travel.collected': '已收取 +{credit}（{location}）',
      'travel.departed': '已派出（{hours} 小时后可收）',
      'travel.travelling': '旅行中，尚未返回',
      'travel.limit': '今日已达上限',
      'travel.claimedToday': '今日已收 {credit}',
      'travel.skipped': '跳过：{reason}',
      'travel.failed': '失败：{error}',
      'streak.redeemed': '已兑换 {tier}（+{credit}）',
      'streak.next': '连登 {days} 天，还差 {remaining} 天到 {tier}',
      'streak.claimedAll': '连登 {days} 天，当前档位已领',
      'streak.skipped': '跳过：{reason}',
      'streak.failed': '失败：{error}',
      'checkin.checkedIn': '今日已签到（连签 {days} 天）',
      'checkin.claimedNow': '本次已签到（连签 {days} 天，+{credit}）',
      'checkin.skipped': '跳过：{reason}',
      'checkin.failed': '失败：{error}',
      'tasks.claimedCount': '领取 {count} 个，共 +{credit}',
      'tasks.noneReady': '无可领取任务',
      'tasks.skipped': '跳过：{reason}',
      'tasks.failed': '失败：{error}',
      'section.config': '设置',
      'config.hint': '在「插件配置」里可关闭签到或任务扫描。',
      'unit.credits': '积分',
      'unit.ms': 'ms',
      'unit.seconds': '秒',
    }
    const DICT_EN = {
      'card.title': 'WorkBuddy daily credits',
      'card.summary': 'Claims the daily check-in and any ready task rewards in the background on launch',
      'state.signedIn': 'Signed in',
      'state.signedOut': 'Signed out',
      'state.running': 'Running',
      'state.doneToday': 'Done today',
      'state.pending': 'Pending today',
      'action.run': 'Run now',
      'section.today': 'Today',
      'today.ran': 'Ran today',
      'today.notRan': 'Not run today',
      'today.nextSweep': 'Next launch will sweep tasks',
      'today.nextSkip': 'Next launch checks status only (tasks already swept)',
      'today.claimedTasks': 'Tasks claimed today',
      'section.lastRun': 'Last run',
      'lastRun.none': 'Not run in this process',
      'lastRun.summary.claimed': 'Rewards claimed',
      'lastRun.summary.acted': 'Acted',
      'lastRun.summary.nothing-to-do': 'Nothing to do',
      'lastRun.summary.partial': 'Partly succeeded',
      'lastRun.summary.failed': 'Failed',
      'lastRun.summary.no-credentials': 'No signed-in account',
      'lastRun.summary.unknown': 'Unknown',
      'row.checkin': 'Check-in',
      'row.tasks': 'Tasks',
      'row.travel': 'Cat travel',
      'row.streak': 'Streak',
      'row.duration': 'Took',
      'row.credits': 'Earned',
      'travel.collected': 'Collected +{credit} ({location})',
      'travel.departed': 'Sent out (back in {hours}h)',
      'travel.travelling': 'Travelling, not back yet',
      'travel.limit': 'Daily limit reached',
      'travel.claimedToday': 'Collected {credit} today',
      'travel.skipped': 'Skipped: {reason}',
      'travel.failed': 'Failed: {error}',
      'streak.redeemed': 'Redeemed {tier} (+{credit})',
      'streak.next': 'Streak {days}d, {remaining}d to {tier}',
      'streak.claimedAll': 'Streak {days}d, current tier claimed',
      'streak.skipped': 'Skipped: {reason}',
      'streak.failed': 'Failed: {error}',
      'checkin.checkedIn': 'Already checked in (streak {days})',
      'checkin.claimedNow': 'Checked in just now (streak {days}, +{credit})',
      'checkin.skipped': 'Skipped: {reason}',
      'checkin.failed': 'Failed: {error}',
      'tasks.claimedCount': 'Claimed {count} (+{credit})',
      'tasks.noneReady': 'No reward ready',
      'tasks.skipped': 'Skipped: {reason}',
      'tasks.failed': 'Failed: {error}',
      'section.config': 'Settings',
      'config.hint': 'Check-in or the task sweep can be disabled under Plugin configuration.',
      'unit.credits': 'credits',
      'unit.ms': 'ms',
      'unit.seconds': 's',
    }
    //#endregion

    //#region helpers
    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /** Fill `{name}` placeholders; missing values become a dash. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => {
        const value = values?.[key]
        return value === undefined || value === null ? '—' : String(value)
      })
    }

    async function getJson(path, init) {
      try {
        const response = await fetch(path, {
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { accept: 'application/json' },
          ...init,
        })
        if (!response.ok) return { ok: false, error: 'http-' + response.status }
        return await response.json()
      } catch (error) {
        return { ok: false, error: String(error?.message ?? error) }
      }
    }
    //#endregion

    //#region styles
    function injectStyle() {
      try {
        if (typeof document === 'undefined') return
        if (document.querySelector('style[data-plugin-css="' + STYLE_TAG_ID + '"]') !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-workbuddy-daily'
        tag.dataset.pluginCss = STYLE_TAG_ID
        tag.textContent = [
          '.dshwd-root{display:flex;flex-direction:column;gap:12px;font-size:var(--dsh-content-font-size-secondary,13px);color:var(--dsw-alias-label-secondary,currentColor)}',
          '.dshwd-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
          '.dshwd-title{font-weight:600;color:var(--dsw-alias-label-primary,currentColor)}',
          '.dshwd-pill{flex:none;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,currentColor);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);line-height:1.6}',
          '.dshwd-pill[data-tone="ok"]{color:var(--dsw-alias-label-success,currentColor)}',
          '.dshwd-pill[data-tone="muted"]{color:var(--dsw-alias-label-tertiary,currentColor)}',
          '.dshwd-pill[data-tone="warn"]{color:var(--dsw-alias-label-warning,currentColor)}',
          '.dshwd-actions{margin-left:auto}',
          '.dshwd-btn{appearance:none;cursor:pointer;padding:2px 9px;border-radius:var(--dsw-radius-sm,4px);border:.5px solid var(--dsw-alias-border-l2,currentColor);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}',
          '.dshwd-btn:hover{background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.12))}',
          '.dshwd-btn:disabled{opacity:.5;cursor:default}',
          '.dshwd-section{display:flex;flex-direction:column;gap:5px}',
          '.dshwd-sec-title{font-weight:600;color:var(--dsw-alias-label-primary,currentColor);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px)}',
          '.dshwd-row{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
          '.dshwd-key{min-width:84px;color:var(--dsw-alias-label-tertiary,currentColor)}',
          '.dshwd-val{color:var(--dsw-alias-label-secondary,currentColor)}',
          '.dshwd-good{color:var(--dsw-alias-label-success,currentColor)}',
          '.dshwd-warn{color:var(--dsw-alias-label-warning,currentColor)}',
          '.dshwd-note{color:var(--dsw-alias-label-tertiary,currentColor);line-height:1.6}',
          '.dshwd-mono{font-family:var(--dsh-font-mono,ui-monospace,monospace);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px)}',
          '@media (prefers-reduced-motion:reduce){.dshwd-root *{transition:none!important;animation:none!important}}',
        ].join('')
        document.head.appendChild(tag)
      } catch { /* cosmetic only */ }
    }
    //#endregion

    //#region components
    function Row({ label, children }) {
      return jsx.jsxs('div', { className: 'dshwd-row', children: [
        jsx.jsx('span', { className: 'dshwd-key', children: label }, 'k'),
        jsx.jsx('span', { className: 'dshwd-val', children }, 'v'),
      ] }, label)
    }

    /** What the plugin did in this process. */
    function LastRunSection({ status, tr }) {
      const run = status?.lastRun
      if (run === null || run === undefined) {
        return jsx.jsx('div', { className: 'dshwd-note', children: tr('lastRun.none') })
      }
      const summaryKey = 'lastRun.summary.' + (run.summary ?? 'unknown')
      const summaryText = tr(summaryKey)
      const hasErrors = Array.isArray(run.errors) && run.errors.length > 0

      const rows = []

      // check-in
      const checkin = run.checkin
      const checkinAction = Array.isArray(run.actions) ? run.actions.find((a) => a.step === 'checkin') : undefined
      const checkinSkip = Array.isArray(run.skipped) ? run.skipped.find((s) => s.step === 'checkin') : undefined
      const checkinError = Array.isArray(run.errors) ? run.errors.find((e) => e.step?.startsWith('checkin')) : undefined
      let checkinText
      if (checkinAction !== undefined) {
        checkinText = jsx.jsx('span', {
          className: 'dshwd-good',
          children: fill(tr('checkin.claimedNow'), { days: checkinAction.streakDays, credit: checkinAction.credit }),
        })
      } else if (checkinError !== undefined) {
        checkinText = jsx.jsx('span', { className: 'dshwd-warn', children: fill(tr('checkin.failed'), { error: checkinError.error }) })
      } else if (checkinSkip !== undefined) {
        checkinText = jsx.jsx('span', { className: 'dshwd-note', children: fill(tr('checkin.skipped'), { reason: checkinSkip.reason }) })
      } else if (checkin !== null && checkin !== undefined) {
        checkinText = jsx.jsx('span', { children: fill(tr('checkin.checkedIn'), { days: checkin.streakDays }) })
      } else {
        checkinText = jsx.jsx('span', { className: 'dshwd-note', children: '—' })
      }
      rows.push(jsx.jsx(Row, { label: tr('row.checkin'), children: checkinText }, 'checkin'))

      // tasks
      const taskError = Array.isArray(run.errors) ? run.errors.find((e) => e.step?.startsWith('task')) : undefined
      const taskSkip = Array.isArray(run.skipped) ? run.skipped.find((s) => s.step === 'tasks') : undefined
      const claimedCount = run.tasks?.claimed ?? 0
      const credited = run.tasks?.credited ?? 0
      let taskText
      if (claimedCount > 0) {
        taskText = jsx.jsx('span', {
          className: 'dshwd-good',
          children: fill(tr('tasks.claimedCount'), { count: claimedCount, credit: credited }),
        })
      } else if (taskError !== undefined) {
        taskText = jsx.jsx('span', { className: 'dshwd-warn', children: fill(tr('tasks.failed'), { error: taskError.error }) })
      } else if (taskSkip !== undefined) {
        taskText = jsx.jsx('span', { className: 'dshwd-note', children: fill(tr('tasks.skipped'), { reason: taskSkip.reason }) })
      } else {
        taskText = jsx.jsx('span', { className: 'dshwd-note', children: tr('tasks.noneReady') })
      }
      rows.push(jsx.jsx(Row, { label: tr('row.tasks'), children: taskText }, 'tasks'))

      // travel: collect / depart / travelling are different outcomes and read
      // differently, so they get distinct copy instead of one generic line.
      const travelAction = Array.isArray(run.actions) ? run.actions.find((a) => a.step === 'travel') : undefined
      const travelDepart = Array.isArray(run.actions) ? run.actions.find((a) => a.step === 'travel-depart') : undefined
      const travelError = Array.isArray(run.errors) ? run.errors.find((e) => e.step?.startsWith('travel')) : undefined
      const travelSkip = Array.isArray(run.skipped) ? run.skipped.find((s) => s.step === 'travel') : undefined
      if (run.travel !== null && run.travel !== undefined) {
        let travelText
        if (travelAction !== undefined) {
          travelText = jsx.jsx('span', {
            className: 'dshwd-good',
            children: fill(tr('travel.collected'), { credit: travelAction.credit, location: travelAction.locationName }),
          })
        } else if (travelDepart !== undefined) {
          travelText = jsx.jsx('span', { className: 'dshwd-note', children: fill(tr('travel.departed'), { hours: run.travel.durationHours ?? 4 }) })
        } else if (travelError !== undefined) {
          travelText = jsx.jsx('span', { className: 'dshwd-warn', children: fill(tr('travel.failed'), { error: travelError.error }) })
        } else if (travelSkip !== undefined) {
          travelText = jsx.jsx('span', { className: 'dshwd-note', children: fill(tr('travel.skipped'), { reason: travelSkip.reason }) })
        } else {
          travelText = jsx.jsx('span', { className: 'dshwd-note', children: tr('travel.travelling') })
        }
        rows.push(jsx.jsx(Row, { label: tr('row.travel'), children: travelText }, 'travel'))
      }

      // streak: show what was redeemed, or how far the next tier is.
      const streakActions = Array.isArray(run.actions) ? run.actions.filter((a) => a.step === 'streak') : []
      const streakError = Array.isArray(run.errors) ? run.errors.find((e) => e.step?.startsWith('streak')) : undefined
      if (run.streak !== null && run.streak !== undefined) {
        let streakText
        if (streakActions.length > 0) {
          streakText = jsx.jsx('span', {
            className: 'dshwd-good',
            children: streakActions.map((a) => fill(tr('streak.redeemed'), { tier: a.tier, credit: a.credit })).join(' · '),
          })
        } else if (streakError !== undefined) {
          streakText = jsx.jsx('span', { className: 'dshwd-warn', children: fill(tr('streak.failed'), { error: streakError.error }) })
        } else if (run.streak.nextTier !== '') {
          streakText = jsx.jsx('span', {
            className: 'dshwd-note',
            children: fill(tr('streak.next'), {
              days: run.streak.days,
              remaining: run.streak.nextTierRemaining,
              tier: run.streak.nextTier,
            }),
          })
        } else {
          streakText = jsx.jsx('span', { className: 'dshwd-note', children: fill(tr('streak.claimedAll'), { days: run.streak.days }) })
        }
        rows.push(jsx.jsx(Row, { label: tr('row.streak'), children: streakText }, 'streak'))
      }

      if (isFiniteNumber(run.durationMs)) {
        rows.push(jsx.jsx(Row, {
          label: tr('row.duration'),
          children: jsx.jsx('span', { className: 'dshwd-note', children: run.durationMs + ' ' + tr('unit.ms') }),
        }, 'duration'))
      }

      return jsx.jsxs('div', { className: 'dshwd-section', children: [
        jsx.jsx('div', { className: 'dshwd-row', children: [
          jsx.jsx('span', { className: 'dshwd-sec-title', children: tr('section.lastRun') }, 't'),
          jsx.jsx('span', {
            className: 'dshwd-pill',
            'data-tone': hasErrors ? 'warn' : (run.actions?.length > 0 ? 'ok' : 'muted'),
            children: summaryText,
          }, 's'),
        ] }, 'head'),
        ...rows,
      ] })
    }

    /** The card. */
    function DailyCard(props) {
      const tr = props?.t ?? ((key) => key)
      const [status, setStatus] = react.useState(null)
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(null)

      const load = react.useCallback(async () => {
        const answer = await getJson(ROUTE.status)
        if (answer !== null && typeof answer === 'object' && answer.ok === true) {
          setStatus(answer)
          setError(null)
        } else {
          setError(String(answer?.error ?? 'status-unavailable'))
        }
      }, [])

      react.useEffect(() => {
        let alive = true
        const tick = () => { if (alive) void load() }
        tick()
        const timer = setInterval(tick, POLL_MS)
        return () => { alive = false; clearInterval(timer) }
      }, [load])

      const runNow = async () => {
        if (busy) return
        setBusy(true)
        await getJson(ROUTE.run, { method: 'POST' })
        // The run is detached on the host; give it a moment, then refresh.
        setTimeout(() => { void load(); setBusy(false) }, 2500)
      }

      if (status === null) {
        return jsx.jsx('div', { className: 'dshwd-root', children: jsx.jsx('div', { className: 'dshwd-note', children: error ?? '…' }) })
      }

      const signedIn = status.credentials?.signedIn === true
      const running = status.running === true
      const ranToday = status.today?.ranToday === true
      const pill = running
        ? { tone: 'muted', text: tr('state.running') }
        : !signedIn
          ? { tone: 'warn', text: tr('state.signedOut') }
          : ranToday
            ? { tone: 'ok', text: tr('state.doneToday') }
            : { tone: 'muted', text: tr('state.pending') }

      return jsx.jsxs('div', { className: 'dshwd-root', children: [
        jsx.jsxs('div', { className: 'dshwd-head', children: [
          jsx.jsx('span', { className: 'dshwd-title', children: tr('card.title') }, 'title'),
          jsx.jsx('span', { className: 'dshwd-pill', 'data-tone': pill.tone, children: pill.text }, 'pill'),
          jsx.jsxs('span', { className: 'dshwd-actions', children: [
            jsx.jsx('button', {
              className: 'dshwd-btn',
              onClick: runNow,
              disabled: busy || running || !signedIn || status.enabled === false,
              children: tr('action.run'),
            }, 'run'),
          ] }, 'actions'),
        ] }, 'head'),

        jsx.jsxs('div', { className: 'dshwd-section', children: [
          jsx.jsx('div', { className: 'dshwd-sec-title', children: tr('section.today') }, 't'),
          jsx.jsx('div', { className: 'dshwd-row', children: [
            jsx.jsx('span', { className: 'dshwd-key', children: ranToday ? tr('today.ran') : tr('today.notRan') }, 'k'),
            jsx.jsx('span', {
              className: 'dshwd-note',
              children: status.today?.nextLaunchWouldSweepTasks === true ? tr('today.nextSweep') : tr('today.nextSkip'),
            }, 'v'),
          ] }, 'r'),
          isFiniteNumber(status.today?.claimedTaskCount) && status.today.claimedTaskCount > 0
            ? jsx.jsx(Row, { label: tr('today.claimedTasks'), children: String(status.today.claimedTaskCount) })
            : null,
        ] }, 'today'),

        jsx.jsx(LastRunSection, { status, tr }, 'last'),

        jsx.jsx('div', { className: 'dshwd-note', children: tr('config.hint') }, 'hint'),

        error === null ? null : jsx.jsx('div', { className: 'dshwd-warn', children: error }, 'err'),
      ] })
    }
    //#endregion

    //#region apply
    function apply(ctx) {
      try { injectStyle() } catch { /* cosmetic only */ }

      let bound
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-workbuddy-daily: dictionaries')
        bound = ctx.locale.bind(NS)
      } catch {
        bound = undefined
      }
      const t = typeof bound === 'function' ? bound : ((key) => key)

      for (const slotName of ['plugins.bundle.config', 'plugins.row.config', 'plugins.item']) {
        try {
          ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName,
            id: CARD_ID,
            key: 'dsh-workbuddy-daily',
            locale: NS,
            order: 30,
            inject: () => ({ t }),
          }, DailyCard))
        } catch { /* that ledger is not declared on this host */ }
      }
    }
    //#endregion

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.name = 'dsh-workbuddy-daily-client'
    exports.DailyCard = DailyCard
    return exports
  },
})
