import crypto from "node:crypto";
import http from "node:http";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pg from "pg";
import { Server as SocketServer } from "socket.io";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
const httpServer = http.createServer(app);
const io = new SocketServer(httpServer, {
  path: "/api/workspace/socket.io",
  cors: { origin: true, credentials: true },
});

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

const router = express.Router();
const schema = "product_workspace";
const sessionCookie = "vivo_workspace_session";
const sessionDays = 7;
const PLM_STAGES = [
  "Concept",
  "Initial Design Tech Pack",
  "Pattern",
  "Initial Sample",
  "Fit Session",
  "Approved",
  "Grading",
  "Costing Sample",
  "In Development",
  "Production",
  "Launched",
] as const;
const PLM_SIDE_STAGES = ["On Hold", "Dropped"] as const;
const PLM_ALL_STAGES = [...PLM_STAGES, ...PLM_SIDE_STAGES] as const;
type PlmStage = (typeof PLM_ALL_STAGES)[number];

type UserRow = {
  id: number;
  name: string;
  email: string;
  role: string;
  initials: string;
  color: string;
};

type AuthRequest = Request & { workspaceUser?: UserRow };

const users = [
  { name: "Amara Wanjiku", email: "amara@vivo.co.ke", role: "Design Director", initials: "AW", color: "#B97D55" },
  { name: "Daniel Otieno", email: "daniel@vivo.co.ke", role: "Merchandising Lead", initials: "DO", color: "#456C70" },
  { name: "Lerato Mokoena", email: "lerato@vivo.co.ke", role: "Product Developer", initials: "LM", color: "#8B6B45" },
  { name: "Nia Kamau", email: "nia@vivo.co.ke", role: "Technical Designer", initials: "NK", color: "#7F6D8A" },
  { name: "Aisha Hassan", email: "aisha@vivo.co.ke", role: "Commercial Director", initials: "AH", color: "#A75D52" },
];

const fabrics = [
  ["Linen Blend 145", "Linen / Viscose", "Nairobi", 145, "Natural, breathable handfeel for resort shirting"],
  ["Tencel Twill 190", "Tencel", "Dar es Salaam", 190, "Soft drape with clean surface"],
  ["Cotton Poplin 120", "Cotton", "Mombasa", 120, "Crisp everyday base cloth"],
  ["Silk Habotai 72", "Silk", "Nairobi", 72, "Lightweight sheen for evening capsules"],
  ["Recycled Poly Satin 98", "Recycled Polyester", "Kampala", 98, "Fluid shine with recycled content"],
  ["Ramie Slub 160", "Ramie", "Nairobi", 160, "Dry slub texture and structure"],
  ["Cotton Voile 85", "Cotton", "Kigali", 85, "Translucent soft summer layer"],
  ["Viscose Crepe 135", "Viscose", "Dar es Salaam", 135, "Fluid crepe with low crease"],
];

const styleSeeds = [
  ["VIVO-2601", "Mara Column Dress", "Vivo", "Dresses", "In review", "Amara Wanjiku", "2026-07-18", 78, 6900, "EA"],
  ["VIVO-2602", "Nairobi Pleat Trouser", "Vivo", "Trousers", "Proto", "Nia Kamau", "2026-07-24", 62, 5200, "EA"],
  ["VIVO-2603", "Lamu Tie Shirt", "Vivo", "Shirts", "Approved", "Lerato Mokoena", "2026-07-12", 94, 4100, "EA"],
  ["VIVO-2604", "Kilimani Wrap Skirt", "Vivo", "Skirts", "In review", "Amara Wanjiku", "2026-08-02", 71, 4500, "EA"],
  ["VIVO-2605", "Amani Knit Polo", "Vivo", "Knitwear", "Proto", "Lerato Mokoena", "2026-08-08", 55, 3800, "EA"],
  ["VIVO-2606", "Tsavo Utility Jacket", "Vivo", "Outerwear", "Concept", "Daniel Otieno", "2026-08-15", 33, 8900, "EA"],
  ["VIVO-2607", "Karura Bias Cami", "Vivo", "Tops", "Approved", "Amara Wanjiku", "2026-07-09", 98, 2900, "EA"],
  ["VIVO-2608", "Rift Belted Jumpsuit", "Vivo", "Jumpsuits", "In review", "Nia Kamau", "2026-08-04", 66, 7800, "EA"],
  ["VIVO-2609", "Sauti Linen Short", "Vivo", "Shorts", "Proto", "Lerato Mokoena", "2026-08-11", 49, 3200, "EA"],
  ["VIVO-2610", "Kora Pleat Blouse", "Vivo", "Blouses", "Approved", "Amara Wanjiku", "2026-07-22", 91, 4700, "EA"],
  ["SBF-2601", "Diani Resort Dress", "Safari by Vivo", "Dresses", "In review", "Daniel Otieno", "2026-07-28", 74, 6200, "EA"],
  ["SBF-2602", "Kisumu Camp Shirt", "Safari by Vivo", "Shirts", "Proto", "Lerato Mokoena", "2026-08-05", 58, 4300, "EA"],
  ["SBF-2603", "Samburu Cargo Pant", "Safari by Vivo", "Trousers", "Approved", "Nia Kamau", "2026-07-19", 96, 5600, "EA"],
  ["SBF-2604", "Maji Slip Dress", "Safari by Vivo", "Dresses", "Concept", "Amara Wanjiku", "2026-08-18", 29, 5900, "EA"],
  ["SBF-2605", "Zanzibar Shirt Dress", "Safari by Vivo", "Dresses", "In review", "Daniel Otieno", "2026-08-09", 68, 6500, "EA"],
  ["SBF-2606", "Serengeti Overshirt", "Safari by Vivo", "Outerwear", "Proto", "Lerato Mokoena", "2026-08-14", 51, 7200, "EA"],
  ["SBF-2607", "Usambara Jersey Top", "Safari by Vivo", "Tops", "Approved", "Amara Wanjiku", "2026-07-14", 93, 2800, "EA"],
  ["SBF-2608", "Mombasa Drawstring Pant", "Safari by Vivo", "Trousers", "In review", "Nia Kamau", "2026-08-07", 72, 4900, "EA"],
  ["SBF-2609", "Kagera Easy Short", "Safari by Vivo", "Shorts", "Concept", "Daniel Otieno", "2026-08-20", 36, 3100, "EA"],
  ["SBF-2610", "Nile Gathered Skirt", "Safari by Vivo", "Skirts", "Approved", "Amara Wanjiku", "2026-07-25", 89, 4400, "EA"],
] as const;

const boardSeeds = [
  ["Q3 assortment decisions", "A live room for the decisions that shape the next delivery window."],
  ["Fabric direction / high summer", "References, lab dips, and open questions for the fabric edit."],
  ["Leadership review", "A concise view of the work that needs a yes, no, or next step."],
];

function hashPassword(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, encoded: string) {
  const [salt, stored] = encoded.split(":");
  if (!salt || !stored) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(derived, "hex"));
}

function sessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function publicUser(row: UserRow) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, initials: row.initials, color: row.color };
}

