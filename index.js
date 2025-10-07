// index.js — API Hackathon (Auth própria + Roles)
import express from "express";
import cors from "cors";
import multer from "multer";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";
const { Pool } = pkg;

/* === CONFIG GERAL === */
const app = express();
app.use(cors()); // se quiser fechar, passe origin:[domínios]
app.use(express.json({ limit: "2mb" }));

const DB_URL = process.env.NEON_DATABASE_URL;
if (!DB_URL) { console.error("NEON_DATABASE_URL faltando"); process.exit(1); }
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
  : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const etapas = new Set(["canvas","mvp","pitch"]);
const tiposValidos = new Set(["canvas_pdf","mvp_onepager_pdf","mvp_link","pitch_pdf"]);

/* === HELPERS === */
async function q(text, params=[]) { return pool.query(text, params); }
const sign = (u) => jwt.sign({ id:u.id, email:u.email, role:u.role, team_id:u.team_id }, JWT_SECRET, { expiresIn: "12h" });

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
    } catch (e) {
      return res.status(401).json({ error: "unauthorized" });
    }
  };
}

async function teamIdByNumero(numero){
  const r = await q("select id from teams where numero=$1",[numero]);
  return r.rowCount ? r.rows[0].id : null;
}
function etapaFromTipo(tipo){
  if (tipo==="canvas_pdf") return "canvas";
  if (tipo==="mvp_onepager_pdf" || tipo==="mvp_link") return "mvp";
  if (tipo==="pitch_pdf") return "pitch";
  return null;
}
async function dentroDaJanela(etapa){
  const r = await q('select start, "end" from windows where etapa=$1',[etapa]);
  if (!r.rowCount) return true; // se não configurou janela, deixa passar
  const now = new Date();
  return now >= new Date(r.rows[0].start) && now <= new Date(r.rows[0].end);
}

/* === PÁGINA INICIAL === */
app.get("/", (_req,res)=> {
  res.type("html").send(`
    <h1>Hackathon GO! Uai Tech — API</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/ranking">/ranking</a></li>
    </ul>
    <p>Endpoints de auth: <code>POST /auth/setup</code>, <code>POST /auth/login</code>, <code>GET /me</code></p>
  `);
});

/* === HEALTH & RANKING === */
app.get("/health", async (_req,res)=>{
  try{
    const now = await q("select now()");
    res.json({ ok:true, now: now.rows[0].now });
  }catch(e){ res.status(500).json({ ok:false }); }
});
app.get("/ranking", async (_req,res)=>{
  try{
    const r = await q("select * from ranking_view order by posicao");
    res.json(r.rows);
  }catch(e){
    res.status(500).json({ error:"ranking_failed", detail:String(e.message) });
  }
});

/* === AUTH === */
// 1) setup inicial: cria admin se não houver nenhum usuário
app.post("/auth/setup", async (req,res)=>{
  try{
    const { email, nome, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error:"missing_fields" });
    const c = await q("select count(*)::int as n from users");
    if (c.rows[0].n > 0) return res.status(409).json({ error:"already_initialized" });
    const hash = await bcrypt.hash(password, 10);
    const r = await q(
      "insert into users (nome,email,password_hash,role) values ($1,$2,$3,'admin') returning id,email,role,team_id",
      [nome||"Admin", email.toLowerCase(), hash]
    );
    const token = sign(r.rows[0]);
    res.json({ ok:true, token, user: r.rows[0] });
  }catch(e){ res.status(500).json({ error:"setup_failed", detail:String(e.message) }); }
});

// 2) login
app.post("/auth/login", async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error:"missing_fields" });
    const r = await q("select * from users where email=$1 and is_active=true", [email.toLowerCase()]);
    if (!r.rowCount) return res.status(401).json({ error:"invalid_credentials" });
    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error:"invalid_credentials" });
    const token = sign(u);
    res.json({ ok:true, token, user: { id:u.id, email:u.email, role:u.role, team_id:u.team_id, nome:u.nome } });
  }catch(e){ res.status(500).json({ error:"login_failed", detail:String(e.message) }); }
});

// 3) perfil
app.get("/me", auth(), async (req,res)=>{
  try{
    const r = await q("select id,email,role,team_id,nome from users where id=$1",[req.user.id]);
    res.json({ ok:true, user:r.rows[0] });
  }catch(e){ res.status(500).json({ error:"me_failed" }); }
});

/* === ADMIN: CRUD mínimo de usuários === */
app.post("/admin/users", auth(["admin"]), async (req,res)=>{
  try{
    const { email, nome, role, team_numero, password } = req.body || {};
    if (!email || !role || !password) return res.status(400).json({ error:"missing_fields" });
    if (!["admin","judge","participant"].includes(role)) return res.status(400).json({ error:"invalid_role" });
    const team_id = team_numero ? await teamIdByNumero(Number(team_numero)) : null;
    if (team_numero && !team_id) return res.status(400).json({ error:"team_not_found" });

    const hash = await bcrypt.hash(password, 10);
    const r = await q(
      "insert into users (nome,email,password_hash,role,team_id) values ($1,$2,$3,$4,$5) returning id,email,role,team_id",
      [nome||null, email.toLowerCase(), hash, role, team_id]
    );

    // manter tabela 'judges' compatível com /scores
    if (role === "judge") {
      await q(`
        insert into judges (nome,email,conflito_times)
        values ($1,$2,'{}')
        on conflict (email) do nothing
      `, [nome||email, email.toLowerCase()]);
    }

    res.json({ ok:true, user:r.rows[0] });
  }catch(e){
    const m = String(e.message||"");
    if (m.includes("duplicate key value")) return res.status(409).json({ error:"email_exists" });
    res.status(500).json({ error:"create_user_failed", detail:m });
  }
});

