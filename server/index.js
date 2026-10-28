// Servidor do CashDay no Railway: login, dados no Postgres, backups,
// fotos/documentos e o robô de cobrança pela Evolution API.
//
// Variáveis (Railway > serviço > Variables):
//   DATABASE_URL         ${{Postgres.DATABASE_URL}}
//   ADMIN_USUARIO        usuário do administrador (padrão: admin)
//   APP_SENHA            senha do administrador
//   EVOLUTION_URL        endereço da Evolution (opcional, para o envio automático)
//   EVOLUTION_APIKEY     chave global da Evolution (AUTHENTICATION_API_KEY)
//   EVOLUTION_INSTANCIA  (opcional) instância já conectada que o administrador continua usando
// Cada conta tem a própria instância na Evolution e conecta o WhatsApp dela pelo QR Code no app.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { message, pending, nowBR, sendWhats } from "../robo/src/index.js";

const PORT = Number(process.env.PORT) || 3000;
const SENHA = process.env.APP_SENHA || "";
const ADMIN = (process.env.ADMIN_USUARIO || "admin").trim().toLowerCase();
const ADMIN_ID = 1; // o administrador é sempre o usuário 1 (dono dos dados que já existiam)
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
    create table if not exists usuarios (id serial primary key, login text unique not null, nome text not null, senha text, admin boolean not null default false,
      ativo boolean not null default true, criado timestamptz not null default now(), ultimo_acesso timestamptz);
    alter table backups add column if not exists usuario int not null default 1;
    alter table arquivos add column if not exists usuario int not null default 1;
    alter table usuarios add column if not exists instancia text;
    alter table enviados add column if not exists usuario int not null default 1;
    alter table envio_log add column if not exists usuario int not null default 1;
  `);
  // o administrador vem das variáveis do Railway (ADMIN_USUARIO e APP_SENHA)
  await db.query(`insert into usuarios (id, login, nome, admin) values ($1, $2, 'Administrador', true)
    on conflict (id) do update set login=$2, admin=true, ativo=true`, [ADMIN_ID, ADMIN]);
  await db.query("select setval(pg_get_serial_sequence('usuarios','id'), greatest((select max(id) from usuarios), 1))");
}

/* ---------- login: usuário e senha; token assinado com APP_SENHA ---------- */
const secret = () => crypto.createHash("sha256").update("cashday:" + SENHA).digest();
const sign = s => crypto.createHmac("sha256", secret()).update(s).digest("base64url");
// o token leva o id do usuário e um pedaço da senha dele: trocar a senha derruba os logins antigos
const marca = u => crypto.createHash("sha256").update(String(u.senha || "")).digest("base64url").slice(0, 8);
const makeToken = u => { const p = "u2." + u.id + "." + marca(u) + "." + Date.now(); return p + "." + sign(p); };
async function tokenUser(t) {
  if (!SENHA || !t) return null;
  const i = t.lastIndexOf("."); if (i < 0) return null;
  const a = Buffer.from(sign(t.slice(0, i))), b = Buffer.from(t.slice(i + 1));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const [v, id, mk] = t.slice(0, i).split(".");
  if (v !== "u2") return null;
  const u = (await db.query("select * from usuarios where id=$1", [Number(id)])).rows[0];
  return u && u.ativo && marca(u) === mk ? u : null;
}
const igual = (x, y) => {
  const a = crypto.createHash("sha256").update(String(x || "")).digest(), b = crypto.createHash("sha256").update(String(y || "")).digest();
  return crypto.timingSafeEqual(a, b);
};
const hashSenha = s => { const salt = crypto.randomBytes(16).toString("base64url"); return salt + ":" + crypto.scryptSync(String(s), salt, 32).toString("base64url"); };
const confere = (s, h) => { if (!h) return false; const [salt, k] = h.split(":"); return igual(crypto.scryptSync(String(s || ""), salt, 32).toString("base64url"), k); };
async function login(usuario, senha) {
  usuario = String(usuario || "").trim().toLowerCase();
  if (!usuario || usuario === ADMIN) return SENHA && igual(senha, SENHA) ? (await db.query("select * from usuarios where id=$1", [ADMIN_ID])).rows[0] : null;
  const u = (await db.query("select * from usuarios where login=$1", [usuario])).rows[0];
  return u && u.ativo && !u.admin && confere(senha, u.senha) ? u : null;
}
const publico = u => ({ id: u.id, login: u.login, nome: u.nome, admin: u.admin });

/* ---------- estado ---------- */
async function getEstado(uid = ADMIN_ID) {
  const r = await db.query("select versao, dados, atualizado from estado where id=$1", [uid]);
  return r.rows[0] || { versao: 0, dados: null, atualizado: null };
}
async function backup(uid, dados, motivo, force) {
  if (!dados) return;
  if (!force) {
    const r = await db.query("select criado from backups where usuario=$1 order by id desc limit 1", [uid]);
    if (r.rows[0] && Date.now() - new Date(r.rows[0].criado) < BACKUP_EVERY_MIN * 60e3) return;
  }
  await db.query("insert into backups (usuario, motivo, dados) values ($1, $2, $3)", [uid, motivo, dados]);
  await db.query("delete from backups where usuario=$1 and id not in (select id from backups where usuario=$1 order by id desc limit $2)", [uid, BACKUPS_KEEP]);
}

/* ---------- WhatsApp de cada conta (Evolution API) ----------
   Cada conta tem a própria instância na Evolution, criada na primeira vez que
   ela toca em "Conectar pelo QR Code". O endereço e a chave global são do Railway. */
const env = k => (process.env[k] || "").trim();
const evoUrl = () => env("EVOLUTION_URL").replace(/\/+$/, "");
const evoOk = () => !!(evoUrl() && env("EVOLUTION_APIKEY"));
async function evo(method, p, body) {
  const r = await fetch(evoUrl() + p, {
    method, headers: { "Content-Type": "application/json", apikey: env("EVOLUTION_APIKEY") },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20e3)
  });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { ok: r.ok, status: r.status, j: j || {}, t };
}
const evoErro = (r, o) => new Error(`A Evolution respondeu ${r.status} ao ${o}: ${String((r.j.response && r.j.response.message) || r.j.message || r.t).slice(0, 200)}`);
// o administrador continua com a instância de EVOLUTION_INSTANCIA, se ela existir
const instanciaDe = u => u.instancia || (u.id === ADMIN_ID ? env("EVOLUTION_INSTANCIA") : "") || "";
const nomeInstancia = u => ("cashday-" + u.login).replace(/[^a-z0-9_-]/gi, "-").slice(0, 60);
async function estadoWhats(inst) {
  if (!inst || !evoOk()) return "sem instância";
  const r = await evo("GET", "/instance/connectionState/" + encodeURIComponent(inst));
  if (r.status === 404) return "sem instância";
  if (!r.ok) throw evoErro(r, "ver a conexão");
  return (r.j.instance && r.j.instance.state) || r.j.state || "close"; // open, connecting ou close
}
async function perfilWhats(inst) {
  try {
    const r = await evo("GET", "/instance/fetchInstances?instanceName=" + encodeURIComponent(inst));
    const i = [].concat(r.j || [])[0] || {}, v1 = i.instance || {}; // v2 traz os campos direto; v1 dentro de "instance"
    return { numero: String(i.ownerJid || v1.owner || "").split("@")[0], nome: i.profileName || v1.profileName || "" };
  } catch { return {}; }
}
async function criarInstancia(u) {
  const instanceName = nomeInstancia(u);
  let r = await evo("POST", "/instance/create", { instanceName, qrcode: true, integration: "WHATSAPP-BAILEYS" });
  if (r.status === 400 && !/in use|já existe/i.test(r.t)) r = await evo("POST", "/instance/create", { instanceName, qrcode: true }); // v1
  if (!r.ok && !/in use|já existe/i.test(r.t)) throw evoErro(r, "criar a instância");
  await db.query("update usuarios set instancia=$2 where id=$1", [u.id, instanceName]);
  u.instancia = instanceName;
  return instanceName;
}
async function whatsStatus(u) {
  const inst = instanciaDe(u);
  const w = { servidor: evoOk(), instancia: inst || null, estado: "sem instância" };
  if (!w.servidor || !inst) return w;
  try { w.estado = await estadoWhats(inst); } catch (e) { w.estado = "erro"; w.erro = e.message; }
  if (w.estado === "open") Object.assign(w, await perfilWhats(inst));
  return w;
}
// pede o QR Code; cria a instância se a conta ainda não tem (ou se ela sumiu da Evolution)
async function conectarWhats(u) {
  if (!evoOk()) throw new Error("Falta configurar EVOLUTION_URL e EVOLUTION_APIKEY no Railway");
  let inst = instanciaDe(u);
  if (!inst || (await estadoWhats(inst)) === "sem instância") inst = await criarInstancia(u);
  const r = await evo("GET", "/instance/connect/" + encodeURIComponent(inst));
  if (!r.ok) throw evoErro(r, "gerar o QR Code");
  const st = (r.j.instance && r.j.instance.state) || r.j.state;
  if (st === "open") return { estado: "open" };
  let qr = r.j.base64 || (r.j.qrcode && r.j.qrcode.base64) || "";
  if (qr && !qr.startsWith("data:")) qr = "data:image/png;base64," + qr;
  return { estado: "connecting", qr, codigo: r.j.pairingCode || null };
}
async function desconectarWhats(u) {
  const inst = instanciaDe(u);
  if (!inst || !evoOk()) return;
  const r = await evo("DELETE", "/instance/logout/" + encodeURIComponent(inst));
  if (!r.ok && r.status !== 404 && !/not connected|não está conectad/i.test(r.t)) throw evoErro(r, "desconectar");
}

/* ---------- robô (mesma regra do robô do Cloudflare) ----------
   Cada conta cobra os próprios clientes pelo WhatsApp que ela conectou. */
const enviar = (inst, phone, text) => sendWhats({ ...process.env, EVOLUTION_INSTANCIA: inst }, phone, text);
// horário e envio automático: cada conta liga, desliga e escolhe o horário em Ajustes.
// As variáveis do Railway só valem para a conta que ainda não escolheu. WHATSAPP_TESTE é o número do administrador.
const sim = v => /^(sim|s|true|1|ligado|on|yes)$/i.test(v);
const horarioEnv = () => { const h = env("HORARIO_COBRANCA"); return /^\d{1,2}:\d{2}$/.test(h) ? h.padStart(5, "0") : ""; };
function config(dados, u) {
  const st = (dados && dados.settings) || {};
  return {
    horario: st.chargeTime || horarioEnv() || "09:00",
    ligado: typeof st.autoSend === "boolean" ? st.autoSend : sim(env("ENVIO_AUTOMATICO")),
    teste: u.id === ADMIN_ID ? env("WHATSAPP_TESTE").replace(/\D/g, "") : ""
  };
}
async function rodadaDe(u) {
  const inst = instanciaDe(u);
  if (!inst || !evoOk()) return "sem WhatsApp";
  const { dados } = await getEstado(u.id);
  const cfg = config(dados, u);
  if (!dados || !cfg.ligado) return "desligado";
  const { date, hm } = nowBR();
  if (hm < cfg.horario) return "antes do horário";
  if (hm >= "21:00") return "muito tarde";
  const sent = Object.fromEntries((await db.query("select loan_id from enviados where dia=$1 and usuario=$2", [date, u.id])).rows.map(r => [r.loan_id, true]));
  const list = pending(dados, sent, date);
  if (!list.length) return "nada pendente";
  // WhatsApp desconectado: espera, em vez de gastar a cobrança do dia com erro
  if ((await estadoWhats(inst)) !== "open") return "WhatsApp desconectado";
  const { l, c } = list[0];
  const ins = await db.query("insert into enviados (dia, loan_id, usuario) values ($1,$2,$3) on conflict do nothing returning loan_id", [date, l.id, u.id]);
  if (!ins.rowCount) return "já enviado";
  try {
    await enviar(inst, c.phone, message(l, c, date, { ...dados.settings, chargeTime: cfg.horario }));
    await db.query("insert into envio_log (dia, loan_id, nome, ok, usuario) values ($1,$2,$3,true,$4)", [date, l.id, c.name, u.id]);
    return "enviado para " + c.name;
  } catch (e) {
    await db.query("insert into envio_log (dia, loan_id, nome, ok, erro, usuario) values ($1,$2,$3,false,$4,$5)", [date, l.id, c.name, String(e.message || e).slice(0, 300), u.id]);
    return "erro: " + e.message;
  }
}
// uma mensagem por conta a cada rodada
async function rodada() {
  if (!evoOk()) return [];
  const us = (await db.query("select * from usuarios where ativo")).rows.filter(instanciaDe);
  const out = [];
  for (const u of us) out.push([u.login, await rodadaDe(u).catch(e => "erro: " + e.message)]);
  return out;
}
async function roboStatus(u) {
  const { date, hm } = nowBR();
  const { dados } = await getEstado(u.id);
  const cfg = config(dados, u);
  const whats = await whatsStatus(u);
  const sentRows = (await db.query("select loan_id, em from enviados where dia=$1 and usuario=$2", [date, u.id])).rows;
  const sent = Object.fromEntries(sentRows.map(r => [r.loan_id, r.em]));
  const log = (await db.query("select em, dia, nome, ok, erro from envio_log where usuario=$1 order by id desc limit 30", [u.id])).rows
    .map(r => ({ at: new Date(r.em).toISOString(), date: r.dia, name: r.nome, ok: r.ok, error: r.erro }));
  return {
    ok: true, agora: date + " " + hm, zapi: whats.estado === "open", envio: "Evolution", whats,
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
const PUBLIC = new Set(["/index.html", "/admin.html", "/manifest.webmanifest", "/sw.js", "/icon-180.png", "/icon-192.png", "/icon-512.png"]);

async function api(req, res, url) {
  const p = url.pathname;
  if (p === "/api/saude") return send(res, 200, { ok: true, banco: !!process.env.DATABASE_URL, senha: !!SENHA, envio: evoOk() });
  if (p === "/api/login" && req.method === "POST") {
    const { usuario, senha } = await readBody(req, 1e4);
    if (!SENHA) return send(res, 500, { ok: false, erro: "Falta configurar APP_SENHA no Railway" });
    const u = await login(usuario, senha);
    if (!u) { await new Promise(r => setTimeout(r, 800)); return send(res, 401, { ok: false, erro: "Usuário ou senha errados" }); }
    await db.query("update usuarios set ultimo_acesso=now() where id=$1", [u.id]);
    return send(res, 200, { ok: true, token: makeToken(u), usuario: publico(u) });
  }
  const auth = (req.headers.authorization || "").replace(/^Bearer /, "") || url.searchParams.get("t");
  const eu = await tokenUser(auth);
  if (!eu) return send(res, 401, { ok: false, erro: "Entre de novo com seu usuário e senha" });
  const uid = eu.id;

  if (p === "/api/eu") {
    db.query("update usuarios set ultimo_acesso=now() where id=$1", [uid]).catch(() => {});
    return send(res, 200, { ok: true, usuario: publico(eu) });
  }
  // a própria conta troca a senha; os outros aparelhos dela precisam entrar de novo
  if (p === "/api/senha" && req.method === "POST") {
    const b = await readBody(req, 1e4);
    if (eu.id === ADMIN_ID) return send(res, 400, { ok: false, erro: "A senha do administrador fica na variável APP_SENHA do Railway" });
    if (!confere(b.atual, eu.senha)) { await new Promise(r => setTimeout(r, 800)); return send(res, 400, { ok: false, erro: "A senha atual está errada" }); }
    if (String(b.nova || "").length < 6) return send(res, 400, { ok: false, erro: "A nova senha precisa ter pelo menos 6 caracteres" });
    const senha = hashSenha(b.nova);
    await db.query("update usuarios set senha=$2 where id=$1", [uid, senha]);
    return send(res, 200, { ok: true, token: makeToken({ ...eu, senha }) });
  }

  /* ---------- administração de usuários (só o administrador) ---------- */
  if (p.startsWith("/api/usuarios")) {
    if (!eu.admin) return send(res, 403, { ok: false, erro: "Só o administrador pode fazer isso" });
    if (p === "/api/usuarios" && req.method === "GET") {
      const r = await db.query(`select u.id, u.login, u.nome, u.admin, u.ativo, u.criado, u.ultimo_acesso,
        coalesce(jsonb_array_length(e.dados->'clients'),0) as clientes, coalesce(jsonb_array_length(e.dados->'loans'),0) as emprestimos
        from usuarios u left join estado e on e.id=u.id order by u.admin desc, u.nome`);
      return send(res, 200, { ok: true, usuarios: r.rows });
    }
    if (p === "/api/usuarios" && req.method === "POST") {
      const b = await readBody(req, 1e4);
      const login = String(b.login || "").trim().toLowerCase(), nome = String(b.nome || "").trim().slice(0, 80);
      if (!nome) return send(res, 400, { ok: false, erro: "Coloque o nome" });
      if (!/^[a-z0-9._-]{3,30}$/.test(login)) return send(res, 400, { ok: false, erro: "O usuário precisa ter de 3 a 30 letras ou números, sem espaço" });
      if (login === ADMIN) return send(res, 400, { ok: false, erro: "Esse usuário é do administrador" });
      if (String(b.senha || "").length < 6) return send(res, 400, { ok: false, erro: "A senha precisa ter pelo menos 6 caracteres" });
      try {
        const r = await db.query("insert into usuarios (login, nome, senha) values ($1,$2,$3) returning id", [login, nome, hashSenha(b.senha)]);
        return send(res, 200, { ok: true, id: r.rows[0].id });
      } catch (e) { if (e.code === "23505") return send(res, 400, { ok: false, erro: "Já existe alguém com esse usuário" }); throw e; }
    }
    const mu = p.match(/^\/api\/usuarios\/(\d+)$/);
    if (mu && req.method === "PUT") {
      const id = Number(mu[1]), b = await readBody(req, 1e4);
      if (id === ADMIN_ID) return send(res, 400, { ok: false, erro: "A senha do administrador fica na variável APP_SENHA do Railway" });
      if (b.senha !== undefined) {
        if (String(b.senha).length < 6) return send(res, 400, { ok: false, erro: "A senha precisa ter pelo menos 6 caracteres" });
        await db.query("update usuarios set senha=$2 where id=$1", [id, hashSenha(b.senha)]);
      }
      if (b.ativo !== undefined) await db.query("update usuarios set ativo=$2 where id=$1", [id, !!b.ativo]);
      if (b.nome) await db.query("update usuarios set nome=$2 where id=$1", [id, String(b.nome).trim().slice(0, 80)]);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { ok: false, erro: "Caminho desconhecido" });
  }

  /* ---------- painel do administrador: todas as contas, clientes e envios ---------- */
  if (p.startsWith("/api/admin/")) {
    if (!eu.admin) return send(res, 403, { ok: false, erro: "Só o administrador pode fazer isso" });
    if (p === "/api/admin/contas") {
      const { date } = nowBR();
      const us = (await db.query(`select u.id, u.login, u.nome, u.admin, u.ativo, u.criado, u.ultimo_acesso, u.instancia, e.atualizado,
        e.dados->'clients' as clients, e.dados->'loans' as loans, e.dados->'payments' as payments, e.dados->'settings' as settings
        from usuarios u left join estado e on e.id=u.id order by u.admin desc, u.nome`)).rows;
      const hoje = Object.fromEntries((await db.query("select usuario, count(*)::int as n from enviados where dia=$1 group by usuario", [date])).rows.map(r => [r.usuario, r.n]));
      const log = (await db.query("select usuario, em, dia, nome, ok, erro from envio_log order by id desc limit 300")).rows
        .map(r => ({ usuario: r.usuario, at: new Date(r.em).toISOString(), date: r.dia, name: r.nome, ok: r.ok, error: r.erro }));
      const contas = us.map(u => {
        const cfg = config({ settings: u.settings }, u);
        return {
          id: u.id, login: u.login, nome: u.nome, admin: u.admin, ativo: u.ativo, criado: u.criado, ultimo_acesso: u.ultimo_acesso, atualizado: u.atualizado,
          whats: !!instanciaDe(u), envio: { ligado: cfg.ligado, horario: cfg.horario }, enviadosHoje: hoje[u.id] || 0,
          clients: u.clients || [], loans: u.loans || [], payments: u.payments || []
        };
      });
      return send(res, 200, { ok: true, hoje: date, contas, log });
    }
    // estado do WhatsApp de cada conta (separado: depende da Evolution e pode demorar)
    if (p === "/api/admin/whats") {
      const us = (await db.query("select * from usuarios")).rows;
      const out = {};
      await Promise.all(us.map(async u => { out[u.id] = await whatsStatus(u).catch(e => ({ estado: "erro", erro: e.message })); }));
      return send(res, 200, { ok: true, whats: out });
    }
    return send(res, 404, { ok: false, erro: "Caminho desconhecido" });
  }

  if (p === "/api/estado" && req.method === "GET") {
    const e = await getEstado(uid);
    return send(res, 200, { ok: true, versao: e.versao, dados: e.dados, atualizado: e.atualizado });
  }
  if (p === "/api/estado" && req.method === "PUT") {
    const { base, dados, forcar } = await readBody(req, 20 * 1024 * 1024);
    if (!dados || !Array.isArray(dados.clients) || !Array.isArray(dados.loans)) return send(res, 400, { ok: false, erro: "Dados inválidos" });
    const client = await db.connect();
    try {
      await client.query("begin");
      const cur = (await client.query("select versao, dados from estado where id=$1 for update", [uid])).rows[0];
      const v = cur ? cur.versao : 0;
      if (!forcar && cur && base !== v) {
        await client.query("rollback");
        await backup(uid, dados, "conflito: cópia do celular", true); // nada se perde
        return send(res, 409, { ok: false, erro: "A nuvem tem uma versão mais nova", versao: v, dados: cur.dados });
      }
      if (cur && forcar) await client.query("insert into backups (usuario, motivo, dados) values ($1,$2,$3)", [uid, "antes de substituir", cur.dados]);
      const nv = v + 1;
      await client.query("insert into estado (id, versao, dados, atualizado) values ($3,$1,$2,now()) on conflict (id) do update set versao=$1, dados=$2, atualizado=now()", [nv, dados, uid]);
      await client.query("commit");
      backup(uid, dados, "automático").catch(() => {});
      return send(res, 200, { ok: true, versao: nv });
    } catch (e) { await client.query("rollback").catch(() => {}); throw e; } finally { client.release(); }
  }
  if (p === "/api/backups" && req.method === "GET") {
    const r = await db.query("select id, criado, motivo, jsonb_array_length(dados->'clients') as clientes from backups where usuario=$1 order by id desc limit 60", [uid]);
    return send(res, 200, { ok: true, backups: r.rows });
  }
  let m;
  if ((m = p.match(/^\/api\/backups\/(\d+)$/)) && req.method === "GET") {
    const r = await db.query("select dados from backups where id=$1 and usuario=$2", [m[1], uid]);
    return r.rows[0] ? send(res, 200, { ok: true, dados: r.rows[0].dados }) : send(res, 404, { ok: false, erro: "Backup não encontrado" });
  }
  if (p === "/api/arquivos" && req.method === "POST") {
    const { nome, tipo, base64 } = await readBody(req, MAX_FILE * 1.4);
    const buf = Buffer.from(String(base64 || ""), "base64");
    if (!buf.length) return send(res, 400, { ok: false, erro: "Arquivo vazio" });
    const id = crypto.randomUUID();
    await db.query("insert into arquivos (id, nome, tipo, tamanho, dados, usuario) values ($1,$2,$3,$4,$5,$6)", [id, String(nome || "arquivo").slice(0, 120), String(tipo || "application/octet-stream").slice(0, 80), buf.length, buf, uid]);
    return send(res, 200, { ok: true, id });
  }
  if ((m = p.match(/^\/api\/arquivos\/([\w-]+)$/))) {
    if (req.method === "DELETE") { await db.query("delete from arquivos where id=$1 and usuario=$2", [m[1], uid]); return send(res, 200, { ok: true }); }
    const r = await db.query("select nome, tipo, dados from arquivos where id=$1 and usuario=$2", [m[1], uid]);
    if (!r.rows[0]) return send(res, 404, { ok: false, erro: "Arquivo não encontrado" });
    res.writeHead(200, { ...CORS, "Content-Type": r.rows[0].tipo, "Cache-Control": "private, max-age=86400", "Content-Disposition": `inline; filename="${encodeURIComponent(r.rows[0].nome)}"` });
    return res.end(r.rows[0].dados);
  }
  /* ---------- WhatsApp e robô: cada conta usa o próprio WhatsApp ---------- */
  if (p === "/api/whats/status") return send(res, 200, { ok: true, ...(await whatsStatus(eu)) });
  if (p === "/api/whats/conectar" && req.method === "POST") return send(res, 200, { ok: true, ...(await conectarWhats(eu)) });
  if (p === "/api/whats/desconectar" && req.method === "POST") { await desconectarWhats(eu); return send(res, 200, { ok: true }); }
  // cobrança manual (botões "Cobrar" e "Cobrar todos"): sai direto pelo WhatsApp da conta, sem abrir o link
  if (p === "/api/whats/enviar" && req.method === "POST") {
    const b = await readBody(req, 1e5);
    const phone = String(b.phone || "").replace(/\D/g, ""), text = String(b.text || "").trim().slice(0, 4000);
    const loanId = String(b.loanId || "").slice(0, 60), nome = String(b.nome || "").slice(0, 80);
    if (phone.length < 10) return send(res, 400, { ok: false, erro: "O cliente precisa ter WhatsApp com DDD" });
    if (!text) return send(res, 400, { ok: false, erro: "Escreva a mensagem" });
    if (!evoOk()) return send(res, 400, { ok: false, erro: "Falta configurar EVOLUTION_URL e EVOLUTION_APIKEY no Railway" });
    const inst = instanciaDe(eu);
    if ((await estadoWhats(inst)) !== "open") return send(res, 400, { ok: false, erro: "Conecte o WhatsApp pelo QR Code em Ajustes" });
    const { date } = nowBR();
    try { await enviar(inst, phone, text); } catch (e) {
      if (loanId) await db.query("insert into envio_log (dia, loan_id, nome, ok, erro, usuario) values ($1,$2,$3,false,$4,$5)", [date, loanId, nome, String(e.message || e).slice(0, 300), uid]);
      return send(res, 502, { ok: false, erro: String(e.message || e) });
    }
    if (loanId) { // o robô não cobra de novo hoje
      await db.query("insert into enviados (dia, loan_id, usuario) values ($1,$2,$3) on conflict do nothing", [date, loanId, uid]);
      await db.query("insert into envio_log (dia, loan_id, nome, ok, usuario) values ($1,$2,$3,true,$4)", [date, loanId, nome, uid]);
    }
    return send(res, 200, { ok: true });
  }
  if (p === "/api/robo/status") return send(res, 200, await roboStatus(eu));
  if (p === "/api/robo/rodar" && req.method === "POST") return send(res, 200, { ok: true, resultado: await rodadaDe(eu) });
  if (p === "/api/robo/teste" && req.method === "POST") {
    const phone = String((await readBody(req, 1e4)).phone || "").replace(/\D/g, "") || config((await getEstado(uid)).dados, eu).teste;
    if (phone.length < 10) return send(res, 400, { ok: false, erro: "Coloque o WhatsApp com DDD para o teste" });
    if (!evoOk()) return send(res, 400, { ok: false, erro: "Falta configurar EVOLUTION_URL e EVOLUTION_APIKEY no Railway" });
    if ((await estadoWhats(instanciaDe(eu))) !== "open") return send(res, 400, { ok: false, erro: "Conecte o WhatsApp pelo QR Code primeiro" });
    await enviar(instanciaDe(eu), phone, "Teste do CashDay: o envio automático está funcionando.");
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
    const f = url.pathname === "/" ? "/index.html" : url.pathname.replace(/\/+$/, "") === "/admin" ? "/admin.html" : url.pathname;
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
  setInterval(() => rodada().then(rs => rs.forEach(([login, r]) => { if (r.startsWith("enviado") || r.startsWith("erro")) console.log("robô (" + login + "):", r); })).catch(e => console.error("robô:", e)), 120e3);
} else console.warn("Sem DATABASE_URL: adicione o Postgres no Railway.");
server.listen(PORT, () => console.log("CashDay no ar na porta " + PORT));
