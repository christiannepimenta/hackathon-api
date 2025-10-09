// ====== AUTH (adicionar na sua API) ======
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

// helper pra assinar o token
const sign = (u) =>
  jwt.sign(
    { id: u.id, email: u.email, role: u.role, team_id: u.team_id },
    JWT_SECRET,
    { expiresIn: "12h" }
  );

// POST /auth/login  { email, password }
app.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: "missing_fields" });

    const r = await pool.query(
      "select * from users where email=$1 and is_active=true",
      [email.toLowerCase()]
    );
    if (!r.rowCount) return res.status(401).json({ error: "invalid_credentials" });

    const u = r.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    const token = sign(u);
    res.json({
      ok: true,
      token,
      user: { id: u.id, email: u.email, role: u.role, team_id: u.team_id, nome: u.nome }
    });
  } catch (e) {
    res.status(500).json({ error: "login_failed", detail: String(e.message) });
  }
});

// GET /me  (opcional)
app.get("/me", (req, res) => {
  try {
    const h = req.headers.authorization || "";
    const tok = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!tok) return res.status(401).json({ error: "unauthorized" });
    const user = jwt.verify(tok, JWT_SECRET);
    res.json({ ok: true, user });
  } catch {
    res.status(401).json({ error: "unauthorized" });
  }
});
// ====== FIM AUTH ======
