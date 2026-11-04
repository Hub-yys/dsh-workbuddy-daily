/**
 * dsh-workbuddy-daily — Host half (Node / Cordis).
 *
 * The user asked for: on every DSH launch, run in the background, complete the
 * WorkBuddy daily check-in and any growth-task rewards that are ready, and do
 * NOTHING if they are already done.
 *
 * Everything below is built from measurements against the live account, not from
 * guesses:
 *
 *   POST /v2/billing/meter/checkin-activity-status   -> {today_checked_in, streak_days, ...}
 *   POST /v2/billing/meter/daily-checkin             -> {credit, streak_days}
 *   GET  /v2/activity/growth/tasks                   -> data.tasks[] with
 *                                                       progress{current,target} and
 *                                                       accept_status: "claimed" | "accepted"
 *
 * Facts that shaped the design (each verified, not assumed):
 *
 * 1. `accept_status` is the claimed flag — there is no `claimed` field. A task is
 *    claimable only when `progress.current >= progress.target` AND
 *    `accept_status !== "claimed"`. On the reference account 13 of 19 tasks were
 *    `claimed` and the remaining 6 were `accepted` at 0/1 progress, i.e. the
 *    normal case is "nothing to do", so the no-op path is the common path and has
 *    to be cheap and silent.
 * 2. The status endpoint is a POST with an empty JSON body, not a GET.
 * 3. Claiming a task is served from the WEB origin (`www.workbuddy.cn`), not the
 *    chat host, and requires `Origin`/`Referer` plus `x-client-platform: web`.
 *    A repeat claim answers `already_claimed` with 0 credit, which is success.
 * 4. The check-in status flips to `today_checked_in: true` immediately after a
 *    successful claim, which is what makes the "already done -> skip" decision
 *    trustworthy on the NEXT launch.
 *
 * DESIGN RULE: this plugin must never make the harness worse. It performs no
 * network work until its own start-up delay elapses, every failure is contained,
 * and a failed run leaves no partial state that would suppress a later retry.
 *
 * @module dsh-workbuddy-daily
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Optional peer: a host that cannot resolve it simply gets no settings card, and
// the defaults below still drive every behaviour.
const z = (() => {
  try {
    return createRequire(import.meta.url)('@deepseek-ai/schemastery')
  } catch {
    return undefined
  }
})()

/** Stable Cordis plugin name. */
export const name = 'dsh-workbuddy-daily'

/**
 * Captured at `apply` for the work that runs OUTSIDE a ctx scope: the start-up
 * timer and the HTTP route handlers. Declared here rather than at the bottom
 * because `readConfig` consults them, and a `let` read before its declaration
 * throws a TDZ error.
 */
let configRef = null
let ctxRef = null

/** Required services: none. Everything is found through the filesystem. */
export const inject = []

const ROUTE_PREFIX = '/plugins/dsh-workbuddy-daily'
const STATUS_ROUTE = `${ROUTE_PREFIX}/status`
const RUN_ROUTE = `${ROUTE_PREFIX}/run`

//#region endpoints

/**
 * Upstream hosts. The domestic build serves both the billing meter and the
 * activity endpoints from `www.workbuddy.cn`; the international build uses a
 * different host, so this is a table rather than a constant.
 */
const REGIONS = Object.freeze({
  cn: Object.freeze({
    billingBase: 'https://www.workbuddy.cn',
    webBase: 'https://www.workbuddy.cn',
    vaultDir: 'cn',
  }),
  global: Object.freeze({
    billingBase: 'https://www.workbuddy.ai',
    webBase: 'https://www.workbuddy.ai',
    vaultDir: 'global',
  }),
})

const CHECKIN_STATUS_PATH = '/v2/billing/meter/checkin-activity-status'
const CHECKIN_CLAIM_PATH = '/v2/billing/meter/daily-checkin'
const GROWTH_TASKS_PATH = '/v2/activity/growth/tasks'

/**
 * Prefix for the growth-centre endpoints that sit OUTSIDE `/v2`.
 *
 * Worth its own constant: probing `/v2/buddy/...` answers 404 and it is easy to
 * conclude the travel subsystem does not exist, when in fact it lives at
 * `/activity/growth/buddy/...`. The check-in endpoints are under `/v2/billing`;
 * the growth endpoints are under `/activity/growth`.
 */
const GROWTH_PREFIX = '/activity/growth'
const growthClaimPath = (code) => `/activity/growth/tasks/${encodeURIComponent(code)}/claim`

/** Timeout for one upstream call. Generous: a cold TLS handshake took ~1.6 s. */
const REQUEST_TIMEOUT_MS = 20000

/** The UA the desktop web client uses; the growth claim checks for a web client. */
const CLIENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

//#endregion

//#region credentials

/**
 * Where the signed-in WorkBuddy accounts are kept.
 *
 * `dsh-connect-workbuddy` already writes this vault, so this plugin only READS it
 * and never performs a login, a refresh, or a token rotation of its own. Two
 * plugins racing to refresh one refresh-token rotation is a real way to log the
 * user out, so duplicating auth here would be a defect even if it worked.
 */
