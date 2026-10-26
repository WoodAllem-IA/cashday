// Robô do CashDay: guarda uma cópia dos dados do app e, no horário escolhido,
// manda as cobranças do dia pelo WhatsApp (Z-API), uma mensagem por vez.
//
// Segredos (Cloudflare > Worker > Settings > Variables and Secrets):
//   SENHA_ROBO         senha que o app usa para falar com o robô
//   ZAPI_INSTANCIA     ID da instância na Z-API
//   ZAPI_TOKEN         token da instância na Z-API
//   ZAPI_CLIENT_TOKEN  token de segurança da conta Z-API (opcional)

const TZ = "America/Sao_Paulo";
const MAX_LOG = 200;

/* ---------- datas no horário de Brasília ---------- */
const pad = n => String(n).padStart(2, "0");
function nowBR() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}
const parse = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const diffDays = (a, b) => Math.round((parse(a) - parse(b)) / 864e5);
const fmtD = s => { const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };

/* ---------- mesmas contas do app ---------- */
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
function brl(v) {
  const [i, c] = r2(v).toFixed(2).split(".");
  return "R$ " + i.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "," + c;
}
const total = l => r2(l.principal * (1 + l.pct / 100));
const parcel = l => r2(total(l) / l.n);
const jurosParc = l => r2(l.principal * l.pct / 100 / l.n);
const daysLate = (l, t) => Math.max(0, diffDays(t, l.nextDue));
function lateFee(l, t) {
  const d = daysLate(l, t); if (!d) return 0;
  return l.lateType === "pct" ? r2(parcel(l) * l.lateValue / 100 * d) : r2(l.lateValue * d);
}
const lateRule = l => l.lateType === "pct" ? String(l.lateValue).replace(".", ",") + "% da parcela por dia" : brl(l.lateValue) + " por dia";
const MSG_DEFAULT = {
  late: "{saudacao}\n\nParcela {parc}: {valor}\nVencimento: {vencimento}\nAtraso: {dias}\nMulta: {multa}\nTotal: {total}",
  today: "{saudacao}\n\nParcela {parc}: {valor}\nVencimento: hoje, {vencimento}"
};
// Mesmo modelo de mensagem editado em Ajustes no app
function message(l, c, t, settings) {
  const dl = daysLate(l, t), lf = lateFee(l, t), kind = dl > 0 ? "late" : "today";
  const tpl = (settings && settings.msg && settings.msg[kind]) || MSG_DEFAULT[kind];
  const h = Number(nowBR().hm.slice(0, 2));
  const v = {
    saudacao: h < 5 ? "Boa noite" : h < 12 ? "Bom dia" : h < 18 ? "Boa tarde" : "Boa noite", parc: `${l.paid + 1}/${l.n}`,
    nome: c.name.replace(/\s*\(exemplo\)/, "").split(" ")[0], parcela: `parcela ${l.paid + 1} de ${l.n}`, valor: brl(parcel(l)),
    vencimento: fmtD(l.nextDue), dias: dl + (dl === 1 ? " dia" : " dias"), multa: brl(lf), total: brl(parcel(l) + lf),
    juros: brl(jurosParc(l) + lf), regra: lateRule(l)
  };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);
}
function waNumber(p) { let d = String(p || "").replace(/\D/g, ""); if (d.length <= 11) d = "55" + d; return d; }

