// index.js — Hackathon GO! Uai Tech API
// Execução: Render define process.env.PORT automaticamente
// Necessita env var: NEON_DATABASE_URL (pooled, com ?sslmode=require)

import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

/* ===========================
   CONFIGURAÇÃO BÁSICA
   =========================== */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const DB_URL = process.env.NEON_DATABASE_URL;
if (!DB_URL) {
  console.error("❌ Env var NEON_DATABASE_URL não definida.");
  process.exit(1);
}

// Pool Postgres (Neon)
const pool = new Pool({
  connectionString: DB_URL,
  // segurança TLS no Render/Neon
  ssl: { rejectUnauthorized: false },
});

// util de query com log simples
async function q(text, params = []) {
  const started = Date.now();
  try {
    const res = await pool.query(text, params);
    return res;
  } finally {
    const ms = Date.now() - started;
    if (ms > 250) console.log(`SQL (${ms}ms): ${text.split("\n")[0]}...`);
  }
}

/* ===========================
   ROTAS
   =========================== */

// Home amigável
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
  <meta charset="utf-8"/>
  <title>Hackathon GO! Uai Tech — API</title>
  <style>
    body{font:16px system-ui,Segoe UI,Roboto,Arial;margin:40px;line-height:1.5}
    code{background:#f3f3f3;padding:2px 6px;border-radius:6px}
    a{color:#0b5fff;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
  <h1>Hackathon GO! Uai Tech — API</h1>
  <p>API online. Use as rotas abaixo:</p>
  <ul>
    <li><a href="/health">/health</a> — teste de conexão com o banco</li>
    <li><a href="/ranking">/ranking</a> — ranking (JSON) com desempate</li>
  </ul>
  <p>Para lançar nota (exemplo com <code>fetch</code>):</p>
  <pre><code>fetch("/scores",{method:"POST",headers:{"Content-Type":"application/json"},
body: JSON.stringify({
  judge_email:"juiz1@exemplo.com",
  team_numero:1,
  etapa:"canvas",
  canvas_0a20:18,
  observacoes:"teste"
})}).then(r=>r.json()).then(console.log)</code></pre>
  `);
});

// Healthcheck (hora + versão do Postgres)
app.get("/health", async (_req, res) => {
  try {
    const now = await q("select now()");
    const ver = await q("select version()");
    res.json({ ok: true, now: now.rows[0].now, version: ver.rows[0].version });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: "db_unavailable" });
  }
});

// Ranking — usa a VIEW ranking_view criada no banco
app.get("/ranking", async (_req, res) => {
  try {
    const r = await q("select * from ranking_view order by posicao");
    res.json(r.rows);
  } catch (e) {
    console.error(e);
    // dica útil se a VIEW não existir
    const hint =
      /ranking_view/.test(String(e.message))
        ? "A VIEW ranking_view não existe. Rode o script SQL de criação da view."
        : undefined;
    res.status(500).json({ error: "ranking_failed", detail: e.message, hint });
  }
});

// Helpers de validação
const etapas = new Set(["canvas", "mvp", "pitch"]);
const clampInt = (v, lo, hi) =>
  v === null || v === undefined || v === "" ? null : Math.max(lo, Math.min(hi, parseInt(v, 10)));

// Lançar notas (juiz/admin) — versão simples
app.post("/scores", async (req, res) => {
  try {
    const {
      judge_email,
      team_numero,
      etapa,
      canvas_0a20,
      mvp_0a30,
      impacto_0a100,
      modelo_0a100,
      inovacao_0a100,
      viabilidade_0a100,
      criterio_extra_0a100,
      observacoes,
    } = req.body || {};

    if (!judge_email || !team_numero || !etapa)
      return res.status(400).json({ error: "missing_fields" });
    if (!etapas.has(etapa)) return res.status(400).json({ error: "invalid_etapa" });

    // range-check básico por etapa
    const c20 = clampInt(canvas_0a20, 0, 20);
    const m30 = clampInt(mvp_0a30, 0, 30);
    const i100 = clampInt(impacto_0a100, 0, 100);
    const md100 = clampInt(modelo_0a100, 0, 100);
    const in100 = clampInt(inovacao_0a100, 0, 100);
    const v100 = clampInt(viabilidade_0a100, 0, 100);
    const ex100 = clampInt(criterio_extra_0a100, 0, 100);

    // juiz
    const j = await q("select id, conflito_times from judges where email=$1", [judge_email]);
    if (!j.rowCount) return res.status(400).json({ error: "judge_not_found" });
    const judge_id = j.rows[0].id;
    const conflitos = j.rows[0].conflito_times || [];
    if (conflitos.includes(Number(team_numero)))
      return res.status(400).json({ error: "conflict_of_interest" });

    // team
    const t = await q("select id from teams where numero=$1", [team_numero]);
    if (!t.rowCount) return res.status(400).json({ error: "team_not_found" });
    const team_id = t.rows[0].id;

    // insert (respeita UNIQUE judge_id+team_id+etapa)
    await q(
      `
      insert into scores(
        judge_id, team_id, etapa,
        canvas_0a20, mvp_0a30,
        impacto_0a100, modelo_0a100, inovacao_0a100, viabilidade_0a100,
        criterio_extra_0a100, observacoes
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        judge_id,
        team_id,
        etapa,
        c20,
        m30,
        i100,
        md100,
        in100,
        v100,
        ex100,
        observacoes ?? null,
      ]
    );

    res.json({ ok: true });
  } catch (e) {
    const msg = String(e.message || "");
    if (msg.includes("scores_unique_per_judge_team_etapa")) {
      return res
        .status(409)
        .json({ error: "duplicate", detail: "Já existe nota deste juiz para este time/etapa." });
    }
    console.error(e);
    res.status(500).json({ error: "insert_failed", detail: e.message });
  }
});

// 404 JSON para APIs
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.path });
});

/* ===========================
   START
   =========================== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API up on ${PORT}`);
});