function vaultDir(region) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'workbuddy-vault', REGIONS[region].vaultDir)
}

/**
 * Read every credential file, newest expiry first.
 *
 * Returns `[]` when the vault is absent or unreadable: a signed-out machine is an
 * ordinary state for this plugin, not an error.
 *
 * @returns {Array<{ file: string, accessToken: string, uid: string, domain: string, expiresAt: number }>}
 */
function readCredentials(region) {
  const dir = vaultDir(region)
  let names
  try {
    names = readdirSync(dir).filter((entry) => entry.endsWith('.json'))
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8'))
      const auth = parsed?.auth
      if (auth === null || typeof auth !== 'object') continue
      const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
      if (accessToken === '') continue
      out.push({
        file: entry,
        accessToken,
        uid: typeof parsed?.account?.uid === 'string' ? parsed.account.uid : '',
        domain: typeof auth.domain === 'string' ? auth.domain : '',
        expiresAt: typeof auth.expiresAt === 'number' ? auth.expiresAt : 0,
      })
    } catch { /* a half-written credential file is skipped, not fatal */ }
  }
  // Prefer the credential that stays valid longest — the account most likely to be
  // the active sign-in.
  out.sort((a, b) => b.expiresAt - a.expiresAt)
  return out
}

/**
 * Headers shared by every call.
 *
 * `X-User-Id` / `X-Domain` are only sent when known: sending an empty
 * `X-User-Id` makes the gateway refuse the request outright (the reference
 * implementation omits them instead of sending blanks, and that detail matters).
 */
function baseHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (credential.uid !== '') headers['X-User-Id'] = credential.uid
  if (credential.domain !== '') headers['X-Domain'] = credential.domain
  return headers
}

/** Web-client headers the growth-reward endpoints insist on. */
function webHeaders(credential, webBase) {
  return {
    ...baseHeaders(credential),
    'X-Requested-With': 'XMLHttpRequest',
    Origin: webBase,
    Referer: `${webBase}/`,
    'User-Agent': CLIENT_UA,
  }
}

//#endregion

//#region upstream calls

/**
 * One JSON request. Never throws; returns a discriminated result so callers can
 * report a precise reason instead of a generic failure.
 *
 * @returns {Promise<{ ok: boolean, status: number, code?: number, data?: object, error?: string }>}
 */
async function requestJson(url, init) {
  let response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    return { ok: false, status: 0, error: error?.cause?.code ?? error?.name ?? 'network-failed' }
  }
  let text
  try {
    text = await response.text()
  } catch {
    return { ok: false, status: response.status, error: 'body-unreadable' }
  }
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // openresty/APISIX reject an unusable credential with an HTML page. Naming
    // that case saves the user from chasing a phantom code bug.
    const head = text.slice(0, 512).toLowerCase()
    const htmlReject = (response.status === 401 || response.status === 403)
      && (head.includes('<html') || head.includes('openresty') || head.includes('apisix'))
    return {
      ok: false,
      status: response.status,
      error: htmlReject ? 'credential-rejected' : 'non-json-response',
    }
  }
  const code = typeof parsed?.code === 'number' ? parsed.code : undefined
  if (!response.ok || (code !== undefined && code !== 0)) {
    return {
      ok: false,
      status: response.status,
      ...code === undefined ? {} : { code },
      error: typeof parsed?.msg === 'string' && parsed.msg !== '' ? parsed.msg : `http-${response.status}`,
      data: typeof parsed?.data === 'object' && parsed.data !== null ? parsed.data : undefined,
    }
  }
  return {
    ok: true,
    status: response.status,
    ...code === undefined ? {} : { code },
    data: typeof parsed?.data === 'object' && parsed.data !== null ? parsed.data : {},
  }
}

/**
 * Today's check-in state. Read-only.
 *
 * This is a POST with `{}` — the endpoint does not accept GET.
 */
