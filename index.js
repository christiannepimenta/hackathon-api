// index.js — API Hackathon GO! Uai Tech
import express from "express";
import cors from "cors";
import multer from "multer";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
const { Pool } = pkg;

/* =========================
   CONFIGURAÇÕES
========================= */
const app = express();
app.use(cors()); // se quiser travar a origem: cors({ origin: ["https://SEU-SITE.vercel.app"] })
app.use(express.json({ limit: "2mb" }));

const DB_URL = process.env.NEON_DATABASE_URL;
if (!DB_URL) { console.error("NEON_DATABASE_URL ausente"); process.exit(1); }
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* =========================
   HELPERS
========================= */
async function q(text, params = []) { return pool.query(text, params); }

function sign(u) {
  return jwt.sign({ id: u.id, email: u.email, role: u.role, team_id: u.team_id }, JWT_SECRET, {
    expiresIn: "12h",
  });
}
function auth(roles) {
  return (req, res, next) => {
    try {
      const h = req.headers.authorization || "";
      const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
      if (!tok) return res.status(401).json({ error: "unauthorized" });
      const user = jwt.verify(tok, JWT_SECRET);
      if (roles && !roles.includes(user.role)) return res.status(403).json({ error: "forbidden" });
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: "unauthorized" });
    }
  };
}
async function teamIdByNumero(numero) {
  const r = await q("select id from teams where numero=$1", [numero]);
  return r.rowCount ? r.rows[0].id : null;
}
const clampInt = (v, lo, hi) => (v == null || v === "" ? null : Math.max(lo, Math.min(hi, parseInt(v, 10))));

/* =========================
   HOME & HEALTH
========================= */
app.get("/", (_req, res) =>
  res.type("html").send(`
    <h1>Hackathon GO! Uai Tech — API</h1>
    <p>Rotas úteis:</p>
    <ul>
      <li>GET <code>/health</code></li>
      <li>POST <code>/auth/login</code></li>
      <li>GET  <code>/admin/users</code> (admin)</li>
      <li>POST <code>/admin/users</code> (admin)</li>
      <li>POST <code>/scores</code> (judge/admin)</li>
      <li>GET  <code>/ranking</code> (usa <code>ranking_view</code>)</li>
    </ul>
  `)
);

app.get("/health", async (_req, res) => {
  try {
    const r = await q("select now()");
    res.json({ ok: true, now: r.rows[0].now });
  } catch {
    res.status(500).json({ ok: false });
  }
});

/* =========================
   AUTH
========================= */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const r = await q("select * from users where email=$1 and is_active=true", [email.toLowerCase()]);
    if (!r.rowCount) return res.status(401).json({ error: "invalid_credentials" });

    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = sign(u);
    res.json({
      ok: true,
      token,
      user: { id: u.id, email: u.email, role: u.role, team_id: u.team_id, nome: u.nome },
    });
  } catch (e) {
    res.status(500).json({ error: "login_failed", detail: String(e.message) });
  }
});

app.get("/me", auth(), async (req, res) => {
  const r = await q("select id,email,role,team_id,nome from users where id=$1", [req.user.id]);
  res.json({ ok: true, user: r.rows[0] });
});

/* =========================
   ADMIN — USUÁRIOS
========================= */
app.get("/admin/users", auth(["admin"]), async (_req, res) => {
  const r = await q("select id,email,role,team_id from users order by id desc");
  res.json(r.rows);
});

app.post("/admin/users", auth(["admin"]), async (req, res) => {
  try {
    const { email, nome, role, team_numero, password } = req.body || {};
    if (!email || !role || !password) return res.status(400).json({ error: "missing_fields" });
    if (!["admin", "judge", "participant"].includes(role)) return res.status(400).json({ error: "invalid_role" });

    const team_id = team_numero ? await teamIdByNumero(Number(team_numero)) : null;
    if (team_numero && !team_id) return res.status(400).json({ error: "team_not_found" });

    const hash = await bcrypt.hash(password, 10);
    const r = await q(
      "insert into users (nome,email,password_hash,role,team_id) values ($1,$2,$3,$4,$5) returning id,email,role,team_id",
      [nome || null, email.toLowerCase(), hash, role, team_id]
    );

    // Mantém tabela judges alinhada (se existir)
    if (role === "judge") {
      await q(
        "insert into judges (nome,email,conflito_times) values ($1,$2,'{}') on conflict (email) do nothing",
        [nome || email, email.toLowerCase()]
      );
    }

    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    const m = String(e.message || "");
    if (m.includes("duplicate key value")) return res.status(409).json({ error: "email_exists" });
    res.status(500).json({ error: "create_user_failed", detail: m });
  }
});

/* =========================
   SCORES (JUIZ / ADMIN)
========================= */
app.post("/scores", auth(["judge", "admin"]), async (req, res) => {
  try {
    const {
      judge_email, team_numero, etapa,
      canvas_0a20, mvp_0a30,
      impacto_0a100, modelo_0a100, inovacao_0a100, viabilidade_0a100,
      criterio_extra_0a100, observacoes
    } = req.body || {};

    if (!team_numero || !etapa) return res.status(400).json({ error: "missing_fields" });
    if (!new Set(["canvas", "mvp", "pitch"]).has(etapa)) return res.status(400).json({ error: "invalid_etapa" });

    const emailDoJuiz = (req.user.role === "judge") ? req.user.email : (judge_email || req.user.email);

    const j = await q("select id,conflito_times from judges where email=$1", [emailDoJuiz]);
    if (!j.rowCount) return res.status(400).json({ error: "judge_not_found" });
    if ((j.rows[0].conflito_times || []).includes(Number(team_numero)))
      return res.status(400).json({ error: "conflict_of_interest" });

    const team_id = await teamIdByNumero(Number(team_numero));
    if (!team_id) return res.status(400).json({ error: "team_not_found" });

    const c20 = etapa === "canvas" ? clampInt(canvas_0a20, 0, 20) : null;
    const m30 = etapa === "mvp" ? clampInt(mvp_0a30, 0, 30) : null;
    const i100 = etapa === "pitch" ? clampInt(impacto_0a100, 0, 100) : null;
    const md100 = etapa === "pitch" ? clampInt(modelo_0a100, 0, 100) : null;
    const in100 = etapa === "pitch" ? clampInt(inovacao_0a100, 0, 100) : null;
    const v100 = etapa === "pitch" ? clampInt(viabilidade_0a100, 0, 100) : null;
    const ex100 = etapa === "pitch" ? clampInt(criterio_extra_0a100, 0, 100) : null;

    await q(
      `insert into scores(
         judge_id, team_id, etapa, canvas_0a20, mvp_0a30,
         impacto_0a100, modelo_0a100, inovacao_0a100, viabilidade_0a100,
         criterio_extra_0a100, observacoes
       ) values (
         (select id from judges where email=$1), $2, $3, $4, $5,
         $6, $7, $8, $9, $10, $11
       )`,
      [emailDoJuiz, team_id, etapa, c20, m30, i100, md100, in100, v100, ex100, observacoes ?? null]
    );

    res.json({ ok: true });
  } catch (e) {
    const m = String(e.message || "");
    if (m.includes("scores_unique_per_judge_team_etapa")) return res.status(409).json({ error: "duplicate" });
    res.status(500).json({ error: "insert_failed", detail: m });
  }
});

/* =========================
   RANKING (usa VIEW já criada)
========================= */
app.get("/ranking", async (_req, res) => {
  try {
    const r = await q("select * from ranking_view order by posicao");
