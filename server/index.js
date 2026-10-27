// Servidor do CashDay no Railway: login, dados no Postgres, backups,
// fotos/documentos e o robô de cobrança pela Evolution API.
//
// Variáveis (Railway > serviço > Variables):
//   DATABASE_URL         ${{Postgres.DATABASE_URL}}
//   APP_SENHA            senha para entrar no app
//   EVOLUTION_URL        endereço da Evolution (opcional, para o envio automático)
//   EVOLUTION_APIKEY     chave da Evolution
//   EVOLUTION_INSTANCIA  nome da instância (ex.: cashday)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { message, pending, nowBR, sendWhats } from "../robo/src/index.js";

const PORT = Number(process.env.PORT) || 3000;
const SENHA = process.env.APP_SENHA || "";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_FILE = 8 * 1024 * 1024;
const BACKUP_EVERY_MIN = 60, BACKUPS_KEEP = 200;

const db = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=require|proxy\.rlwy\.net/.test(process.env.DATABASE_URL || "") ? { rejectUnauthorized: false } : undefined
});

async function migrate() {
  await db.query(`
    create table if not exists estado (id int primary key, versao int not null, dados jsonb not null, atualizado timestamptz not null default now());
    create table if not exists backups (id serial primary key, criado timestamptz not null default now(), motivo text, dados jsonb not null);
    create table if not exists arquivos (id text primary key, nome text, tipo text, tamanho int, dados bytea not null, criado timestamptz not null default now());
    create table if not exists enviados (dia text not null, loan_id text not null, em timestamptz not null default now(), primary key (dia, loan_id));
    create table if not exists envio_log (id serial primary key, em timestamptz not null default now(), dia text, loan_id text, nome text, ok boolean, erro text);
  `);
}