/* ---------- Z-API ---------- */
async function sendWhats(env, phone, text) {
  if (!env.ZAPI_INSTANCIA || !env.ZAPI_TOKEN) throw new Error("Z-API não configurada no robô");
  const headers = { "Content-Type": "application/json" };
  if (env.ZAPI_CLIENT_TOKEN) headers["Client-Token"] = env.ZAPI_CLIENT_TOKEN;
  const r = await fetch(`https://api.z-api.io/instances/${env.ZAPI_INSTANCIA}/token/${env.ZAPI_TOKEN}/send-text`, {
    method: "POST", headers, body: JSON.stringify({ phone: waNumber(phone), message: text, delayTyping: 3 })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Z-API respondeu ${r.status}: ${body.slice(0, 200)}`);
  return body;
}

/* ---------- armazenamento ---------- */
const getJSON = async (env, k, d) => { const v = await env.DATA.get(k); return v ? JSON.parse(v) : d; };
const putJSON = (env, k, v) => env.DATA.put(k, JSON.stringify(v));
async function addLog(env, entry) {
  const log = await getJSON(env, "log", []);
  log.unshift(entry); log.length = Math.min(log.length, MAX_LOG);
  await putJSON(env, "log", log);
}

// Quem precisa ser cobrado hoje e ainda não recebeu mensagem
function pending(state, sent, t) {
  const cs = new Map((state.clients || []).map(c => [c.id, c]));
  return (state.loans || [])
    .filter(l => l.status === "aberto" && l.nextDue <= t && !sent[l.id] && !l.sample)
    .map(l => ({ l, c: cs.get(l.clientId) }))
    .filter(x => x.c && !x.c.sample && String(x.c.phone || "").replace(/\D/g, "").length >= 10)
    .sort((a, b) => a.l.nextDue.localeCompare(b.l.nextDue));
}

/* ---------- rodada agendada (a cada 2 minutos) ---------- */
async function tick(env) {
  const state = await getJSON(env, "state", null);
  if (!state || !state.settings || !state.settings.autoSend) return "desligado";
  const { date, hm } = nowBR();
  if (hm < (state.settings.chargeTime || "09:00")) return "antes do horário";
  if (hm >= "21:00") return "muito tarde";
  const sentKey = "sent:" + date, sent = await getJSON(env, sentKey, {});
  const list = pending(state, sent, date);
  if (!list.length) return "nada pendente";
  const { l, c } = list[0]; // uma mensagem por rodada, para não parecer robô
  sent[l.id] = new Date().toISOString();
  await putJSON(env, sentKey, sent); // marca antes de enviar: nunca manda duas vezes
  try {
    await sendWhats(env, c.phone, message(l, c, date, state.settings));
    await addLog(env, { at: sent[l.id], date, loanId: l.id, name: c.name, ok: true });
    return "enviado para " + c.name;
  } catch (e) {
    await addLog(env, { at: sent[l.id], date, loanId: l.id, name: c.name, ok: false, error: String(e.message || e) });
    return "erro: " + e.message;
  }
}

/* ---------- rotas que o app usa ---------- */
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Senha"
};
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function status(env) {
  const { date, hm } = nowBR();
  const state = await getJSON(env, "state", null);
  const sent = await getJSON(env, "sent:" + date, {});
  const log = await getJSON(env, "log", []);
  return {
    ok: true, agora: date + " " + hm, zapi: !!(env.ZAPI_INSTANCIA && env.ZAPI_TOKEN),
    ligado: !!(state && state.settings && state.settings.autoSend),
    horario: state && state.settings ? state.settings.chargeTime || "09:00" : null,
    pendentes: state ? pending(state, sent, date).length : 0,
    enviadosHoje: sent, log: log.slice(0, 30)
  };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    if (url.pathname === "/") return json({ ok: true, app: "Robô do CashDay" });
    if (!env.SENHA_ROBO || req.headers.get("X-Senha") !== env.SENHA_ROBO) return json({ ok: false, erro: "Senha do robô errada" }, 401);
    try {
      if (url.pathname === "/status") return json(await status(env));
      if (url.pathname === "/sync" && req.method === "POST") {
        const body = await req.json();
        if (!body || !Array.isArray(body.clients) || !Array.isArray(body.loans)) return json({ ok: false, erro: "Dados inválidos" }, 400);
        await putJSON(env, "state", { clients: body.clients, loans: body.loans, settings: body.settings || {}, syncedAt: new Date().toISOString() });
        return json(await status(env));
      }
      if (url.pathname === "/teste" && req.method === "POST") {
        const { phone } = await req.json();
        await sendWhats(env, phone, "Teste do CashDay: o envio automático está funcionando.");
        return json({ ok: true });
      }
      if (url.pathname === "/rodar" && req.method === "POST") return json({ ok: true, resultado: await tick(env) });
      return json({ ok: false, erro: "Caminho desconhecido" }, 404);
    } catch (e) {
      return json({ ok: false, erro: String(e.message || e) }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  }
};

export { message, pending, nowBR, brl };