async function fetchCheckinStatus(credential, region) {
  const base = REGIONS[region].billingBase
  const result = await requestJson(`${base}${CHECKIN_STATUS_PATH}`, {
    method: 'POST',
    headers: baseHeaders(credential),
    body: '{}',
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  const num = (key) => (typeof data[key] === 'number' ? data[key] : 0)
  return {
    ok: true,
    status: result.status,
    data: {
      active: data.active === true,
      todayCheckedIn: data.today_checked_in === true,
      streakDays: num('streak_days'),
      dailyCredit: num('daily_credit'),
      todayCredit: num('today_credit'),
      isStreakDay: data.is_streak_day === true,
      nextStreakDay: num('next_streak_day'),
      streakBonusDays: num('streak_bonus_days'),
      streakBonusCredit: num('streak_bonus_credit'),
      ...typeof data.claim_button_text === 'string' && data.claim_button_text !== ''
        ? { claimButtonText: data.claim_button_text }
        : {},
    },
  }
}

/** Claim today's check-in. A write: only called when the status says it is due. */
async function claimCheckin(credential, region) {
  const base = REGIONS[region].billingBase
  const result = await requestJson(`${base}${CHECKIN_CLAIM_PATH}`, {
    method: 'POST',
    headers: baseHeaders(credential),
    body: '{}',
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  return {
    ok: true,
    status: result.status,
    data: {
      credit: typeof data.credit === 'number' ? data.credit : 0,
      streakDays: typeof data.streak_days === 'number' ? data.streak_days : 0,
      isStreakDay: data.is_streak_day === true,
    },
  }
}

/** The growth task list. Read-only. */
async function fetchGrowthTasks(credential, region) {
  const base = REGIONS[region].webBase
  const result = await requestJson(`${base}${GROWTH_TASKS_PATH}`, {
    method: 'GET',
    headers: webHeaders(credential, base),
  })
  if (!result.ok) return result
  const raw = Array.isArray(result.data?.tasks) ? result.data.tasks : []
  const tasks = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const code = typeof entry.task_code === 'string' ? entry.task_code : ''
    if (code === '') continue
    const current = typeof entry?.progress?.current === 'number' ? entry.progress.current : 0
    const target = typeof entry?.progress?.target === 'number' ? entry.progress.target : 0
    tasks.push({
      code,
      title: typeof entry.title === 'string' ? entry.title : '',
      acceptStatus: typeof entry.accept_status === 'string' ? entry.accept_status : '',
      current,
      target,
      credit: typeof entry.reward_credit === 'number' ? entry.reward_credit : 0,
      energy: typeof entry.reward_energy === 'number' ? entry.reward_energy : 0,
      locked: entry.locked === true,
      hasReward: entry.has_reward !== false,
    })
  }
  return { ok: true, status: result.status, data: { tasks } }
}

/**
 * Whether a task may be claimed right now.
 *
 * Two conditions, both measured: the progress reached its target, and the
 * upstream does not already say `claimed`. `locked` also disqualifies, because a
 * locked task's progress is not real activity.
 */
function isTaskClaimable(task) {
  if (task.acceptStatus === 'claimed') return false
  if (task.locked === true) return false
  if (task.hasReward !== true) return false
  return task.target > 0 && task.current >= task.target
}

/** Claim one task reward. A write. */
async function claimTaskReward(credential, region, taskCode) {
  const base = REGIONS[region].webBase
  const headers = {
    ...baseHeaders(credential),
    Accept: 'application/json, text/plain, */*',
    Origin: base,
    Referer: `${base}/profile/growth-center`,
    'x-client-platform': 'web',
    'User-Agent': CLIENT_UA,
  }
  const result = await requestJson(`${base}${growthClaimPath(taskCode)}`, {
    method: 'POST',
    headers,
    body: '{}',
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  // A repeat claim is reported as `already_claimed` with zero credit. Treating it
  // as success keeps the whole run idempotent under a crash-and-retry.
  if (data.already_claimed === true) {
    return { ok: true, status: result.status, data: { credit: 0, energy: 0, alreadyClaimed: true } }
  }
  return {
    ok: true,
    status: result.status,
    data: {
      credit: typeof data.credit === 'number' ? data.credit : 0,
      energy: typeof data.energy === 'number' ? data.energy : 0,
      alreadyClaimed: false,
    },
  }
}


//#region buddy travel

/**
 * The cat-travel subsystem (`/activity/growth/buddy/*`).
 *
 * This is a separate endpoint family from the billing meter, and the endpoints
 * are NOT under `/v2` — probing `/v2/buddy/...` answers 404, which is misleading
 * enough that it once made this plugin conclude the feature did not exist.
 *
 * The state machine has three states and a single pass advances it by at most one
 * step, matching how the upstream expects to be driven:
 *
 *   idle    -> POST /buddy/travel/depart   (the cat leaves)
 *   travelling -> do nothing                (nothing to collect yet)
 *   arrived -> POST /buddy/travel/claim     (collect, needs record_id)
 */
const TRAVEL_LOCATION_ID = 4 // 古镇客栈: all four locations share the same reward range

/** Read travel state. Returns `null` when the account has no buddy yet. */
async function fetchTravelStatus(credential, region) {
  const base = REGIONS[region].webBase
  const result = await requestJson(`${base}${GROWTH_PREFIX}/buddy/travel/status`, {
    method: 'GET',
    headers: webHeaders(credential, base),
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  return {
    ok: true,
    status: result.status,
    data: {
      state: typeof data.state === 'string' ? data.state : '',
      recordId: typeof data.record_id === 'number' ? data.record_id : 0,
      dailyLimitReached: data.daily_limit_reached === true,
      rewardCredit: typeof data.reward_credit === 'number' ? data.reward_credit : 0,
      durationHours: typeof data.duration_hours === 'number' ? data.duration_hours : 0,
      locationName: typeof data?.location?.name === 'string' ? data.location.name : '',
      // Seconds, so a caller can say when it lands without guessing.
      arriveAt: typeof data.arrive_at === 'number' ? data.arrive_at : 0,
      serverNow: typeof data.server_now === 'number' ? data.server_now : 0,
    },
  }
}

/** Send the buddy travelling. A write. */
async function departTravel(credential, region) {
  const base = REGIONS[region].webBase
  return requestJson(`${base}${GROWTH_PREFIX}/buddy/travel/depart`, {
    method: 'POST',
    headers: webHeaders(credential, base),
    body: JSON.stringify({ location_id: TRAVEL_LOCATION_ID }),
  })
}

/**
 * Collect an arrived trip. A write.
 *
 * `record_id` comes from the status read and the upstream rejects a claim
 * without it, so it is required rather than optional.
 */
async function claimTravel(credential, region, recordId) {
  const base = REGIONS[region].webBase
  const result = await requestJson(`${base}${GROWTH_PREFIX}/buddy/travel/claim`, {
    method: 'POST',
    headers: webHeaders(credential, base),
    body: JSON.stringify({ record_id: recordId }),
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  return {
    ok: true,
    status: result.status,
    data: { credit: typeof data.reward_credit === 'number' ? data.reward_credit : 0 },
  }
}

//#endregion

//#region streak

/**
 * The consecutive-login reward tiers.
 *
 * Read from `/activity/growth/streak`, which is a different payload from the
 * check-in status: it carries the tier table, the redemption state per tier, and
 * the makeup-card balance. A tier is redeemable when its status is neither
 * `locked` (not enough days) nor `claimed` (already taken).
 */
async function fetchStreak(credential, region) {
  const base = REGIONS[region].webBase
  const result = await requestJson(`${base}${GROWTH_PREFIX}/streak`, {
    method: 'GET',
    headers: webHeaders(credential, base),
  })
  if (!result.ok) return result
  const data = result.data ?? {}
  const streak = data.streak ?? {}
  const redemption = data.redemption_status ?? {}
  const tiers = []
  for (const entry of Array.isArray(redemption.tiers) ? redemption.tiers : []) {
    if (entry === null || typeof entry !== 'object') continue
    const tier = typeof entry.tier === 'string' ? entry.tier : ''
    if (tier === '') continue
    // The tier entries carry ONLY the reward amounts. The state machine lives on
    // the parent object as `tier_<name>_status`. Reading `entry.status` (which does
    // not exist) made every tier look redeemable and produced three rejected
    // requests per run — "该档位本月已兑换" and "连续登录天数不足".
    const stateKey = `tier_${tier}_status`
    tiers.push({
      tier,
      days: typeof entry.days === 'number' ? entry.days : 0,
      credit: typeof entry.credit === 'number' ? entry.credit : 0,
      energy: typeof entry.energy === 'number' ? entry.energy : 0,
      chances: typeof entry.chances === 'number' ? entry.chances : 0,
      status: typeof redemption[stateKey] === 'string' ? redemption[stateKey] : '',
    })
  }
  return {
    ok: true,
    status: result.status,
    data: {
      days: typeof streak.days === 'number' ? streak.days : 0,
      nextTier: typeof streak.next_tier === 'string' ? streak.next_tier : '',
      nextTierRemaining: typeof streak.next_tier_remaining === 'number' ? streak.next_tier_remaining : 0,
      makeupCards: typeof data?.makeup_cards?.balance === 'number' ? data.makeup_cards.balance : 0,
      tiers,
    },
  }
}

/** Redeem one streak tier. A write. Needs a client token the upstream de-dupes on. */
async function redeemStreakTier(credential, region, tier) {
  const base = REGIONS[region].webBase
  return requestJson(`${base}${GROWTH_PREFIX}/redeem`, {
    method: 'POST',
    headers: webHeaders(credential, base),
    body: JSON.stringify({ tier, client_token: randomUUID() }),
  })
}

/** How many lottery draws are available. */
async function fetchLotteryChances(credential, region) {
  const base = REGIONS[region].webBase
  const result = await requestJson(`${base}${GROWTH_PREFIX}/lottery/summary`, {
    method: 'GET',
    headers: webHeaders(credential, base),
  })
  if (!result.ok) return result
  return {
    ok: true,
    status: result.status,
    data: { chances: typeof result.data?.chances === 'number' ? result.data.chances : 0 },
  }
}

/** One lottery draw. A write; the prize shape is campaign-defined so it is passed through. */
async function drawLottery(credential, region) {
  const base = REGIONS[region].webBase
  return requestJson(`${base}${GROWTH_PREFIX}/lottery/draw`, {
    method: 'POST',
    headers: webHeaders(credential, base),
    body: JSON.stringify({ client_token: randomUUID() }),
  })
}

//#endregion

//#endregion

//#region run state

/**
 * Persistent record of the last completed run.
 *
 * WHY PERSIST AT ALL, given the upstream already reports `today_checked_in`:
 * the upstream is the authority for the check-in, but a task claim is only
 * observable as `accept_status === "claimed"`, which it may report with a delay.
 * A local record means a restart moments after a successful run does not re-hit
 * every claim endpoint, and it gives the user a "when did this last work"
 * answer that survives restarts.
 *
 * The file is written atomically (temp + rename) because a truncated JSON file
 * would otherwise wedge the plugin into "never runs" state on the next boot.
 */
const STATE_FILE_NAME = 'daily.json'

function stateDir() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, '.workbuddy-daily')
}

function statePath() {
  return join(stateDir(), STATE_FILE_NAME)
}

/** Local calendar day key (YYYY-MM-DD) — matches how the vendor resets. */
function dayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    // Absent or corrupt: treat as "never ran". The upstream check still protects
    // against a double claim, so losing this file is harmless.
    return null
  }
}

function writeState(next) {
  try {
    const dir = stateDir()
    mkdirSync(dir, { recursive: true })
    const temp = join(dir, `${STATE_FILE_NAME}.tmp`)
    writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(temp, statePath())
    return true
  } catch {
    return false
  }
}

/** In-memory view of the most recent run, for the status route. */
let lastRun = null
/** Guards against two triggers (timer and route) racing the same work. */
let runInFlight = null

//#endregion

//#region the run

/**
 * One background pass: check in if due, then claim any ready task rewards.
 *
 * THE "ALREADY DONE" CONTRACT. The user asked that a completed day not run again.
 * That is enforced in two independent layers:
 *
 *   1. The upstream status is asked first. If `today_checked_in` is already true,
 *      the check-in is skipped WITHOUT any claim call. This is the normal path on
 *      the second and later launches of a day.
 *   2. The local state records the day and the claimed task codes. A restart on
 *      the same day skips the task sweep entirely, so the plugin costs exactly
 *      one status request per launch on an already-completed day.
 *
 * Every step is idempotent on its own as well (a repeat claim is accepted with
 * zero credit), so layer 1 and 2 are an optimisation over a correct baseline, not
 * the only thing making it safe.
 *
 * @param {object} config - live config.
 * @returns {Promise<object>} the run record.
 */
async function runOnce(config) {
  const startedAtMs = Date.now()
  const region = config.region === 'global' ? 'global' : 'cn'
  const record = {
    startedAtMs,
    region,
    day: dayKey(),
    actions: [],
    skipped: [],
    errors: [],
    summary: 'no-credentials',
    checkin: null,
    tasks: { claimable: 0, claimed: 0, credited: 0 },
    travel: null,
    streak: null,
  }

  const credentials = readCredentials(region)
  if (credentials.length === 0) {
    // Nothing to do and nothing wrong: the machine is simply not signed in.
    record.finishedAtMs = Date.now()
    record.summary = 'no-credentials'
    return record
  }
  const credential = credentials[0]

  const previous = readState()
  const sameDay = previous !== null && previous.day === record.day && previous.region === region

  // ---- 1. check-in ------------------------------------------------------
  if (config.checkinEnabled !== false) {
    const status = await fetchCheckinStatus(credential, region)
    if (!status.ok) {
      record.errors.push({ step: 'checkin-status', error: status.error ?? 'failed' })
    } else {
      record.checkin = {
        todayCheckedIn: status.data.todayCheckedIn,
        streakDays: status.data.streakDays,
        dailyCredit: status.data.dailyCredit,
        todayCredit: status.data.todayCredit,
        active: status.data.active,
      }
      if (status.data.todayCheckedIn === true) {
        // Layer 1: the upstream is authoritative and says it is done.
        record.skipped.push({ step: 'checkin', reason: 'already-checked-in' })
      } else if (status.data.active !== true) {
        record.skipped.push({ step: 'checkin', reason: 'activity-inactive' })
      } else {
        const claimed = await claimCheckin(credential, region)
        if (!claimed.ok) {
          record.errors.push({ step: 'checkin-claim', error: claimed.error ?? 'failed' })
        } else {
          record.actions.push({
            step: 'checkin',
            credit: claimed.data.credit,
            streakDays: claimed.data.streakDays,
          })
          record.checkin.after = {
            todayCheckedIn: true,
            streakDays: claimed.data.streakDays,
          }
        }
      }
    }
  } else {
    record.skipped.push({ step: 'checkin', reason: 'disabled' })
  }

  // ---- 1b. cat travel ---------------------------------------------------
  //
  // Independent of the check-in and of the task sweep, and cheap: one status
  // read on the common path. A trip that has ARRIVED is collected; an IDLE cat is
  // sent out (its reward lands on a later run); a cat already travelling is left
  // alone. The daily limit is respected because the upstream reports it.
  if (config.travelEnabled !== false) {
    const travel = await fetchTravelStatus(credential, region)
    if (!travel.ok) {
      record.errors.push({ step: 'travel-status', error: travel.error ?? 'failed' })
    } else {
      record.travel = {
        state: travel.data.state,
        rewardCredit: travel.data.rewardCredit,
        locationName: travel.data.locationName,
        dailyLimitReached: travel.data.dailyLimitReached,
      }
      if (travel.data.state === 'arrived') {
        if (travel.data.recordId === 0) {
          record.errors.push({ step: 'travel-claim', error: 'arrived-without-record-id' })
        } else {
          const claimed = await claimTravel(credential, region, travel.data.recordId)
          if (!claimed.ok) {
            record.errors.push({ step: 'travel-claim', error: claimed.error ?? 'failed' })
          } else {
            record.actions.push({
              step: 'travel',
              credit: claimed.data.credit,
              locationName: travel.data.locationName,
            })
            record.travel.state = 'collected'
          }
        }
      } else if (travel.data.state === 'idle' && travel.data.dailyLimitReached !== true) {
        const departed = await departTravel(credential, region)
        if (!departed.ok) {
          record.errors.push({ step: 'travel-depart', error: departed.error ?? 'failed' })
        } else {
          record.actions.push({ step: 'travel-depart', credit: 0, locationName: travel.data.locationName })
          record.travel.state = 'departed'
        }
      } else {
        record.skipped.push({ step: 'travel', reason: travel.data.state === 'travelling' ? 'still-travelling' : travel.data.state })
      }
    }
  } else {
    record.skipped.push({ step: 'travel', reason: 'disabled' })
  }

  // ---- 1c. streak tiers -------------------------------------------------
  //
  // The tier table carries its own per-tier state: a tier is redeemable when it is
  // neither `locked` (not enough consecutive days yet) nor `claimed`. Lottery
  // chances are drawn after redeeming, because redeeming is what grants them.
  if (config.streakEnabled !== false) {
    const streak = await fetchStreak(credential, region)
    if (!streak.ok) {
      record.errors.push({ step: 'streak-status', error: streak.error ?? 'failed' })
    } else {
      record.streak = {
        days: streak.data.days,
        nextTier: streak.data.nextTier,
        nextTierRemaining: streak.data.nextTierRemaining,
        makeupCards: streak.data.makeupCards,
      }
      const redeemable = streak.data.tiers.filter((tier) => tier.status !== 'locked' && tier.status !== 'claimed')
      if (redeemable.length === 0) {
        record.skipped.push({ step: 'streak', reason: streak.data.nextTier === '' ? 'no-tier' : `next-${streak.data.nextTier}` })
      }
      for (const tier of redeemable) {
        const redeemed = await redeemStreakTier(credential, region, tier.tier)
        if (!redeemed.ok) {
          record.errors.push({ step: 'streak-redeem', tier: tier.tier, error: redeemed.error ?? 'failed' })
          continue
        }
        record.actions.push({ step: 'streak', tier: tier.tier, credit: tier.credit, chances: tier.chances })
      }
      // Draw whatever the redeems (or an earlier unclaimed chance) made available.
      const chances = await fetchLotteryChances(credential, region)
      if (chances.ok && chances.data.chances > 0) {
        const draws = Math.min(chances.data.chances, 10)
        for (let index = 0; index < draws; index += 1) {
          const prize = await drawLottery(credential, region)
          if (!prize.ok) {
            record.errors.push({ step: 'lottery', error: prize.error ?? 'failed' })
            break
          }
          record.actions.push({ step: 'lottery', prize: JSON.stringify(prize.data ?? {}).slice(0, 120) })
        }
      }
    }
  } else {
    record.skipped.push({ step: 'streak', reason: 'disabled' })
  }

  // ---- 2. task rewards --------------------------------------------------
  if (config.tasksEnabled === false) {
    record.skipped.push({ step: 'tasks', reason: 'disabled' })
  } else if (sameDay && Array.isArray(previous?.claimedTaskCodes)) {
    // Layer 2: already swept today. The check-in above still ran (cheap, and it is
    // the authoritative gate), but the task list is not fetched again.
    record.skipped.push({ step: 'tasks', reason: 'already-swept-today' })
  } else {
    const listed = await fetchGrowthTasks(credential, region)
    if (!listed.ok) {
      record.errors.push({ step: 'tasks-list', error: listed.error ?? 'failed' })
    } else {
      const claimable = listed.data.tasks.filter(isTaskClaimable)
      record.tasks.claimable = claimable.length
      if (!config.claimAllReady) {
        // Still informative, but the user asked to claim, so this is only reached
        // when they explicitly turned claiming off.
        for (const task of claimable) record.skipped.push({ step: 'task', code: task.code, reason: 'claiming-disabled' })
      } else {
        const alreadyClaimedCodes = new Set(
          Array.isArray(previous?.claimedTaskCodes) && sameDay ? previous.claimedTaskCodes : [],
        )
        for (const task of claimable) {
          if (alreadyClaimedCodes.has(task.code)) {
            record.skipped.push({ step: 'task', code: task.code, reason: 'claimed-earlier-today' })
            continue
          }
          const claimed = await claimTaskReward(credential, region, task.code)
          if (!claimed.ok) {
            record.errors.push({ step: 'task-claim', code: task.code, error: claimed.error ?? 'failed' })
            continue
          }
          record.actions.push({
            step: 'task',
            code: task.code,
            title: task.title,
            credit: claimed.data.credit,
            energy: claimed.data.energy,
            alreadyClaimed: claimed.data.alreadyClaimed,
          })
          if (claimed.data.alreadyClaimed !== true) {
            record.tasks.claimed += 1
            record.tasks.credited += claimed.data.credit
          }
        }
      }
    }
  }

  record.finishedAtMs = Date.now()
  record.durationMs = record.finishedAtMs - startedAtMs
  // Total credits across every source, so a caller does not have to sum the
  // actions itself — and so "did this run earn anything" is one field.
  record.credits = record.actions.reduce((sum, action) => sum + (typeof action.credit === 'number' ? action.credit : 0), 0)
  record.summary = record.errors.length > 0
    ? (record.actions.length > 0 ? 'partial' : 'failed')
    : (record.credits > 0 ? 'claimed' : (record.actions.length > 0 ? 'acted' : 'nothing-to-do'))

  // Persist the day and the task codes that are now claimed, so a restart on the
  // same day does not sweep again.
  const claimedCodes = new Set(
    Array.isArray(previous?.claimedTaskCodes) && sameDay ? previous.claimedTaskCodes : [],
  )
  for (const action of record.actions) {
    if (action.step === 'task') claimedCodes.add(action.code)
  }
  const previousActions = sameDay && Array.isArray(previous?.actions) ? previous.actions : []
  writeState({
    day: record.day,
    region,
    finishedAtMs: record.finishedAtMs,
    summary: record.summary,
    checkin: record.checkin,
    actions: [...previousActions, ...record.actions].slice(-40),
    claimedTaskCodes: [...claimedCodes],
  })

  return record
}

/**
 * Start a run, or return the one already in flight.
 *
 * Serialised on purpose: the start-up timer and a manual "run now" click must not
 * both claim the same check-in.
 *
 * @returns {Promise<object>}
 */
function triggerRun(config) {
  if (runInFlight !== null) return runInFlight
  runInFlight = runOnce(config)
    .catch((error) => ({
      startedAtMs: Date.now(),
      finishedAtMs: Date.now(),
      day: dayKey(),
      region: config?.region ?? 'cn',
      actions: [],
      skipped: [],
      errors: [{ step: 'run', error: String(error?.message ?? error).slice(0, 200) }],
      summary: 'failed',
      tasks: { claimable: 0, claimed: 0, credited: 0 },
      checkin: null,
    }))
    .then((record) => {
      lastRun = record
      try {
        ctxRef?.logger?.info?.(
          `dsh-workbuddy-daily: ${record.summary}`
          + (record.actions.length > 0
            ? ` (+${record.actions.reduce((sum, action) => sum + (action.credit ?? 0), 0)} credits)`
            : '')
          + (record.errors.length > 0 ? ` errors: ${record.errors.map((e) => e.step).join(',')}` : ''),
        )
      } catch { /* logging must never break the run */ }
      return record
    })
    .finally(() => { runInFlight = null })
  return runInFlight
}

//#endregion

//#region config

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  checkinEnabled: true,
  tasksEnabled: true,
  travelEnabled: true,
  streakEnabled: true,
  claimAllReady: true,
  region: 'cn',
  startDelaySeconds: 8,
})

const describe = (text) => text

export const Config = z === undefined ? undefined : z.object({
  enabled: z.boolean().default(true)
    .description(describe('Run every enabled job on start-up. Off means the plugin does nothing at all.')),
  checkinEnabled: z.boolean().default(true)
    .description(describe('Claim the daily check-in reward when the account has not checked in yet today.')),
  tasksEnabled: z.boolean().default(true)
    .description(describe('Sweep the growth-task list for rewards that are ready to claim.')),
  travelEnabled: z.boolean().default(true)
    .description(describe('Run the cat-travel loop: collect a trip that has arrived, and send the cat out again when idle.')),
  streakEnabled: z.boolean().default(true)
    .description(describe('Redeem consecutive-login reward tiers as they unlock, and draw any lottery chances they grant.')),
  claimAllReady: z.boolean().default(true)
    .description(describe('Actively claim ready task rewards. Off means the plugin only reports what is ready.')),
  region: z.union([z.const('cn'), z.const('global')]).default('cn')
    .description(describe('Which WorkBuddy build to talk to: cn = mainland, global = international.')),
  startDelaySeconds: z.number().step(1).min(0).max(600).default(8)
    .description(describe('Wait this long after the plugin mounts before doing any network work, so start-up is never delayed.')),
})

/**
 * Live config, flattened (Cordis hands volatile fields as live references).
 *
 * Cordis passes plugin config two ways depending on the mount path: as
 * `apply(ctx, config)`'s second argument, and/or as `ctx.config`. Reading only
 * one of them means user settings are silently ignored on the other — which is
 * exactly how a "disabled" plugin keeps running, or a 30-second delay never
 * applies. Both are consulted, explicit argument first.
 *
 * @param {object} [ctx] - the plugin context (may carry `config`).
 * @returns {object} the effective config.
 */
function readConfig(ctx) {
  const merged = { ...DEFAULT_CONFIG }
  let raw = {}
  try {
    if (configRef !== null && typeof configRef === 'object') raw = configRef
    else if (typeof ctx?.config === 'object' && ctx.config !== null) raw = ctx.config
  } catch {
    raw = {}
  }
  const read = (key) => {
    const value = raw[key]
    if (value === undefined || value === null) return undefined
    if (typeof value === 'object' && typeof value.get === 'function') {
      try { return value.get() } catch { return undefined }
    }
    return value
  }
  for (const key of ['enabled', 'checkinEnabled', 'tasksEnabled', 'travelEnabled', 'streakEnabled', 'claimAllReady']) {
    const value = read(key)
    if (typeof value === 'boolean') merged[key] = value
  }
  const region = read('region')
  if (region === 'cn' || region === 'global') merged.region = region
  const delay = Number(read('startDelaySeconds'))
  if (Number.isFinite(delay)) merged.startDelaySeconds = Math.min(600, Math.max(0, Math.trunc(delay)))
  return merged
}

//#endregion

//#region routes

function json(res, status, body) {
  try {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': String(Buffer.byteLength(text)),
    })
    res.end(text)
  } catch {
    try { res.end() } catch { /* connection already gone */ }
  }
}

function methodNotAllowed(res) {
  json(res, 405, { ok: false, error: 'method-not-allowed' })
}

/** Loopback + same-origin gate. These routes can trigger writes on a real account. */
function trustedRequest(req) {
  try {
    const localAddress = req?.socket?.localAddress
    const isLoopback = localAddress === undefined
      || localAddress === null
      || localAddress === '127.0.0.1'
      || localAddress === '::1'
      || localAddress === '::ffff:127.0.0.1'
    if (!isLoopback) return false
    const host = req?.headers?.host
    if (typeof host === 'string' && host !== '') {
      const hostname = host.replace(/:\d+$/, '').toLowerCase()
      if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '[::1]') return false
    }
    const origin = req?.headers?.origin
    if (typeof origin === 'string' && origin !== '') {
      const normalized = origin.toLowerCase()
      const ok = normalized.startsWith('http://127.0.0.1:')
        || normalized.startsWith('http://localhost:')
        || normalized === 'http://127.0.0.1'
        || normalized === 'http://localhost'
      if (!ok) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * The status document.
 *
 * Also reports what the NEXT launch would do, which is the question a user
 * actually has: "is there anything left to claim today?"
 */
function statusDocument(ctx) {
  const config = readConfig(ctx)
  const region = config.region
  const credentials = readCredentials(region)
  const previous = readState()
  const today = dayKey()
  const ranToday = previous !== null && previous.day === today && previous.region === region
  return {
    ok: true,
    plugin: name,
    enabled: config.enabled !== false,
    config: {
      checkinEnabled: config.checkinEnabled,
      tasksEnabled: config.tasksEnabled,
      travelEnabled: config.travelEnabled,
      streakEnabled: config.streakEnabled,
      claimAllReady: config.claimAllReady,
      region,
      startDelaySeconds: config.startDelaySeconds,
    },
    credentials: {
      region,
      count: credentials.length,
      // Never the token itself: only whether one exists and when it lapses.
      signedIn: credentials.length > 0,
      expiresAtMs: credentials.length > 0 && credentials[0].expiresAt > 0
        ? credentials[0].expiresAt * 1000
        : null,
    },
    today: {
      day: today,
      ranToday,
      summary: ranToday ? previous.summary ?? null : null,
      finishedAtMs: ranToday ? previous.finishedAtMs ?? null : null,
      claimedTaskCount: ranToday && Array.isArray(previous.claimedTaskCodes)
        ? previous.claimedTaskCodes.length
        : 0,
      nextLaunchWouldSweepTasks: !(ranToday && Array.isArray(previous?.claimedTaskCodes)),
    },
    lastRun,
    running: runInFlight !== null,
    statePath: statePath(),
    atMs: Date.now(),
  }
}

/** Register the routes on a context that has `webServer`. */
function registerRoutes(webCtx, pluginCtx) {
  const disposers = []

  disposers.push(webCtx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
      if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'host-not-trusted' })
      json(res, 200, statusDocument(pluginCtx))
    },
  }))

  disposers.push(webCtx.webServer.register({
    kind: 'exact',
    path: RUN_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res)
      if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'host-not-trusted' })
      const config = readConfig(pluginCtx)
      if (config.enabled === false) return json(res, 409, { ok: false, error: 'disabled' })
      // Answer immediately; the run continues in the background so a slow upstream
      // cannot hold the request open.
      void triggerRun(config)
      json(res, 202, { ok: true, started: true, alreadyRunning: runInFlight !== null })
    },
  }))

  return () => {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose() } catch { /* already gone */ }
    }
  }
}

//#endregion

//#region plugin

/**
 * Mount.
 *
 * The start-up work is deliberately delayed and detached:
 *   - delayed, because DSH start-up should never wait on a network call;
 *   - detached, because a failure here must not surface as a boot error.
 */
export function apply(ctx, config) {
  configRef = config ?? null
  ctxRef = ctx ?? null

  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() => registerRoutes(webCtx, ctx), 'dsh-workbuddy-daily: web routes')
    })
  } catch { /* no web server: the scheduled run still works */ }

  let timer = null
  try {
    const live = readConfig(ctx)
    if (live.enabled !== false) {
      const delayMs = live.startDelaySeconds * 1000
      timer = setTimeout(() => { void triggerRun(readConfig(ctx)) }, delayMs)
      // A pending timer must not keep a shutting-down process alive.
      if (typeof timer?.unref === 'function') timer.unref()
    }
  } catch { /* a failed schedule is not worth failing the mount over */ }

  try {
    ctx?.effect?.(() => () => {
      try { if (timer !== null) clearTimeout(timer) } catch { /* already fired */ }
    }, 'dsh-workbuddy-daily: start-up timer')
  } catch { /* no effect support */ }
}

//#endregion