app.get("/admin/users", auth(["admin"]), async (_req,res)=>{
  const r = await q("select id,nome,email,role,team_id,is_active from users order by role,email");
  res.json(r.rows);
});

/* === SCORES (somente judge/admin) === */
const clampInt = (v, lo, hi) => v==null || v==="" ? null : Math.max(lo, Math.min(hi, parseInt(v,10)));

app.post("/scores", auth(["judge","admin"]), async (req,res)=>{
  try{
    const {
      judge_email, team_numero, etapa,
      canvas_0a20, mvp_0a30,
      impacto_0a100, modelo_0a100, inovacao_0a100, viabilidade_0a100,
      criterio_extra_0a100, observacoes
    } = req.body || {};

    if (!team_numero || !etapa) return res.status(400).json({ error:"missing_fields" });
    if (!etapas.has(etapa)) return res.status(400).json({ error:"invalid_etapa" });

    // juiz: usa o próprio email do token; admin pode lançar por outro juiz
    const emailDoJuiz = (req.user.role === "judge") ? req.user.email : (judge_email || req.user.email);

    const j = await q("select id,conflito_times from judges where email=$1",[emailDoJuiz]);
    if (!j.rowCount) return res.status(400).json({ error:"judge_not_found" });
    if ((j.rows[0].conflito_times||[]).includes(Number(team_numero)))
      return res.status(400).json({ error:"conflict_of_interest" });

    const team_id = await teamIdByNumero(Number(team_numero));
    if (!team_id) return res.status(400).json({ error:"team_not_found" });

    const c20 = etapa==='canvas' ? clampInt(canvas_0a20,0,20) : null;
    const m30 = etapa==='mvp'    ? clampInt(mvp_0a30,0,30)   : null;
    const i100= etapa==='pitch'  ? clampInt(impacto_0a100,0,100) : null;
    const md100=etapa==='pitch'  ? clampInt(modelo_0a100,0,100)  : null;
    const in100=etapa==='pitch'  ? clampInt(inovacao_0a100,0,100): null;
    const v100= etapa==='pitch'  ? clampInt(viabilidade_0a100,0,100): null;
    const ex100=etapa==='pitch'  ? clampInt(criterio_extra_0a100,0,100): null;

    await q(`
      insert into scores(
        judge_id,team_id,etapa,canvas_0a20,mvp_0a30,
        impacto_0a100,modelo_0a100,inovacao_0a100,viabilidade_0a100,criterio_extra_0a100,observacoes
      ) values (
        (select id from judges where email=$1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
      )
    `, [emailDoJuiz, team_id, etapa, c20, m30, i100, md100, in100, v100, ex100, observacoes ?? null]);

    res.json({ ok:true });
  }catch(e){
    const m = String(e.message||"");
    if (m.includes("scores_unique_per_judge_team_etapa")) return res.status(409).json({ error:"duplicate" });
    res.status(500).json({ error:"insert_failed", detail:m });
  }
});

/* === DELIVERABLES (participant/admin) === */
app.post("/deliverables/upload", auth(["participant","admin"]), upload.single("file"), async (req,res)=>{
  try{
    if (!supabase) return res.status(500).json({ error:"storage_not_configured" });
    const { team_numero, tipo } = req.body || {};
    if (!team_numero || !tipo || !tiposValidos.has(tipo)) return res.status(400).json({ error:"missing_or_invalid_fields" });
    if (tipo === "mvp_link") return res.status(400).json({ error:"use /deliverables/link" });

    const etapa = etapaFromTipo(tipo);
    if (!etapa) return res.status(400).json({ error:"invalid_tipo" });
    if (!(await dentroDaJanela(etapa))) return res.status(400).json({ error:"fora_da_janela", etapa });

    // participante só pode enviar da própria equipe
    if (req.user.role === "participant") {
      const myTeam = req.user.team_id;
      const r = await q("select numero from teams where id=$1",[myTeam]);
      const myNum = r.rowCount ? r.rows[0].numero : null;
      if (Number(team_numero) !== Number(myNum)) return res.status(403).json({ error:"wrong_team" });
    }

    if (!req.file || req.file.mimetype !== "application/pdf") return res.status(400).json({ error:"pdf_required" });

    const team_id = await teamIdByNumero(Number(team_numero));
    if (!team_id) return res.status(400).json({ error:"team_not_found" });

    const path = `${team_numero}/${Date.now()}_${tipo}.pdf`;
    const { error: upErr } = await supabase
      .storage.from("hackathon")
      .upload(path, req.file.buffer, { contentType:"application/pdf", upsert:true });
    if (upErr) return res.status(500).json({ error:"upl