async function ensureSchema() {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      initials TEXT NOT NULL,
      color TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES ${schema}.users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.fabrics (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      composition TEXT NOT NULL,
      mill TEXT NOT NULL,
      gsm INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.styles (
      id SERIAL PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      sub_category TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT '',
      order_type TEXT NOT NULL DEFAULT 'New',
      tier TEXT NOT NULL DEFAULT 'Core',
      status TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'Concept',
      stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      owner TEXT NOT NULL,
      designer TEXT NOT NULL DEFAULT '',
      pattern_maker TEXT NOT NULL DEFAULT '',
      target_date DATE NOT NULL,
      image TEXT,
      progress NUMERIC NOT NULL DEFAULT 0,
      price NUMERIC NOT NULL DEFAULT 0,
      market TEXT NOT NULL DEFAULT 'EA',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.colorways (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      hex TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Proposed',
      UNIQUE (style_id, name)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.boards (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      columns JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES ${schema}.users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.board_cards (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      column_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      assignees JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by INTEGER REFERENCES ${schema}.users(id),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (board_id, title)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.board_comments (
      id SERIAL PRIMARY KEY,
      board_id INTEGER NOT NULL REFERENCES ${schema}.boards(id) ON DELETE CASCADE,
      card_id INTEGER REFERENCES ${schema}.board_cards(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES ${schema}.users(id),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.tech_packs (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      version TEXT NOT NULL,
      owner TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notes TEXT NOT NULL DEFAULT '',
      base_pattern_reference TEXT NOT NULL DEFAULT '',
      fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL,
      trims_accessories TEXT NOT NULL DEFAULT '',
      construction_notes TEXT NOT NULL DEFAULT '',
      audaces_file_reference TEXT NOT NULL DEFAULT '',
      modified_from_style_number TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.fit_sessions (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      session_date DATE NOT NULL,
      fit_type TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      sample TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL DEFAULT '',
      attendees TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, fit_type)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.gradings (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      size_range TEXT NOT NULL,
      status TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      cad_team_member TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, size_range)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.boms (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL,
      component TEXT NOT NULL,
      consumption NUMERIC NOT NULL DEFAULT 0,
      unit TEXT NOT NULL DEFAULT 'm',
      status TEXT NOT NULL DEFAULT 'Draft',
      UNIQUE (style_id, component)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.samples_rework (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      sample_type TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      due_date DATE,
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, sample_type, round)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.sample_development (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      pattern_maker TEXT NOT NULL DEFAULT '',
      sample_makers TEXT NOT NULL DEFAULT '',
      units_ordered INTEGER NOT NULL DEFAULT 0,
      date_cut DATE,
      date_finished DATE,
      status TEXT NOT NULL DEFAULT 'Planned',
      rework_notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pom_qc (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      point TEXT,
      spec NUMERIC NOT NULL DEFAULT 0,
      actual NUMERIC NOT NULL DEFAULT 0,
      tolerance NUMERIC NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Header',
      inspector TEXT NOT NULL DEFAULT '',
      inspected_date DATE,
      stage TEXT NOT NULL DEFAULT '',
      UNIQUE (style_id, point)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.pom_qc_rows (
      id SERIAL PRIMARY KEY,
      pom_qc_id INTEGER NOT NULL REFERENCES ${schema}.pom_qc(id) ON DELETE CASCADE,
      point TEXT NOT NULL,
      target_spec NUMERIC NOT NULL DEFAULT 0,
      tolerance NUMERIC NOT NULL DEFAULT 0,
      actual NUMERIC NOT NULL DEFAULT 0,
      pass_fail TEXT NOT NULL DEFAULT 'Pending',
      notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS ${schema}.cost_estimates (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      fabric NUMERIC NOT NULL DEFAULT 0,
      trims NUMERIC NOT NULL DEFAULT 0,
      labor NUMERIC NOT NULL DEFAULT 0,
      overhead NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL DEFAULT 0,
      margin NUMERIC NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'KES',
      avg_mat_kg NUMERIC NOT NULL DEFAULT 0,
      avg_metres_used NUMERIC NOT NULL DEFAULT 0,
      mins_per_pc NUMERIC NOT NULL DEFAULT 0,
      efficiency_pct NUMERIC NOT NULL DEFAULT 0,
      material_cost NUMERIC NOT NULL DEFAULT 0,
      labour_cost NUMERIC NOT NULL DEFAULT 0,
      retail_price NUMERIC NOT NULL DEFAULT 0,
      margin_pct NUMERIC NOT NULL DEFAULT 0,
      cogs_ratio NUMERIC NOT NULL DEFAULT 0,
      set_sample_cost NUMERIC NOT NULL DEFAULT 0,
      variance NUMERIC NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS ${schema}.stage_history (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      user_id INTEGER REFERENCES ${schema}.users(id),
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcases (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      season TEXT NOT NULL,
      status TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.showcase_frames (
      id SERIAL PRIMARY KEY,
      showcase_id INTEGER NOT NULL REFERENCES ${schema}.showcases(id) ON DELETE CASCADE,
      style_id INTEGER REFERENCES ${schema}.styles(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      caption TEXT NOT NULL DEFAULT '',
      image TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'style'
    );
    CREATE TABLE IF NOT EXISTS ${schema}.quarterly_plans (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      quarter TEXT NOT NULL,
      year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'Active',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.plan_styles (
      plan_id INTEGER NOT NULL REFERENCES ${schema}.quarterly_plans(id) ON DELETE CASCADE,
      style_id INTEGER NOT NULL REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'On plan',
      PRIMARY KEY (plan_id, style_id)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.plan_history (
      id SERIAL PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES ${schema}.quarterly_plans(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      user_id INTEGER REFERENCES ${schema}.users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ${schema}.production_orders (
      id SERIAL PRIMARY KEY,
      style_id INTEGER NOT NULL UNIQUE REFERENCES ${schema}.styles(id) ON DELETE CASCADE,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'Core';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS sub_category TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS order_type TEXT NOT NULL DEFAULT 'New';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'Concept';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS designer TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.styles ADD COLUMN IF NOT EXISTS pattern_maker TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS base_pattern_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS fabric_id INTEGER REFERENCES ${schema}.fabrics(id) ON DELETE SET NULL;
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS trims_accessories TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS construction_notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS audaces_file_reference TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.tech_packs ADD COLUMN IF NOT EXISTS modified_from_style_number TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS sample TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS model_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.fit_sessions ADD COLUMN IF NOT EXISTS attendees TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.gradings ADD COLUMN IF NOT EXISTS cad_team_member TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS inspector TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS inspected_date DATE;
    ALTER TABLE ${schema}.pom_qc ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT '';
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS avg_mat_kg NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS avg_metres_used NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS mins_per_pc NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS efficiency_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS material_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS labour_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS retail_price NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS margin_pct NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS cogs_ratio NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS set_sample_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.cost_estimates ADD COLUMN IF NOT EXISTS variance NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE ${schema}.pom_qc ALTER COLUMN point DROP NOT NULL;
    UPDATE ${schema}.styles SET stage='Approved', stage_entered_at=COALESCE(stage_entered_at,NOW())
      WHERE status='Approved' AND stage='Concept';
  `);

  for (const user of users) {
    await pool.query(
      `INSERT INTO ${schema}.users (name,email,role,initials,color,password_hash)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, initials=EXCLUDED.initials, color=EXCLUDED.color`,
      [user.name, user.email, user.role, user.initials, user.color, hashPassword("vivo2026", "workspace-seed")],
    );
  }

  for (const fabric of fabrics) {
    await pool.query(
      `INSERT INTO ${schema}.fabrics (name,composition,mill,gsm,notes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (name) DO NOTHING`,
      fabric,
    );
  }

  for (const style of styleSeeds) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.styles (code,name,brand,category,status,owner,target_date,progress,price,market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, owner=EXCLUDED.owner, target_date=EXCLUDED.target_date, progress=EXCLUDED.progress, price=EXCLUDED.price
       RETURNING id`,
      [...style],
    );
    const styleId = result.rows[0]?.id;
    if (!styleId) continue;
    await pool.query(
      `INSERT INTO ${schema}.tech_packs (style_id,status,version,owner,notes)
       VALUES ($1,'In progress','v0.8',$2,'Working technical pack for the Q3 decision room.')
       ON CONFLICT (style_id) DO NOTHING`,
      [styleId, style[5]],
    );
    await pool.query(
      `INSERT INTO ${schema}.colorways (style_id,name,hex,status)
       VALUES ($1,'Sandstone','#D9C4A6','Approved'),($1,'Night sky','#172536','Proposed'),($1,'Papaya','#CF6D4F','Proposed')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.fit_sessions (style_id,session_date,fit_type,status,notes)
       VALUES ($1,'2026-07-09','First fit','Complete','Shoulder line approved; reduce hem sweep by 1.5cm.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.gradings (style_id,size_range,status,notes)
       VALUES ($1,'XS–XXL','Ready for review','Grade rule set v3 attached.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.samples_rework (style_id,sample_type,round,status,due_date,notes)
       VALUES ($1,'Proto',2,'In work','2026-08-18','Update sleeve pitch and confirm stitch detail.')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.pom_qc (style_id,point,spec,actual,tolerance,status)
       VALUES ($1,'Bust',96,96.5,1,'Pass'),($1,'Length',124,125,1,'Review'),($1,'Hem sweep',108,108,1,'Pass')
       ON CONFLICT DO NOTHING`,
      [styleId],
    );
    await pool.query(
      `INSERT INTO ${schema}.production_orders (style_id,payload)
       VALUES ($1,$2::jsonb)
       ON CONFLICT (style_id) DO NOTHING`,
      [styleId, JSON.stringify({ status: "Not released", orderNumber: `PO-${style[0]}`, quantity: 180, deliveryWindow: "Q3 2026", markets: ["Kenya", "Uganda", "Rwanda"] })],
    );
  }

  const fabricsResult = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.fabrics ORDER BY id LIMIT 8`);
  const styleResult = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.styles ORDER BY id`);
  for (let i = 0; i < Math.min(10, styleResult.rows.length); i += 1) {
    const sid = styleResult.rows[i]?.id;
    const fid = fabricsResult.rows[i % fabricsResult.rows.length]?.id;
    if (!sid || !fid) continue;
    await pool.query(
      `INSERT INTO ${schema}.boms (style_id,fabric_id,component,consumption,unit,status)
       VALUES ($1,$2,'Main fabric',$3,'m','Approved')
       ON CONFLICT DO NOTHING`,
      [sid, fid, 1.25 + (i % 4) * 0.18],
    );
    await pool.query(
      `INSERT INTO ${schema}.cost_estimates (style_id,fabric,trims,labor,overhead,total,margin)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (style_id) DO NOTHING`,
      [sid, 1550 + i * 85, 420 + i * 22, 680 + i * 30, 260 + i * 12, 2910 + i * 149, 58 - i * 0.7],
    );
  }

  const firstUser = await pool.query<{ id: number }>(`SELECT id FROM ${schema}.users ORDER BY id LIMIT 1`);
  const userId = firstUser.rows[0]?.id ?? null;
  for (const board of boardSeeds) {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.boards (title,description,columns,created_by)
       SELECT $1,$2,$3::jsonb,$4
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.boards WHERE title=$1)
       RETURNING id`,
      [board[0], board[1], JSON.stringify([{ id: "brief", title: "Brief" }, { id: "deciding", title: "Deciding" }, { id: "ready", title: "Ready" }]), userId],
    );
    const boardId = result.rows[0]?.id;
    if (boardId) {
      await pool.query(
        `INSERT INTO ${schema}.board_cards (board_id,title,description,column_id,position,style_id,tags,assignees,created_by)
         VALUES ($1,'Confirm colour story','Three colourways are ready for commercial sign-off.','deciding',0,$2,'["colour","decision"]'::jsonb,'["Amara Wanjiku","Aisha Hassan"]'::jsonb,$3),
                ($1,'Review proto notes','One open fit point remains before the next sample round.','brief',1,$4,'["fit","next"]'::jsonb,'["Nia Kamau"]'::jsonb,$3)
         ON CONFLICT DO NOTHING`,
        [boardId, styleResult.rows[0]?.id ?? null, userId, styleResult.rows[1]?.id ?? null],
      );
    }
  }

  const plan = await pool.query<{ id: number }>(
    `INSERT INTO ${schema}.quarterly_plans (name,quarter,year)
     SELECT 'Q3 2026 Assortment Plan','Q3',2026
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026)
     RETURNING id`,
  );
  for (const [name, quarter] of [["Q1 2026 Assortment Plan", "Q1"], ["Q2 2026 Assortment Plan", "Q2"], ["Q4 2026 Assortment Plan", "Q4"]] as const) {
    await pool.query(
      `INSERT INTO ${schema}.quarterly_plans (name,quarter,year)
       SELECT $1,$2,2026
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.quarterly_plans WHERE quarter=$2 AND year=2026)`,
      [name, quarter],
    );
  }
  const planId = plan.rows[0]?.id ?? (await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026 LIMIT 1`)).rows[0]?.id;
  if (planId) {
    for (let i = 0; i < Math.min(15, styleResult.rows.length); i += 1) {
      await pool.query(
        `INSERT INTO ${schema}.plan_styles (plan_id,style_id,position,decision) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [planId, styleResult.rows[i]?.id, i, i < 10 ? "On plan" : "Watch"],
      );
    }
    await pool.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id)
       SELECT $1,'Plan created','Seeded Q3 assortment plan with 15 styles.',$2
       WHERE NOT EXISTS (SELECT 1 FROM ${schema}.plan_history WHERE plan_id=$1)`,
      [planId, userId],
    );
  }

  const showcase = await pool.query<{ id: number }>(
    `INSERT INTO ${schema}.showcases (title,season,status,description)
     SELECT 'The New East','High Summer 2026','In progress','A considered edit of movement, utility, and sun-washed colour for the next Vivo story.'
     WHERE NOT EXISTS (SELECT 1 FROM ${schema}.showcases WHERE title='The New East')
     RETURNING id`,
  );
  const showcaseId = showcase.rows[0]?.id ?? (await pool.query<{ id: number }>(`SELECT id FROM ${schema}.showcases WHERE title='The New East' LIMIT 1`)).rows[0]?.id;
  if (showcaseId) {
    for (let i = 0; i < 4; i += 1) {
      await pool.query(
        `INSERT INTO ${schema}.showcase_frames (showcase_id,style_id,title,caption,image,position,kind)
         SELECT $1,$2,$3,$4,NULL,$5,'style'
         WHERE NOT EXISTS (SELECT 1 FROM ${schema}.showcase_frames WHERE showcase_id=$1 AND position=$5)`,
        [showcaseId, styleResult.rows[i]?.id ?? null, ["Sun after rain", "Soft structure", "A new utility", "The easy hour"][i], ["Linen and light", "A measured silhouette", "For the in-between days", "Unfussy, made to move"][i], i],
      );
    }
  }
}

async function findUserBySession(token?: string) {
  if (!token) return null;
  const result = await pool.query<UserRow>(
    `SELECT u.id,u.name,u.email,u.role,u.initials,u.color
     FROM ${schema}.sessions s JOIN ${schema}.users u ON u.id=s.user_id
     WHERE s.token=$1 AND s.expires_at > NOW()`,
    [token],
  );
  return result.rows[0] ?? null;
}

function requestIsHttps(req: Request) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  return req.secure || forwardedProto === "https" || process.env.NODE_ENV === "production";
}

async function createSession(userId: number, req: Request, res: Response) {
  const token = sessionToken();
  await pool.query(
    `INSERT INTO ${schema}.sessions (token,user_id,expires_at) VALUES ($1,$2,NOW()+$3::interval)`,
    [token, userId, `${sessionDays} days`],
  );
  const secure = requestIsHttps(req);
  res.cookie(sessionCookie, token, {
    httpOnly: true,
    sameSite: secure ? "none" : "lax",
    secure,
    maxAge: sessionDays * 24 * 60 * 60 * 1000,
    path: "/",
  });
}

async function requireUser(req: AuthRequest, res: Response, next: NextFunction) {
  const user = await findUserBySession(req.cookies?.[sessionCookie]);
  if (!user) {
    res.status(401).json({ error: "Sign in required" });
    return;
  }
  req.workspaceUser = user;
  next();
}

function isPlmStage(value: unknown): value is PlmStage {
  return typeof value === "string" && (PLM_ALL_STAGES as readonly string[]).includes(value);
}

function nextStage(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index >= 0 && index < PLM_STAGES.length - 1 ? PLM_STAGES[index + 1] : null;
}

function previousStage(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index > 0 ? PLM_STAGES[index - 1] : null;
}

function stageProgress(stage: string) {
  const index = PLM_STAGES.indexOf(stage as (typeof PLM_STAGES)[number]);
  return index < 0 ? 0 : Math.round((index / (PLM_STAGES.length - 1)) * 100);
}

async function getStyle(id: number) {
  const result = await pool.query(
    `SELECT id,code,name,brand,category,sub_category AS "subCategory",theme,order_type AS "orderType",
       tier,status,stage,stage AS "currentStage",owner,designer,pattern_maker AS "patternMaker",
       to_char(target_date,'YYYY-MM-DD') AS "targetDate",
       to_char(stage_entered_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
       GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-stage_entered_at))/86400))::int AS "daysInStage",
       image,progress::float,price::float,market
     FROM ${schema}.styles WHERE id=$1`,
    [id],
  );
  return result.rows[0] ?? null;
}

async function styleDetail(id: number) {
  const style = await getStyle(id);
  if (!style) return null;
  const [colorways, styleFabrics, techPack, fitSessions, gradings, boms, samples, pomQcHeader, pomQcRows, legacyPomQc, costEstimate, productionOrder, stageHistory] = await Promise.all([
    pool.query(`SELECT id,name,hex,status FROM ${schema}.colorways WHERE style_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT f.id,f.name,f.composition,f.mill,f.gsm,f.notes FROM ${schema}.boms b JOIN ${schema}.fabrics f ON f.id=b.fabric_id WHERE b.style_id=$1 ORDER BY b.id`, [id]),
    pool.query(`SELECT id,status,version,owner,to_char(updated_at,'YYYY-MM-DD') AS "updatedAt",notes,
       base_pattern_reference AS "basePatternReference",fabric_id AS "fabricId",trims_accessories AS "trimsAccessories",
       construction_notes AS "constructionNotes",audaces_file_reference AS "audacesFileReference",
       modified_from_style_number AS "modifiedFromStyleNumber"
       FROM ${schema}.tech_packs WHERE style_id=$1`, [id]),
    pool.query(`SELECT id,to_char(session_date,'YYYY-MM-DD') AS "sessionDate",fit_type AS "fitType",sample,
       model_name AS "modelName",attendees,status AS outcome,notes AS comments
       FROM ${schema}.fit_sessions WHERE style_id=$1 ORDER BY session_date DESC`, [id]),
    pool.query(`SELECT id,size_range AS "sizeRange",status,cad_team_member AS "cadTeamMember",notes FROM ${schema}.gradings WHERE style_id=$1 ORDER BY id`, [id]),
    pool.query(`SELECT b.id,b.component,b.consumption::float,b.unit,b.status,f.name AS fabric FROM ${schema}.boms b LEFT JOIN ${schema}.fabrics f ON f.id=b.fabric_id WHERE b.style_id=$1 ORDER BY b.id`, [id]),
    pool.query(`SELECT id,purpose,pattern_maker AS "patternMaker",sample_makers AS "sampleMakers",units_ordered AS "unitsOrdered",
       to_char(date_cut,'YYYY-MM-DD') AS "dateCut",to_char(date_finished,'YYYY-MM-DD') AS "dateFinished",status,rework_notes AS "reworkNotes"
       FROM ${schema}.sample_development WHERE style_id=$1 ORDER BY id DESC`, [id]),
    pool.query(`SELECT id,inspector,to_char(inspected_date,'YYYY-MM-DD') AS "inspectedDate",stage
       FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NULL ORDER BY id DESC LIMIT 1`, [id]),
    pool.query(`SELECT r.id,r.point,r.target_spec::float AS "targetSpec",r.tolerance::float,r.actual::float,
       r.pass_fail AS "passFail",r.notes
       FROM ${schema}.pom_qc_rows r JOIN ${schema}.pom_qc q ON q.id=r.pom_qc_id
       WHERE q.style_id=$1 ORDER BY r.id`, [id]),
    pool.query(`SELECT id,point,spec::float,actual::float,tolerance::float,status FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NOT NULL ORDER BY id`, [id]),
    pool.query(`SELECT fabric::float,trims::float,labor::float,overhead::float,total::float,margin::float,currency,
       avg_mat_kg::float AS "avgMatKg",avg_metres_used::float AS "avgMetresUsed",mins_per_pc::float AS "minsPerPc",
       efficiency_pct::float AS "efficiencyPct",material_cost::float AS "materialCost",labour_cost::float AS "labourCost",
       retail_price::float AS "retailPrice",margin_pct::float AS "marginPct",cogs_ratio::float AS "cogsRatio",
       set_sample_cost::float AS "setSampleCost",variance::float
       FROM ${schema}.cost_estimates WHERE style_id=$1`, [id]),
    pool.query(`SELECT payload FROM ${schema}.production_orders WHERE style_id=$1`, [id]),
    pool.query(`SELECT h.id,h.style_id AS "styleId",h.from_stage AS "fromStage",h.to_stage AS "toStage",
       h.user_id AS "userId",COALESCE(u.name,'System') AS "userName",h.note,
       to_char(h.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS timestamp
       FROM ${schema}.stage_history h LEFT JOIN ${schema}.users u ON u.id=h.user_id
       WHERE h.style_id=$1 ORDER BY h.created_at DESC,h.id DESC`, [id]),
  ]);
  const pomQc = pomQcRows.rows.length ? {
    ...(pomQcHeader.rows[0] ?? {}),
    rows: pomQcRows.rows,
  } : { ...(pomQcHeader.rows[0] ?? {}), rows: legacyPomQc.rows };
  return {
    ...style,
    colorways: colorways.rows,
    fabrics: styleFabrics.rows,
    techPack: techPack.rows[0] ?? {},
    fitSessions: fitSessions.rows,
    gradings: gradings.rows,
    boms: boms.rows,
    samples: samples.rows,
    pomQc,
    costEstimate: costEstimate.rows[0] ?? {},
    productionOrder: productionOrder.rows[0]?.payload ?? {},
    stageHistory: stageHistory.rows,
  };
}

async function planPayload(planId: number) {
  const plan = await pool.query(`SELECT id,name,quarter,year,status FROM ${schema}.quarterly_plans WHERE id=$1`, [planId]);
  const row = plan.rows[0];
  if (!row) return null;
  const styles = await pool.query(
    `SELECT s.id,s.code,s.name,s.brand,s.category,s.tier,s.status,s.owner,to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",s.image,s.progress::float,s.price::float,s.market,ps.position,ps.decision
     FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id WHERE ps.plan_id=$1 ORDER BY ps.position,s.id`,
    [planId],
  );
  const summary = await pool.query(
    `SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE s.status='Approved')::int AS approved,
      COUNT(*) FILTER (WHERE s.status='In review')::int AS review,
      COUNT(*) FILTER (WHERE s.status='Proto')::int AS proto,
      'Balanced'::text AS "rangeShape",
      '58.2%'::text AS "targetMargin"
     FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id WHERE ps.plan_id=$1`,
    [planId],
  );
  return { ...row, styles: styles.rows, summary: summary.rows[0] ?? {} };
}

router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

router.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    const result = await pool.query<UserRow & { password_hash: string }>(
      `SELECT id,name,email,role,initials,color,password_hash FROM ${schema}.users WHERE lower(email)=lower($1)`,
      [email],
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: "Email or password not recognised" });
      return;
    }
    await createSession(user.id, req, res);
    res.json({ authenticated: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get("/session", async (req, res, next) => {
  try {
    let user = await findUserBySession(req.cookies?.[sessionCookie]);
    if (!user) {
      const seeded = await pool.query<UserRow>(`SELECT id,name,email,role,initials,color FROM ${schema}.users ORDER BY id LIMIT 1`);
      user = seeded.rows[0] ?? null;
      if (user) await createSession(user.id, req, res);
    }
    res.json({ authenticated: Boolean(user), user: user ? publicUser(user) : null });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[sessionCookie];
    if (token) await pool.query(`DELETE FROM ${schema}.sessions WHERE token=$1`, [token]);
    res.clearCookie(sessionCookie, { path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

router.use(requireUser);

async function transitionStyle(id: number, toStage: string, note: string, userId: number | null) {
  if (!isPlmStage(toStage)) throw new Error("Unknown PLM stage");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ stage: string }>(
      `SELECT stage FROM ${schema}.styles WHERE id=$1 FOR UPDATE`,
      [id],
    );
    const fromStage = current.rows[0]?.stage;
    if (!fromStage) throw new Error("Style not found");
    if (fromStage === toStage) throw new Error("Style is already in that stage");
    const fromIndex = PLM_STAGES.indexOf(fromStage as (typeof PLM_STAGES)[number]);
    const toIndex = PLM_STAGES.indexOf(toStage as (typeof PLM_STAGES)[number]);
    const isSideMove = toStage === "On Hold" || toStage === "Dropped" || fromStage === "On Hold" || fromStage === "Dropped";
    if (!isSideMove && fromIndex >= 0 && toIndex >= 0 && Math.abs(fromIndex - toIndex) !== 1) {
      throw new Error("Styles must move one stage at a time");
    }
    await client.query(
      `UPDATE ${schema}.styles
       SET stage=$1,status=$1,stage_entered_at=NOW(),progress=$2,updated_at=NOW()
       WHERE id=$3`,
      [toStage, stageProgress(toStage), id],
    );
    await client.query(
      `INSERT INTO ${schema}.stage_history (style_id,from_stage,to_stage,user_id,note)
       VALUES ($1,$2,$3,$4,$5)`,
      [id, fromStage, toStage, userId, note],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return styleDetail(id);
}

router.get("/plm/meta", async (_req, res, next) => {
  try {
    const [userResult, fabricResult, categoryResult] = await Promise.all([
      pool.query(`SELECT id,name,email,role,initials,color FROM ${schema}.users ORDER BY name`),
      pool.query(`SELECT id,name,composition,mill,gsm,notes FROM ${schema}.fabrics ORDER BY name`),
      pool.query<{ category: string }>(`SELECT DISTINCT category FROM ${schema}.styles WHERE category<>'' ORDER BY category`),
    ]);
    res.json({
      users: userResult.rows,
      fabrics: fabricResult.rows,
      categories: categoryResult.rows.map((row) => row.category),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/dashboard", async (_req, res, next) => {
  try {
    const [styles, boards, plans, recent] = await Promise.all([
      pool.query<{ status: string; count: string }>(`SELECT status,COUNT(*)::int AS count FROM ${schema}.styles GROUP BY status ORDER BY count DESC`),
      pool.query<{ id: number; title: string; description: string }>(`SELECT id,title,description FROM ${schema}.boards ORDER BY id`),
      pool.query<{ count: string; avg_progress: string; avg_margin: string }>(`SELECT COUNT(*)::int AS count,COALESCE(AVG(s.progress),0)::float AS avg_progress,COALESCE(AVG(c.margin),0)::float AS avg_margin FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id LEFT JOIN ${schema}.cost_estimates c ON c.style_id=s.id`),
      pool.query(`SELECT 'Plan' AS type,'Q3 2026 assortment plan is live' AS title,'15 styles are in the decision room' AS detail,'2026-08-15T09:24:00.000Z' AS time UNION ALL SELECT 'PLM','Mara Column Dress moved to fit review','Proto round 2 is due 18 Aug','2026-08-14T15:10:00.000Z' UNION ALL SELECT 'Board','Aisha left a note on Leadership review','The retail edit is ready for a read','2026-08-13T11:42:00.000Z'`),
    ]);
    const countByStatus = Object.fromEntries(styles.rows.map((row) => [row.status.toLowerCase().replaceAll(" ", "_"), row.count]));
    res.json({
      kpis: [
        { label: "On the Q3 plan", value: Number(plans.rows[0]?.count ?? 0), suffix: "styles", tone: "gold" },
        { label: "Average development", value: Number(plans.rows[0]?.avg_progress ?? 0), suffix: "%", tone: "teal" },
        { label: "Decisions this week", value: 8, suffix: "items", tone: "ink" },
        { label: "Average margin", value: Number(plans.rows[0]?.avg_margin ?? 0), suffix: "%", tone: "coral" },
      ],
      activity: recent.rows,
      pipeline: Object.entries(countByStatus).map(([status, count]) => ({ status, count })),
      upcoming: [
        { day: "18", month: "AUG", title: "Proto round 2 · Mara Column Dress", detail: "Lerato Mokoena · Fit" },
        { day: "21", month: "AUG", title: "Q3 leadership read", detail: "Aisha Hassan · Review" },
        { day: "26", month: "AUG", title: "High Summer fabric lock", detail: "Daniel Otieno · Material" },
      ],
      boards: boards.rows,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/styles", async (req, res, next) => {
  try {
    const values: string[] = [];
    const clauses: string[] = [];
    if (req.query.brand) {
      values.push(String(req.query.brand));
      clauses.push(`brand=$${values.length}`);
    }
    if (req.query.status) {
      values.push(String(req.query.status));
      clauses.push(`status=$${values.length}`);
    }
    const filters: Record<string, string> = {
      category: "category",
      designer: "designer",
      tier: "tier",
      orderType: "order_type",
      stage: "stage",
    };
    for (const [queryKey, column] of Object.entries(filters)) {
      if (!req.query[queryKey]) continue;
      values.push(String(req.query[queryKey]));
      clauses.push(`${column}=$${values.length}`);
    }
    if (req.query.search) {
      values.push(`%${String(req.query.search)}%`);
      clauses.push(`(name ILIKE $${values.length} OR code ILIKE $${values.length} OR owner ILIKE $${values.length})`);
    }
    const result = await pool.query(
      `SELECT id,code,name,brand,category,sub_category AS "subCategory",theme,order_type AS "orderType",
       tier,status,stage,stage AS "currentStage",owner,designer,pattern_maker AS "patternMaker",
       to_char(target_date,'YYYY-MM-DD') AS "targetDate",
       to_char(stage_entered_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "stageEnteredAt",
       GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (NOW()-stage_entered_at))/86400))::int AS "daysInStage",
       image,progress::float,price::float,market
       FROM ${schema}.styles ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY target_date ASC, id ASC`,
      values,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/styles", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    const name = String(body.name ?? "").trim();
    const brand = body.brand === "Safari by Vivo" ? "Safari by Vivo" : "Vivo";
    const category = String(body.category ?? "").trim();
    const targetDate = String(body.targetDate ?? "").trim();
    if (!name || !category || !targetDate) {
      res.status(400).json({ error: "Style name, category, and target launch date are required" });
      return;
    }
    const prefix = brand === "Safari by Vivo" ? "S-" : "V-";
    let code = String(body.styleNumber ?? "").trim();
    if (!code) {
      const count = await client.query<{ next: number }>(
        `SELECT (COUNT(*)::int + 1) AS next FROM ${schema}.styles WHERE code LIKE $1`,
        [`${prefix}%`],
      );
      code = `${prefix}${new Date().getFullYear().toString().slice(-2)}${String(count.rows[0]?.next ?? 1).padStart(3, "0")}`;
    }
    const designer = String(body.designer ?? "").trim();
    const patternMaker = String(body.patternMaker ?? "").trim();
    const tier = ["1", "2", "3", "4"].includes(String(body.tier)) ? String(body.tier) : "1";
    await client.query("BEGIN");
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO ${schema}.styles
       (code,name,brand,category,sub_category,theme,order_type,tier,status,stage,stage_entered_at,owner,designer,pattern_maker,target_date,progress,price,market)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Concept','Concept',NOW(),$9,$9,$10,$11,0,0,'EA')
       RETURNING id`,
      [
        code,
        name,
        brand,
        category,
        String(body.subCategory ?? ""),
        String(body.theme ?? ""),
        body.orderType === "Repeat" ? "Repeat" : "New",
        tier,
        designer || "Unassigned",
        patternMaker,
        targetDate,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error("Style could not be created");
    await client.query(
      `INSERT INTO ${schema}.stage_history (style_id,from_stage,to_stage,user_id,note)
       VALUES ($1,NULL,'Concept',$2,'Style created in PLM')`,
      [id, req.workspaceUser?.id ?? null],
    );
    await client.query("COMMIT");
    res.status(201).json(await styleDetail(id));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") {
      res.status(409).json({ error: "That style number already exists" });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
});

router.get("/styles/:id", async (req, res, next) => {
  try {
    const result = await styleDetail(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/styles/:id/plm", async (req, res, next) => {
  try {
    const result = await styleDetail(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Style not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.patch("/styles/:id", async (req: AuthRequest, res, next) => {
  try {
    const allowed = ["status", "owner", "designer", "patternMaker", "subCategory", "theme", "orderType", "targetDate", "progress", "price", "tier"] as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (req.body?.[key] === undefined) continue;
      values.push(req.body[key]);
      const column = key === "targetDate" ? "target_date" : key === "patternMaker" ? "pattern_maker" : key === "subCategory" ? "sub_category" : key;
      assignments.push(`${column}=$${values.length}`);
    }
    if (!assignments.length) {
      res.status(400).json({ error: "No editable fields supplied" });
      return;
    }
    values.push(req.params.id);
    await pool.query(`UPDATE ${schema}.styles SET ${assignments.join(",")},updated_at=NOW() WHERE id=$${values.length}`, values);
    const result = await styleDetail(Number(req.params.id));
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/transition", async (req: AuthRequest, res, next) => {
  try {
    const result = await transitionStyle(
      Number(req.params.id),
      String(req.body?.toStage ?? ""),
      String(req.body?.note ?? ""),
      req.workspaceUser?.id ?? null,
    );
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Style could not be transitioned";
    if (message === "Style not found") {
      res.status(404).json({ error: message });
      return;
    }
    res.status(400).json({ error: message });
  }
});

router.put("/styles/:id/tech-pack", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(
      `INSERT INTO ${schema}.tech_packs
       (style_id,status,version,owner,notes,base_pattern_reference,fabric_id,trims_accessories,construction_notes,audaces_file_reference,modified_from_style_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (style_id) DO UPDATE SET status=EXCLUDED.status,version=EXCLUDED.version,owner=EXCLUDED.owner,
       notes=EXCLUDED.notes,base_pattern_reference=EXCLUDED.base_pattern_reference,fabric_id=EXCLUDED.fabric_id,
       trims_accessories=EXCLUDED.trims_accessories,construction_notes=EXCLUDED.construction_notes,
       audaces_file_reference=EXCLUDED.audaces_file_reference,modified_from_style_number=EXCLUDED.modified_from_style_number,
       updated_at=NOW()`,
      [
        Number(req.params.id),
        String(body.status ?? "In progress"),
        String(body.version ?? "v1"),
        String(body.owner ?? ""),
        String(body.notes ?? ""),
        String(body.basePatternReference ?? ""),
        body.fabricId ? Number(body.fabricId) : null,
        String(body.trimsAccessories ?? ""),
        String(body.constructionNotes ?? ""),
        String(body.audacesFileReference ?? ""),
        String(body.modifiedFromStyleNumber ?? ""),
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/fit-sessions", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const sessionDate = String(body.sessionDate ?? "");
    const sample = String(body.sample ?? "Fit sample");
    await pool.query(
      `INSERT INTO ${schema}.fit_sessions
       (style_id,session_date,fit_type,status,notes,sample,model_name,attendees)
       VALUES ($1,$2,$3,$4,$5,$3,$6,$7)`,
      [
        Number(req.params.id),
        sessionDate,
        `${sample} · ${sessionDate} · ${Date.now()}`,
        String(body.outcome ?? "Needs Revision"),
        String(body.comments ?? ""),
        String(body.modelName ?? ""),
        String(body.attendees ?? ""),
      ],
    );
    res.status(201).json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/grading", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(`DELETE FROM ${schema}.gradings WHERE style_id=$1`, [Number(req.params.id)]);
    await pool.query(
      `INSERT INTO ${schema}.gradings (style_id,size_range,status,notes,cad_team_member)
       VALUES ($1,$2,$3,'',$4)`,
      [
        Number(req.params.id),
        String(body.sizeRange ?? "Combined"),
        String(body.status ?? "Pending"),
        String(body.cadTeamMember ?? ""),
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.post("/styles/:id/samples", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    await pool.query(
      `INSERT INTO ${schema}.sample_development
       (style_id,purpose,pattern_maker,sample_makers,units_ordered,date_cut,date_finished,status,rework_notes)
       VALUES ($1,$2,$3,$4,$5,NULLIF($6,'')::date,NULLIF($7,'')::date,$8,$9)`,
      [
        Number(req.params.id),
        String(body.purpose ?? "Proto"),
        String(body.patternMaker ?? ""),
        String(body.sampleMakers ?? ""),
        Number(body.unitsOrdered ?? 0),
        String(body.dateCut ?? ""),
        String(body.dateFinished ?? ""),
        String(body.status ?? "Planned"),
        String(body.reworkNotes ?? ""),
      ],
    );
    res.status(201).json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/cost-estimate", async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const avgMatKg = Number(body.avgMatKg ?? 0);
    const avgMetresUsed = Number(body.avgMetresUsed ?? 0);
    const minsPerPc = Number(body.minsPerPc ?? 0);
    const efficiencyPct = Number(body.efficiencyPct ?? 0);
    const retailPrice = Number(body.retailPrice ?? 0);
    const materialCost = body.materialCost === undefined ? avgMatKg * avgMetresUsed : Number(body.materialCost);
    const labourCost = body.labourCost === undefined
      ? minsPerPc * (efficiencyPct > 0 ? 1 / (efficiencyPct / 100) : 1)
      : Number(body.labourCost);
    const totalCost = body.totalCost === undefined ? materialCost + labourCost : Number(body.totalCost);
    const marginPct = body.marginPct === undefined && retailPrice > 0 ? ((retailPrice - totalCost) / retailPrice) * 100 : Number(body.marginPct ?? 0);
    const cogsRatio = body.cogsRatio === undefined && retailPrice > 0 ? (totalCost / retailPrice) * 100 : Number(body.cogsRatio ?? 0);
    const setSampleCost = Number(body.setSampleCost ?? 0);
    const variance = body.variance === undefined ? setSampleCost - totalCost : Number(body.variance);
    await pool.query(
      `INSERT INTO ${schema}.cost_estimates
       (style_id,fabric,trims,labor,overhead,total,margin,currency,avg_mat_kg,avg_metres_used,mins_per_pc,efficiency_pct,material_cost,labour_cost,retail_price,margin_pct,cogs_ratio,set_sample_cost,variance)
       VALUES ($1,$2,0,$3,0,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (style_id) DO UPDATE SET fabric=EXCLUDED.fabric,labor=EXCLUDED.labor,total=EXCLUDED.total,margin=EXCLUDED.margin,
       currency=EXCLUDED.currency,avg_mat_kg=EXCLUDED.avg_mat_kg,avg_metres_used=EXCLUDED.avg_metres_used,
       mins_per_pc=EXCLUDED.mins_per_pc,efficiency_pct=EXCLUDED.efficiency_pct,material_cost=EXCLUDED.material_cost,
       labour_cost=EXCLUDED.labour_cost,retail_price=EXCLUDED.retail_price,margin_pct=EXCLUDED.margin_pct,
       cogs_ratio=EXCLUDED.cogs_ratio,set_sample_cost=EXCLUDED.set_sample_cost,variance=EXCLUDED.variance`,
      [
        Number(req.params.id),
        materialCost,
        labourCost,
        totalCost,
        marginPct,
        String(body.currency ?? "KES"),
        avgMatKg,
        avgMetresUsed,
        minsPerPc,
        efficiencyPct,
        materialCost,
        labourCost,
        retailPrice,
        marginPct,
        cogsRatio,
        setSampleCost,
        variance,
      ],
    );
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    next(error);
  }
});

router.put("/styles/:id/pom-qc", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const body = req.body ?? {};
    await client.query("BEGIN");
    const header = await client.query<{ id: number }>(
      `SELECT id FROM ${schema}.pom_qc WHERE style_id=$1 AND point IS NULL ORDER BY id DESC LIMIT 1`,
      [Number(req.params.id)],
    );
    let headerId = header.rows[0]?.id;
    if (headerId) {
      await client.query(
        `UPDATE ${schema}.pom_qc SET inspector=$1,inspected_date=NULLIF($2,'')::date,stage=$3,status='Header' WHERE id=$4`,
        [String(body.inspector ?? ""), String(body.inspectedDate ?? ""), String(body.stage ?? ""), headerId],
      );
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO ${schema}.pom_qc (style_id,point,spec,actual,tolerance,status,inspector,inspected_date,stage)
         VALUES ($1,NULL,0,0,0,'Header',$2,NULLIF($3,'')::date,$4) RETURNING id`,
        [Number(req.params.id), String(body.inspector ?? ""), String(body.inspectedDate ?? ""), String(body.stage ?? "")],
      );
      headerId = inserted.rows[0]?.id;
    }
    if (!headerId) throw new Error("POM QC header could not be created");
    await client.query(`DELETE FROM ${schema}.pom_qc_rows WHERE pom_qc_id=$1`, [headerId]);
    for (const row of Array.isArray(body.rows) ? body.rows : []) {
      const targetSpec = Number(row.targetSpec ?? 0);
      const actual = Number(row.actual ?? 0);
      const tolerance = Number(row.tolerance ?? 0);
      const passFail = String(row.passFail ?? (Math.abs(actual - targetSpec) <= tolerance ? "Pass" : "Fail"));
      await client.query(
        `INSERT INTO ${schema}.pom_qc_rows (pom_qc_id,point,target_spec,tolerance,actual,pass_fail,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [headerId, String(row.point ?? ""), targetSpec, tolerance, actual, passFail, String(row.notes ?? "")],
      );
    }
    await client.query("COMMIT");
    res.json(await styleDetail(Number(req.params.id)));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.get("/plan", async (req, res, next) => {
  try {
    const quarter = /^Q[1-4]$/.test(String(req.query.quarter ?? "")) ? String(req.query.quarter) : "Q3";
    const parsedYear = Number(req.query.year);
    const year = Number.isInteger(parsedYear) && parsedYear >= 2020 && parsedYear <= 2100 ? parsedYear : 2026;
    const plan = await pool.query(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter=$1 AND year=$2 LIMIT 1`, [quarter, year]);
    const row = plan.rows[0];
    if (!row) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const payload = await planPayload(row.id);
    if (!payload) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

router.get("/plans", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT p.id,p.name,p.quarter,p.year,p.status,COUNT(ps.style_id)::int AS "styleCount"
       FROM ${schema}.quarterly_plans p
       LEFT JOIN ${schema}.plan_styles ps ON ps.plan_id=p.id
       GROUP BY p.id
       ORDER BY p.year DESC,p.quarter ASC`,
    );
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post("/plan", async (req: AuthRequest, res, next) => {
  try {
    const name = String(req.body?.name ?? "").trim();
    const quarter = String(req.body?.quarter ?? "");
    const year = Number(req.body?.year);
    if (!name || !/^Q[1-4]$/.test(quarter) || !Number.isInteger(year) || year < 2020 || year > 2100) {
      res.status(400).json({ error: "Name, quarter, and year are required" });
      return;
    }
    const existing = await pool.query(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter=$1 AND year=$2 LIMIT 1`, [quarter, year]);
    if (existing.rows[0]) {
      res.status(409).json({ error: "A plan already exists for that quarter" });
      return;
    }
    const created = await pool.query<{ id: number }>(
      `INSERT INTO ${schema}.quarterly_plans (name,quarter,year) VALUES ($1,$2,$3) RETURNING id`,
      [name, quarter, year],
    );
    const planId = created.rows[0]?.id;
    if (!planId) {
      res.status(500).json({ error: "Plan could not be created" });
      return;
    }
    await pool.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Plan created',$2,$3)`,
      [planId, `${name} created.`, req.workspaceUser?.id ?? null],
    );
    res.status(201).json(await planPayload(planId));
  } catch (error) {
    next(error);
  }
});

router.post("/plan/styles", async (req: AuthRequest, res, next) => {
  const client = await pool.connect();
  try {
    const planId = Number(req.body?.planId);
    const styleId = req.body?.styleId === undefined ? null : Number(req.body.styleId);
    const category = String(req.body?.category ?? "").trim();
    const tier = String(req.body?.tier ?? "").trim();
    if (!Number.isInteger(planId) || planId < 1) {
      res.status(400).json({ error: "A plan is required" });
      return;
    }
    await client.query("BEGIN");
    const plan = await client.query<{ id: number; quarter: string; year: number }>(
      `SELECT id,quarter,year FROM ${schema}.quarterly_plans WHERE id=$1 FOR UPDATE`,
      [planId],
    );
    if (!plan.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    let resolvedStyleId = styleId;
    if (styleId !== null) {
      const existingStyle = await client.query(`SELECT id FROM ${schema}.styles WHERE id=$1`, [styleId]);
      if (!existingStyle.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Style not found" });
        return;
      }
    } else {
      if (!category || !tier) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Category and tier are required for a placeholder" });
        return;
      }
      const code = `PLACEHOLDER-${plan.rows[0].year}-${plan.rows[0].quarter}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
      const placeholder = await client.query<{ id: number }>(
        `INSERT INTO ${schema}.styles (code,name,brand,category,tier,status,owner,target_date,progress,price,market)
         VALUES ($1,$2,'Vivo',$3,$4,'Draft','Unassigned',CURRENT_DATE,0,0,'EA') RETURNING id`,
        [code, `${category} placeholder`, category, tier],
      );
      resolvedStyleId = placeholder.rows[0]?.id ?? null;
    }
    if (!resolvedStyleId) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Style could not be prepared" });
      return;
    }
    const position = await client.query<{ next: number }>(
      `SELECT COALESCE(MAX(position) + 1, 0)::int AS next FROM ${schema}.plan_styles WHERE plan_id=$1`,
      [planId],
    );
    const inserted = await client.query(
      `INSERT INTO ${schema}.plan_styles (plan_id,style_id,position,decision) VALUES ($1,$2,$3,'On plan') ON CONFLICT DO NOTHING RETURNING style_id`,
      [planId, resolvedStyleId, position.rows[0]?.next ?? 0],
    );
    if (!inserted.rows[0]) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "That style is already on this plan" });
      return;
    }
    await client.query(
      `INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Style added',$2,$3)`,
      [planId, `Style added to ${plan.rows[0].quarter} ${plan.rows[0].year}.`, req.workspaceUser?.id ?? null],
    );
    await client.query("COMMIT");
    res.status(201).json(await planPayload(planId));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

router.patch("/plan", async (req: AuthRequest, res, next) => {
  try {
    const requestedId = Number(req.body?.planId);
    const plan = Number.isInteger(requestedId) && requestedId > 0
      ? await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE id=$1`, [requestedId])
      : await pool.query<{ id: number }>(`SELECT id FROM ${schema}.quarterly_plans WHERE quarter='Q3' AND year=2026 LIMIT 1`);
    const planId = plan.rows[0]?.id;
    if (!planId) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const name = req.body?.name ? String(req.body.name) : undefined;
    const quarter = req.body?.quarter ? String(req.body.quarter) : undefined;
    const year = req.body?.year ? Number(req.body.year) : undefined;
    await pool.query(`UPDATE ${schema}.quarterly_plans SET name=COALESCE($1,name),quarter=COALESCE($2,quarter),year=COALESCE($3,year),updated_at=NOW() WHERE id=$4`, [name, quarter, year, planId]);
    await pool.query(`INSERT INTO ${schema}.plan_history (plan_id,action,detail,user_id) VALUES ($1,'Plan updated',$2,$3)`, [planId, name ? `Plan renamed to ${name}` : "Plan metadata updated", req.workspaceUser?.id ?? null]);
    const refreshed = await pool.query(`SELECT id,name,quarter,year FROM ${schema}.quarterly_plans WHERE id=$1`, [planId]);
    const styles = await pool.query(`SELECT s.id,s.code,s.name,s.brand,s.category,s.status,s.owner,to_char(s.target_date,'YYYY-MM-DD') AS "targetDate",s.image,s.progress::float,s.price,s.market,ps.position,ps.decision FROM ${schema}.plan_styles ps JOIN ${schema}.styles s ON s.id=ps.style_id WHERE ps.plan_id=$1 ORDER BY ps.position`, [planId]);
    res.json({ ...(await planPayload(planId)), ...refreshed.rows[0], styles: styles.rows });
  } catch (error) {
    next(error);
  }
});

router.get("/plan/history", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT h.id,h.plan_id AS "planId",h.action,h.detail,u.name AS actor,h.created_at AS "createdAt" FROM ${schema}.plan_history h LEFT JOIN ${schema}.users u ON u.id=h.user_id ORDER BY h.created_at DESC`);
    res.json(result.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })));
  } catch (error) {
    next(error);
  }
});

async function boardPayload(boardId: number) {
  const board = await pool.query(`SELECT id,title,description,columns FROM ${schema}.boards WHERE id=$1`, [boardId]);
  if (!board.rows[0]) return null;
  const [cards, comments, collaborators] = await Promise.all([
    pool.query(`SELECT id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees FROM ${schema}.board_cards WHERE board_id=$1 ORDER BY position,id`, [boardId]),
    pool.query(`SELECT c.id,c.board_id AS "boardId",c.card_id AS "cardId",c.body,c.created_at AS "createdAt",json_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'initials',u.initials,'color',u.color) AS author FROM ${schema}.board_comments c JOIN ${schema}.users u ON u.id=c.user_id WHERE c.board_id=$1 ORDER BY c.created_at`, [boardId]),
    pool.query(`SELECT DISTINCT u.id,u.name,u.email,u.role,u.initials,u.color FROM ${schema}.users u JOIN ${schema}.board_cards c ON c.created_by=u.id WHERE c.board_id=$1`, [boardId]),
  ]);
  return { ...board.rows[0], cards: cards.rows, comments: comments.rows.map((row) => ({ ...row, createdAt: iso(row.createdAt) })), collaborators: collaborators.rows };
}

router.get("/boards", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT b.id,b.title,b.description,b.columns,COUNT(c.id)::int AS "cardCount" FROM ${schema}.boards b LEFT JOIN ${schema}.board_cards c ON c.board_id=b.id GROUP BY b.id ORDER BY b.id`);
    const payloads = await Promise.all(result.rows.map((row) => boardPayload(row.id)));
    res.json(payloads.filter(Boolean));
  } catch (error) {
    next(error);
  }
});

router.post("/boards", async (req: AuthRequest, res, next) => {
  try {
    const result = await pool.query<{ id: number }>(`INSERT INTO ${schema}.boards (title,description,columns,created_by) VALUES ($1,$2,$3::jsonb,$4) RETURNING id`, [String(req.body?.title ?? "Untitled board"), String(req.body?.description ?? ""), JSON.stringify([{ id: "brief", title: "Brief" }, { id: "deciding", title: "Deciding" }, { id: "ready", title: "Ready" }]), req.workspaceUser?.id ?? null]);
    const created = await boardPayload(result.rows[0].id);
    res.status(201).json(created);
  } catch (error) {
    next(error);
  }
});

router.get("/boards/:id", async (req, res, next) => {
  try {
    const result = await boardPayload(Number(req.params.id));
    if (!result) {
      res.status(404).json({ error: "Board not found" });
      return;
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/boards/:id/cards", async (req: AuthRequest, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const positionResult = await pool.query<{ max: number | null }>(`SELECT MAX(position)::int AS max FROM ${schema}.board_cards WHERE board_id=$1 AND column_id=$2`, [boardId, String(req.body?.columnId ?? "brief")]);
    const result = await pool.query(`INSERT INTO ${schema}.board_cards (board_id,title,description,column_id,position,style_id,tags,assignees,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) RETURNING id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees`, [boardId, String(req.body?.title ?? "New decision"), String(req.body?.description ?? ""), String(req.body?.columnId ?? "brief"), (positionResult.rows[0]?.max ?? -1) + 1, req.body?.styleId ? Number(req.body.styleId) : null, JSON.stringify(req.body?.tags ?? []), JSON.stringify(req.body?.assignees ?? []), req.workspaceUser?.id ?? null]);
    const card = result.rows[0];
    io.to(`board:${boardId}`).emit("board:card-created", card);
    res.status(201).json(card);
  } catch (error) {
    next(error);
  }
});

router.post("/boards/:id/comments", async (req: AuthRequest, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const result = await pool.query(`INSERT INTO ${schema}.board_comments (board_id,card_id,user_id,body) VALUES ($1,$2,$3,$4) RETURNING id,board_id AS "boardId",card_id AS "cardId",body,created_at AS "createdAt"`, [boardId, req.body?.cardId ? Number(req.body.cardId) : null, req.workspaceUser?.id, String(req.body?.body ?? "")]);
    const comment = { ...result.rows[0], createdAt: iso(result.rows[0].createdAt), author: publicUser(req.workspaceUser!) };
    io.to(`board:${boardId}`).emit("board:comment-created", comment);
    res.status(201).json(comment);
  } catch (error) {
    next(error);
  }
});

router.patch("/boards/:id/cards/:cardId", async (req, res, next) => {
  try {
    const boardId = Number(req.params.id);
    const cardId = Number(req.params.cardId);
    const allowed = ["title", "description", "columnId", "position", "tags"] as const;
    const assignments: string[] = [];
    const values: unknown[] = [];
    for (const key of allowed) {
      if (req.body?.[key] === undefined) continue;
      const column = key === "columnId" ? "column_id" : key;
      const value = key === "tags" ? JSON.stringify(req.body[key]) : req.body[key];
      values.push(value);
      assignments.push(`${column}${key === "tags" ? "::jsonb" : ""}=$${values.length}`);
    }
    if (!assignments.length) {
      res.status(400).json({ error: "No card fields supplied" });
      return;
    }
    values.push(cardId, boardId);
    const result = await pool.query(
      `UPDATE ${schema}.board_cards SET ${assignments.join(",")},updated_at=NOW()
       WHERE id=$${values.length - 1} AND board_id=$${values.length}
       RETURNING id,board_id AS "boardId",title,description,column_id AS "columnId",position,style_id AS "styleId",tags,assignees`,
      values,
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Card not found" });
      return;
    }
    io.to(`board:${boardId}`).emit("board:card-moved", result.rows[0]);
    res.json(result.rows[0]);
  } catch (error) {
    next(error);
  }
});

router.get("/showcases", async (_req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,title,season,status,description FROM ${schema}.showcases ORDER BY id`);
    const frames = await pool.query(`SELECT id,showcase_id AS "showcaseId",style_id AS "styleId",title,caption,image,position,kind FROM ${schema}.showcase_frames ORDER BY position`);
    res.json(result.rows.map((showcase) => ({ ...showcase, frames: frames.rows.filter((frame) => frame.showcaseId === showcase.id) })));
  } catch (error) {
    next(error);
  }
});

router.get("/showcases/:id", async (req, res, next) => {
  try {
    const result = await pool.query(`SELECT id,title,season,status,description FROM ${schema}.showcases WHERE id=$1`, [Number(req.params.id)]);
    if (!result.rows[0]) {
      res.status(404).json({ error: "Showcase not found" });
      return;
    }
    const frames = await pool.query(`SELECT id,showcase_id AS "showcaseId",style_id AS "styleId",title,caption,image,position,kind FROM ${schema}.showcase_frames WHERE showcase_id=$1 ORDER BY position`, [Number(req.params.id)]);
    res.json({ ...result.rows[0], frames: frames.rows });
  } catch (error) {
    next(error);
  }
});

app.use("/api/workspace", router);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  if (!res.headersSent) res.status(500).json({ error: "Workspace server error" });
});

const boardPresence = new Map<string, Set<string>>();
io.on("connection", (socket) => {
  socket.on("join-board", (boardId: number | string) => {
    const room = `board:${Number(boardId)}`;
    socket.join(room);
    const set = boardPresence.get(room) ?? new Set<string>();
    set.add(socket.id);
    boardPresence.set(room, set);
    io.to(room).emit("board:presence", { count: set.size });
    socket.on("disconnect", () => {
      set.delete(socket.id);
      io.to(room).emit("board:presence", { count: set.size });
    });
  });
  socket.on("board:card-moved", (payload: { boardId: number; cardId: number; columnId: string; position: number }) => {
    socket.to(`board:${payload.boardId}`).emit("board:card-moved", payload);
  });
});

const port = Number(process.env.PORT ?? 23661);

ensureSchema()
  .then(() => {
    httpServer.listen(port, "0.0.0.0", () => console.log(`Vivo workspace API listening on ${port}`));
  })
  .catch((error) => {
    console.error("Unable to initialise workspace database", error);
    process.exit(1);
  });

process.on("SIGTERM", () => {
  void pool.end().finally(() => process.exit(0));
});

export { app, pool };