/* ---------- login: token assinado com a senha ---------- */
const secret = () => crypto.createHash("sha256").update("cashday:" + SENHA).digest();
const sign = s => crypto.createHmac("sha256", secret()).update(s).digest("base64url");
const makeToken = () => { const p = "v1." + Date.now(); return p + "." + sign(p); };
function tokenOk(t) {
  if (!SENHA || !t) return false;
  const i = t.lastIndexOf("."); if (i < 0) return false;
  const a = Buffer.from(sign(t.slice(0, i))), b = Buffer.from(t.slice(i + 1));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const senhaOk = s => {
  const a = crypto.createHash("sha256").update(String(s || "")).digest(), b = crypto.createHash("sha256").update(SENHA).digest();
  return !!SENHA && crypto.timingSafeEqual(a, b);
};

/* ---------- estado ---------- */
async function getEstado() {
  const r = await db.query("select versao, dados, atualizado from estado where id=1");
  return r.rows[0] || { versao: 0, dados: null, atualizado: null };
}
async function backup(dados, motivo, force) {
  if (!dados) return;
  if (!force) {
    const r = await db.query("select criado from backups order by id desc limit 1");
    if (r.rows[0] && Date.now() - new Date(r.rows[0].criado) < BACKUP_EVERY_MIN * 60e3) return;
  }
  await db.query("insert into backups (motivo, dados) values ($1, $2)", [motivo, dados]);
  await db.query("delete from backups where id not in (select id from backups order by id desc limit $1)", [BACKUPS_KEEP]);
}

/* ---------- robô (mesma regra do robô do Cloudflare) ---------- */
const evoOk = () => !!(process.env.EVOLUTION_URL && process.env.EVOLUTION_APIKEY && process.env.EVOLUTION_INSTANCIA);
// mesmo envio do robô do Cloudflare, usando as variáveis do Railway
const enviar = (phone, text) => sendWhats(process.env, phone, text);
// horário, envio automático e número do teste vêm das variáveis do Railway
const env = k => (process.env[k] || "").trim();
const sim = v => /^(sim|s|true|1|ligado|on|yes)$/i.test(v);
function config(dados) {
  const st = (dados && dados.settings) || {};
  const h = env("HORARIO_COBRANCA");
  return {
    horario: /^\d{1,2}:\d{2}$/.test(h) ? h.padStart(5, "0") : st.chargeTime || "09:00",
    ligado: env("ENVIO_AUTOMATICO") ? sim(env("ENVIO_AUTOMATICO")) : !!st.autoSend,
    teste: env("WHATSAPP_TESTE").replace(/\D/g, "")
  };
}
async function rodada() {
  const { dados } = await getEstado();
  const cfg = config(dados);
  if (!dados || !cfg.ligado || !evoOk()) return "desligado";
  const { date, hm } = nowBR();
  if (hm < cfg.horario) return "antes do horário";
  if (hm >= "21:00") return "muito tarde";
  const sent = Object.fromEntries((await db.query("select loan_id from enviados where dia=$1", [date])).rows.map(r => [r.loan_id, true]));
  const list = pending(dados, sent, date);
  if (!list.length) return "nada pendente";
  const { l, c } = list[0];
  const ins = await db.query("insert into enviados (dia, loan_id) values ($1,$2) on conflict do nothing returning loan_id", [date, l.id]);
  if (!ins.rowCount) return "já enviado";
  try {
    await enviar(c.phone, message(l, c, date, { ...dados.settings, chargeTime: cfg.horario }));
    await db.query("insert into envio_log (dia, loan_id, nome, ok) values ($1,$2,$3,true)", [date, l.id, c.name]);
    return "enviado para " + c.name;
  } catch (e) {
    await db.query("insert into envio_log (dia, loan_id, nome, ok, erro) values ($1,$2,$3,false,$4)", [date, l.id, c.name, String(e.message || e).slice(0, 300)]);
    return "erro: " + e.message;
  }
}
async function roboStatus() {
  const { date, hm } = nowBR();
  const { dados } = await getEstado();
  const cfg = config(dados);
  const sentRows = (await db.query("select loan_id, em from enviados where dia=$1", [date])).rows;
  const sent = Object.fromEntries(sentRows.map(r => [r.loan_id, r.em]));
  const log = (await db.query("select em, dia, nome, ok, erro from envio_log order by id desc limit 30")).rows
    .map(r => ({ at: new Date(r.em).toISOString(), date: r.dia, name: r.nome, ok: r.ok, error: r.erro }));
  return {
    ok: true, agora: date + " " + hm, zapi: evoOk(), envio: evoOk() ? "Evolution" : null,
    ligado: cfg.ligado, horario: cfg.horario, teste: !!cfg.teste,
    pendentes: dados ? pending(dados, sent, date).length : 0, enviadosHoje: sent, log
  };
}

/* ---------- http ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,Authorization" };
const send = (res, code, obj, headers) => { res.writeHead(code, { ...CORS, "Content-Type": "application/json; charset=utf-8", ...headers }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit) {
  const chunks = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw Object.assign(new Error("Arquivo grande demais"), { code: 413 }); chunks.push(c); }
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png" };
const PUBLIC = new Set(["/index.html", "/manifest.webmanifest", "/sw.js", "/icon-180.png", "/icon-192.png", "/icon-512.png"]);

async function api(req, res, url) {
  const p = url.pathname;
  if (p === "/api/saude") return send(res, 200, { ok: true, banco: !!process.env.DATABASE_URL, senha: !!SENHA, envio: evoOk() });
  if (p === "/api/login" && req.method === "POST") {
    const { senha } = await readBody(req, 1e4);
    if (!SENHA) return send(res, 500, { ok: false, erro: "Falta configurar APP_SENHA no Railway" });
    if (!senhaOk(senha)) { await new Promise(r => setTimeout(r, 800)); return send(res, 401, { ok: false, erro: "Senha errada" }); }
    return send(res, 200, { ok: true, token: makeToken() });
  }
  const auth = (req.headers.authorization || "").replace(/^Bearer /, "") || url.searchParams.get("t");
  if (!tokenOk(auth)) return send(res, 401, { ok: false, erro: "Entre de novo com a senha" });

  if (p === "/api/estado" && req.method === "GET") {
    const e = await getEstado();
    return send(res, 200, { ok: true, versao: e.versao, dados: e.dados, atualizado: e.atualizado });
  }
  if (p === "/api/estado" && req.method === "PUT") {
    const { base, dados, forcar } = await readBody(req, 20 * 1024 * 1024);
    if (!dados || !Array.isArray(dados.clients) || !Array.isArray(dados.loans)) return send(res, 400, { ok: false, erro: "Dados inválidos" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const cur = (await client.query("select versao, dados from estado where id=1 for update")).rows[0];
      const v = cur ? cur.versao : 0;
      if (!forcar && cur && base !== v) {
        await client.query("rollback");
        await backup(dados, "conflito: cópia do celular", true); // nada se perde
        return send(res, 409, { ok: false, erro: "A nuvem tem uma versão mais nova", versao: v, dados: cur.dados });
      }
      if (cur && forcar) await client.query("insert into backups (motivo, dados) values ($1,$2)", ["antes de substituir", cur.dados]);
      const nv = v + 1;
      await client.query("insert into estado (id, versao, dados, atualizado) values (1,$1,$2,now()) on conflict (id) do update set versao=$1, dados=$2, atualizado=now()", [nv, dados]);
      await client.query("commit");
      backup(dados, "automático").catch(() => {});
      return send(res, 200, { ok: true, versao: nv });
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
  }
  if (p === "/api/backups" && req.method === "GET") {
    const r = await db.query("select id, criado, motivo, jsonb_array_length(dados->'clients') as clientes from backups order by id desc limit 60");
    return send(res, 200, { ok: true, backups: r.rows });
  }
  let m;
  if ((m = p.match(/^\/api\/backups\/(\d+)$/)) && req.method === "GET") {
    const r = await db.query("select dados from backups where id=$1", [m[1]]);
    return r.rows[0] ? send(res, 200, { ok: true, dados: r.rows[0].dados }) : send(res, 404, { ok: false, erro: "Backup não encontrado" });
  }
  if (p === "/api/arquivos" && req.method === "POST") {
    const { nome, tipo, base64 } = await readBody(req, MAX_FILE * 1.4);
    const buf = Buffer.from(String(base64 || ""), "base64");
    if (!buf.length) return send(res, 400, { ok: false, erro: "Arquivo vazio" });
    const id = crypto.randomUUID();
    await db.query("insert into arquivos (id, nome, tipo, tamanho, dados) values ($1,$2,$3,$4,$5)", [id, String(nome || "arquivo").slice(0, 120), String(tipo || "application/octet-stream").slice(0, 80), buf.length, buf]);
    return send(res, 200, { ok: true, id });
  }
  if ((m = p.match(/^\/api\/arquivos\/([\w-]+)$/))) {
    if (req.method === "DELETE") { await db.query("delete from arquivos where id=$1", [m[1]]); return send(res, 200, { ok: true }); }
    const r = await db.query("select nome, tipo, dados from arquivos where id=$1", [m[1]]);
    if (!r.rows[0]) return send(res, 404, { ok: false, erro: "Arquivo não encontrado" });
    res.writeHead(200, { ...CORS, "Content-Type": r.rows[0].tipo, "Cache-Control": "private, max-age=86400", "Content-Disposition": `inline; filename="${encodeURIComponent(r.rows[0].nome)}"` });
    return res.end(r.rows[0].dados);
  }
  if (p === "/api/robo/status") return send(res, 200, await roboStatus());
  if (p === "/api/robo/rodar" && req.method === "POST") return send(res, 200, { ok: true, resultado: await rodada() });
  if (p === "/api/robo/teste" && req.method === "POST") {
    const phone = config((await getEstado()).dados).teste || String((await readBody(req, 1e4)).phone || "").replace(/\D/g, "");
    if (!phone) return send(res, 400, { ok: false, erro: "Falta configurar WHATSAPP_TESTE no Railway" });
    if (!evoOk()) return send(res, 400, { ok: false, erro: "Falta configurar a Evolution no Railway" });
    await enviar(phone, "Teste do CashDay: o envio automático está funcionando.");
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { ok: false, erro: "Caminho desconhecido" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    // o próprio app também fica disponível no endereço do Railway
    const f = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!PUBLIC.has(f)) { res.writeHead(404); return res.end("Não encontrado"); }
    let body = await fs.readFile(path.join(ROOT, f));
    // avisa o app que ele está no servidor: endereço e opções vêm das variáveis do Railway
    if (f === "/index.html") body = body.toString("utf8").replace("<script>", "<script>window.CASHDAY_SERVIDOR=true</script><script>");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) send(res, e.code === 413 ? 413 : 500, { ok: false, erro: String(e.message || e) });
  }
});

if (process.env.DATABASE_URL) {
  await migrate();
  setInterval(() => rodada().then(r => { if (r.startsWith("enviado") || r.startsWith("erro")) console.log("robô:", r); }).catch(e => console.error("robô:", e)), 120e3);
} else console.warn("Sem DATABASE_URL: adicione o Postgres no Railway.");
server.listen(PORT, () => console.log("CashDay no ar na porta " + PORT));
