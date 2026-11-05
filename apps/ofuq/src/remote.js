/**
 * OFUQ — server-authoritative backend adapter.
 *
 * Talks to the Supabase project that owns `supabase/ofuq/schema.sql`. Every mutation
 * calls a SECURITY DEFINER RPC that returns the player's authoritative snapshot; the
 * client never sends prices, balances or ownership, only *intent* plus an idempotency
 * key. `mode: 'local'` keeps the offline shell working until a project is configured.
 *
 * No dependency: plain fetch against the Supabase REST/Auth endpoints, so the app still
 * runs from any static host (and the standalone preview) without a bundler.
 */

const DEFAULT_TIMEOUT_MS = 15000;

export function createIdempotencyKey(prefix = 'ofuq') {
  const random =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

/** Map a failed request onto a message that is safe and useful to show a player. */
export function describeError(status, body) {
  const serverMessage =
    (body && (body.message || body.error_description || body.msg || body.error)) || '';
  if (status === 401 || status === 403) return 'انتهت الجلسة أو لا تملك صلاحية — سجّل الدخول مجدداً.';
  if (status === 409) return serverMessage || 'تعارض في البيانات، أعد المحاولة.';
  if (status === 429) return 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة.';
  if (status >= 500) return 'خدمة المدينة غير متاحة الآن. لم يُخصم منك شيء.';
  return String(serverMessage || 'تعذر تنفيذ الطلب.').replace(/^(?:.*?exception:|[0-9A-Z]{5}):\s*/i, '');
}

const SESSION_KEY = 'ofuq:session';

function readSession(storage) {
  try {
    const raw = storage?.getItem?.(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeSession(storage, session) {
  try {
    if (session) storage?.setItem?.(SESSION_KEY, JSON.stringify(session));
    else storage?.removeItem?.(SESSION_KEY);
  } catch {
    /* storage can be blocked; the in-memory session still works for this tab */
  }
}

/**
 * @param {object} options
 * @param {string} options.url            e.g. https://xxxx.supabase.co
 * @param {string} options.publishableKey client-safe (anon / publishable) key
 * @param {Function} [options.fetchImpl]  injectable for tests
 * @param {Storage} [options.storage]     where to persist the session
 * @param {number} [options.timeoutMs]
 */
export function createSupabaseBackend({
  url,
  publishableKey,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  storage = globalThis.localStorage,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (!url || !publishableKey) throw new Error('OFUQ backend needs a URL and a publishable key');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available in this environment');

  const base = url.replace(/\/$/, '');
  let session = readSession(storage);

  async function request(path, { method = 'GET', body, token, headers = {} } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          apikey: publishableKey,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal
      });
      const text = await response.text();
      const payload = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : null;
      if (!response.ok) {
        const error = new Error(describeError(response.status, payload));
        error.status = response.status;
        error.body = payload;
        throw error;
      }
      return payload;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const isExpired = () => !session?.access_token || (session.expires_at ?? 0) * 1000 < Date.now() + 30_000;

  async function refresh() {
    if (!session?.refresh_token) return false;
    try {
      const data = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: { refresh_token: session.refresh_token }
      });
      session = { ...session, ...data };
      writeSession(storage, session);
      return true;
    } catch {
      session = null;
      writeSession(storage, null);
      return false;
    }
  }

  async function token() {
    if (isExpired() && !(await refresh())) return null;
    return session?.access_token ?? null;
  }

  async function auth(path, body) {
    const data = await request(path, { method: 'POST', body });
    session = data;
    writeSession(storage, session);
    return { ok: true, user: data.user ?? null, message: 'تم تسجيل الدخول.' };
  }

  async function rpc(fn, args) {
    if (!(await token())) {
      return { ok: false, message: 'سجّل الدخول للمشاركة في المدينة المشتركة.' };
    }
    const result = await request(`/rest/v1/rpc/${fn}`, { method: 'POST', body: args, token: session.access_token });
    return { ok: true, snapshot: result };
  }

  const guarded = async (fn, args) => {
    try {
      return await rpc(fn, args);
    } catch (error) {
      return { ok: false, message: error.message, status: error.status };
    }
  };

  return {
    mode: 'supabase',
    get signedIn() {
      return Boolean(session?.access_token);
    },
    get user() {
      return session?.user ?? null;
    },

    async signIn(email, password) {
      try {
        return await auth('/auth/v1/token?grant_type=password', { email, password });
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },

    async signUp(email, password, displayName) {
      try {
        return await auth('/auth/v1/signup', { email, password, data: { display_name: displayName } });
      } catch (error) {
        return { ok: false, message: error.message };
      }
    },

    async signOut() {
      const current = await token();
      if (current) {
        try {
          await request('/auth/v1/logout', { method: 'POST', token: current });
        } catch {
          /* local session is cleared regardless */
        }
      }
      session = null;
      writeSession(storage, null);
      return { ok: true, message: 'تم تسجيل الخروج.' };
    },

    async restoreSession() {
      if (!(await token())) return { ok: false, message: 'لا توجد جلسة محفوظة.' };
      return this.snapshot();
    },

    snapshot: () => guarded('ofuq_snapshot', {}),
    purchasePlot: ({ districtId, plotNo, idempotencyKey }) =>
      guarded('ofuq_purchase_plot', { p_district: districtId, p_plot_no: plotNo, p_idempotency: idempotencyKey }),
    developPlot: ({ plotId, assetId, idempotencyKey }) =>
      guarded('ofuq_develop_plot', { p_plot: plotId, p_asset: assetId, p_idempotency: idempotencyKey }),
    upgradePlot: ({ plotId, idempotencyKey }) => guarded('ofuq_upgrade_plot', { p_plot: plotId, p_idempotency: idempotencyKey }),
    collectRent: ({ plotId, idempotencyKey }) => guarded('ofuq_collect_rent', { p_plot: plotId, p_idempotency: idempotencyKey }),
    sellPlot: ({ plotId, idempotencyKey }) => guarded('ofuq_sell_plot', { p_plot: plotId, p_idempotency: idempotencyKey }),
    claimMission: ({ missionId, idempotencyKey }) =>
      guarded('ofuq_claim_mission', { p_mission: missionId, p_idempotency: idempotencyKey })
  };
}

/**
 * Translate the server snapshot into the store's state shape.
 * Only server-owned fields are taken; profile/settings stay local.
 */
export function snapshotToState(snapshot, previous = {}) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const plots = {};
  for (const plot of snapshot.plots ?? []) {
    plots[`${plot.districtId}:${plot.plotNo}`] = {
      id: plot.id,
      districtId: plot.districtId,
      plotNo: plot.plotNo,
      assetId: plot.assetId ?? null,
      level: plot.level ?? 0,
      purchasedAt: Date.parse(plot.purchasedAt ?? '') || Date.now(),
      lastCollectedAt: Date.parse(plot.lastCollectedAt ?? '') || Date.now(),
      rent: Number(plot.rent ?? 0),
      value: Number(plot.value ?? 0)
    };
  }
  const weekly = snapshot.weekly ?? {};
  // The server references plots by uuid; the client speaks `district:plotNo`. Translate,
  // so the plot sheet shows the same history in both modes.
  const keyById = Object.fromEntries(Object.entries(plots).map(([key, plot]) => [plot.id, key]));
  // The server sends its last 100 rows; newest first, same shape as the local ledger.
  const ledger = Array.isArray(snapshot.ledger)
    ? snapshot.ledger
        .map((row, index) => ({
          id: `s${row.id ?? index}`,
          seq: Number(row.seq ?? index),
          ts: Date.parse(row.ts ?? '') || Date.now(),
          reason: typeof row.reason === 'string' ? row.reason : 'admin_adjustment',
          amount: Number(row.amount ?? row.delta ?? 0),
          balanceAfter: Number(row.balanceAfter ?? 0),
          ref: typeof row.ref === 'string' ? keyById[row.ref] ?? row.ref : null
        }))
        .sort((a, b) => b.ts - a.ts || b.seq - a.seq)
        .slice(0, 400)
    : previous.ledger ?? [];
  return {
    ...previous,
    playerName: snapshot.player?.name ?? previous.playerName,
    cash: Number(snapshot.balance ?? 0),
    xp: Number(snapshot.player?.xp ?? 0),
    plots,
    ledger,
    ledgerSeq: Number(snapshot.ledgerSeq ?? ledger[0]?.seq ?? previous.ledgerSeq ?? 0),
    claims: snapshot.week ? { [snapshot.week]: [...(snapshot.claims ?? [])] } : previous.claims ?? {},
    week: {
      key: snapshot.week ?? previous.week?.key,
      bought: Number(weekly.bought ?? 0),
      developed: Number(weekly.developed ?? 0),
      upgraded: Number(weekly.upgraded ?? 0),
      collected: Number(weekly.collected ?? 0)
    }
  };
}
