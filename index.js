import express from "express";
import cors from "cors";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.NEON_DATABASE_URL,
  ssl: { rejectUnauthorized: false } // necessário para Neon
});

app.get("/health", async (_req, res) => {
  const r = await pool.query("select now()");
  res.json({ ok: true, now: r.rows[0].now });
});

app.get("/ranking", async (_req, res) => {
  const r = await pool.query("select * from ranking_view");
  res.json(r.rows);
});

// opcional: endpoint para testar lançamento de nota
app.post("/scores", async (req, res) => {
  try {
    const {
      judge_email, team_numero, etapa,
      canvas_0a20, mvp_0a30,
      impacto_0a100, modelo_0a100, inovacao_0a100, viabilidade_0a100,
      criterio_extra_0a100, observacoes
    } = req.body;

    const j = await pool.query("select id,conflito_times from judges where email=$1",[judge_email]);
    if (!j.rowCount) return res.status(400).json({ error: "Juiz não cadastrado" });
    if ((j.rows[0].conflito_times||[]).includes(Number(team_numero)))
      return res.status(400).json({ error: "Conflito de interesse" });

    const t = await pool.query("select id from teams where numero=$1",[team_numero]);
    if (!t.rowCount) return res.status(400).json({ error: "Time inexistente" });

    await pool.query(`
      insert into scores(
        judge_id,team_id,etapa,canvas_0a20,mvp_0a30,
        impacto_0a100,modelo_0a100,inovacao_0a100,viabilidade_0a100,
        criterio_extra_0a100,observacoes
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `, [
      j.rows[0].id, t.rows[0].id, etapa,
      canvas_0a20 ?? null, mvp_0a30 ?? null,
      impacto_0a100 ?? null, modelo_0a100 ?? null, inovacao_0a100 ?? null, viabilidade_0a100 ?? null,
      criterio_extra_0a100 ?? null, observacoes ?? null
    ]);

    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes("scores_unique_per_judge_team_etapa")) {
      return res.status(409).json({ error: "Avaliação já registrada para este time/etapa" });
    }
    console.error(e);
    res.status(500).json({ error: "erro interno" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("API up on", port));
