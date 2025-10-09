// index.js — Hackathon API (ESM)
import express from "express";
import cors from "cors";
import multer from "multer";
import pkg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createClient } from "@supabase/supabase-js";

const { Pool } = pkg;

/* -------------------- CONFIG -------------------- */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const DB_URL = process.env.NEON_DATABASE_URL;
if (!DB_URL) {
  console.error("Faltou NEON_DATABASE_URL");
  process.exit(1);
}
const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// Supabase (opcional para uploads)
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || null;
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE)
    : null;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

/* -------------------- HELPERS -------------------- */
async function q(text, params = []) {
  return pool.query(text, params);
}
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
const clampInt = (v, lo, hi) =>
  v == null || v === "" ? null : Math.max(lo, Math.min(hi, parseInt(v, 10)));

/* -------------------- ROOT & HEALTH -------------------- */
app.get("/", (_req, res) => {
  res
    .type("html")
    .send(
      `<h1>Hackathon GO! Uai Tech — API</h1>
       <ul>
         <li>GET /health</li>
         <li>POST /auth/login</li>
         <li>GET  /admin/users (admin)</li>
         <li>POST /admin/users (admin)</li>
         <li>POST /scores (judge/admin)</li>
         <li>GET  /ranking</li>
       </ul>`
    );
});

app.get("/health", async (_req, res) => {
  try {
    const r = await q("select now()");
    res.json({ ok: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, detail: String(e.message) });
  }
});

/* -------------------- AUTH -------------------- */
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const r = await q("select * from users where email=$1 and is_active=true", [
      String(email).toLowerCase(),
    ]);
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

app.get("/me", auth(), a
