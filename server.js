const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DB_PATH = process.env.DB_PATH || path.join(ROOT, "data", "gestionpro.sqlite");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'COMPANY_OWNER', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, location TEXT DEFAULT '', UNIQUE(company_id,name)
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL, name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'unité',
  min_stock INTEGER NOT NULL DEFAULT 0, UNIQUE(company_id,code)
);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  product_id INTEGER NOT NULL REFERENCES products(id), warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  quantity INTEGER NOT NULL, reason TEXT NOT NULL, note TEXT DEFAULT '',
  created_by INTEGER NOT NULL REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK(kind IN ('INCOME','EXPENSE')), label TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL CHECK(currency IN ('USD','CDF')),
  category TEXT DEFAULT '', created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL REFERENCES companies(id),
  registration TEXT NOT NULL, label TEXT NOT NULL, driver TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Disponible',
  UNIQUE(company_id,registration)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER,
  details TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_movements_company ON stock_movements(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_company ON transactions(company_id, created_at DESC);
`);
const q = (sql, ...args) => db.prepare(sql).get(...args);
const all = (sql, ...args) => db.prepare(sql).all(...args);
const run = (sql, ...args) => db.prepare(sql).run(...args);
const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
};
const verifyPassword = (password, stored) => {
  try {
    const [salt, key] = stored.split(":");
    const actual = Buffer.from(crypto.scryptSync(password, salt, 64).toString("hex"), "hex");
    const expected = Buffer.from(key, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
};
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
function audit(user, action, entity, entityId, details="") {
  run("INSERT INTO audit_logs(company_id,user_id,action,entity,entity_id,details) VALUES(?,?,?,?,?,?)",
    user.company_id, user.id, action, entity, entityId || null, details);
}
function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", tokenHash(token), userId, Date.now()+7*86400000);
  return token;
}
function currentUser(req) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map(s=>s.trim()).filter(Boolean).map(s=>{
    const i=s.indexOf("="); return [s.slice(0,i), decodeURIComponent(s.slice(i+1))];
  }));
  const token = cookies.gp_session;
  if (!token) return null;
  const session = q("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?", tokenHash(token), Date.now());
  if (!session) return null;
  return q("SELECT u.id,u.name,u.email,u.role,u.company_id,c.name company_name,c.currency FROM users u JOIN companies c ON c.id=u.company_id WHERE u.id=?", session.user_id) || null;
}
function ensureDemo() {
  const demo = q("SELECT id FROM users WHERE email=?", "demo@gestionpro.cd");
  if (demo) return;
  const companyId = Number(run("INSERT INTO companies(name,currency) VALUES(?,?)", "Entreprise Démo RDC", "USD").lastInsertRowid);
  const userId = Number(run("INSERT INTO users(company_id,name,email,password_hash,role) VALUES(?,?,?,?,?)",
    companyId, "Administrateur Démo", "demo@gestionpro.cd", hashPassword("GestionPro2026!"), "COMPANY_OWNER").lastInsertRowid);
  const wh1 = Number(run("INSERT INTO warehouses(company_id,name,location) VALUES(?,?,?)", companyId, "Dépôt principal", "Lubumbashi").lastInsertRowid);
  const wh2 = Number(run("INSERT INTO warehouses(company_id,name,location) VALUES(?,?,?)", companyId, "Entrepôt secondaire", "Kolwezi").lastInsertRowid);
  const seedProducts = [
    ["SUP-001","Gasoil","litre",50,160,wh1],
    ["SUP-002","Gants de protection","boîte",20,12,wh1],
    ["SUP-003","Papier A4","ramette",10,34,wh2],
    ["SUP-004","Filtres à huile","pièce",8,5,wh2]
  ];
  for (const [code,name,unit,min,qty,wh] of seedProducts) {
    const id = Number(run("INSERT INTO products(company_id,code,name,unit,min_stock) VALUES(?,?,?,?,?)",companyId,code,name,unit,min).lastInsertRowid);
    run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",
      companyId,id,wh,qty,"PURCHASE","Stock initial de démonstration",userId);
  }
  const txs = [
    ["INCOME","Facture transport — client A",2400,"USD","Transport"],
    ["EXPENSE","Achat de fournitures",320,"USD","Approvisionnement"],
    ["EXPENSE","Carburant flotte",180,"USD","Transport"],
    ["INCOME","Prestation logistique",950,"USD","Services"]
  ];
  for (const t of txs) run("INSERT INTO transactions(company_id,kind,label,amount,currency,category,created_by) VALUES(?,?,?,?,?,?,?)",companyId,...t,userId);
  const cars = [
    ["KAT-2210","Toyota Hilux","Jean M.","En service"],
    ["LUB-5082","Mitsubishi L200","Patrick K.","Disponible"],
    ["KOL-3401","Camion de livraison","Alain B.","Maintenance"]
  ];
  for (const v of cars) run("INSERT INTO vehicles(company_id,registration,label,driver,status) VALUES(?,?,?,?,?)",companyId,...v);
  audit({id:userId,company_id:companyId},"demo.seed","company",companyId,"Données de démonstration initiales");
}
ensureDemo();

const MIME = {".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".svg":"image/svg+xml",".json":"application/json; charset=utf-8"};
function send(res, status, body, headers={}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {"Content-Type":typeof body==="string"?"text/plain; charset=utf-8":"application/json; charset=utf-8","X-Content-Type-Options":"nosniff","Referrer-Policy":"same-origin","X-Frame-Options":"DENY",...headers});
  res.end(payload);
}
function cookie(token, maxAge=604800) {
  return `gp_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` + (process.env.NODE_ENV==="production"?"; Secure":"");
}
async function readBody(req) {
  let s=""; for await (const chunk of req) { s+=chunk; if(s.length>1e6) throw new Error("Requête trop volumineuse"); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw new Error("JSON invalide"); }
}
const cleanText = (v,max=150) => typeof v==="string" ? v.trim().slice(0,max) : "";
function requireUser(req,res) {
  const user=currentUser(req);
  if (!user) { send(res,401,{error:"Veuillez vous connecter."}); return null; }
  return user;
}
function dashboard(user) {
  const sum = (kind,currency) => q("SELECT COALESCE(SUM(amount),0) n FROM transactions WHERE company_id=? AND kind=? AND currency=?",user.company_id,kind,currency).n;
  const products = q("SELECT COUNT(*) n FROM products WHERE company_id=?",user.company_id).n;
  const low = q(`SELECT COUNT(*) n FROM (SELECT p.id,p.min_stock,COALESCE(SUM(m.quantity),0) total FROM products p LEFT JOIN stock_movements m ON m.product_id=p.id AND m.company_id=p.company_id WHERE p.company_id=? GROUP BY p.id HAVING total<=p.min_stock)`,user.company_id).n;
  const vehicles = q("SELECT COUNT(*) n FROM vehicles WHERE company_id=?",user.company_id).n;
  const movements = all(`SELECT m.id,m.quantity,m.reason,m.note,m.created_at,p.name product,w.name warehouse FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id WHERE m.company_id=? ORDER BY m.id DESC LIMIT 5`,user.company_id);
  return {incomeUSD:sum("INCOME","USD"),expenseUSD:sum("EXPENSE","USD"),incomeCDF:sum("INCOME","CDF"),expenseCDF:sum("EXPENSE","CDF"),products,lowStock:low,vehicles,recentMovements:movements};
}
function inventory(user) {
  const products = all(`SELECT p.id,p.code,p.name,p.unit,p.min_stock,COALESCE(SUM(m.quantity),0) total,
    CASE WHEN COALESCE(SUM(m.quantity),0)<=p.min_stock THEN 1 ELSE 0 END low
    FROM products p LEFT JOIN stock_movements m ON m.product_id=p.id AND m.company_id=p.company_id
    WHERE p.company_id=? GROUP BY p.id ORDER BY p.name`,user.company_id);
  const warehouses = all("SELECT id,name,location FROM warehouses WHERE company_id=? ORDER BY name",user.company_id);
  const history = all(`SELECT m.id,m.created_at,m.quantity,m.reason,m.note,p.code,p.name product,w.name warehouse,u.name by
    FROM stock_movements m JOIN products p ON p.id=m.product_id JOIN warehouses w ON w.id=m.warehouse_id JOIN users u ON u.id=m.created_by
    WHERE m.company_id=? ORDER BY m.id DESC LIMIT 30`,user.company_id);
  return {products,warehouses,history};
}
function serveStatic(req,res,url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname==="/") pathname="/index.html";
  const file=path.normalize(path.join(PUBLIC,pathname));
  if (!file.startsWith(PUBLIC+path.sep) && file!==PUBLIC) return send(res,403,"Forbidden");
  fs.readFile(file,(err,data)=> {
    if(err) return send(res,404,"Not found");
    res.writeHead(200,{"Content-Type":MIME[path.extname(file)]||"application/octet-stream","X-Content-Type-Options":"nosniff","Referrer-Policy":"same-origin","X-Frame-Options":"DENY"});
    res.end(data);
  });
}
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,"http://localhost");
  try {
    if(req.method==="GET" && !url.pathname.startsWith("/api/")) return serveStatic(req,res,url);
    if(req.method==="GET" && url.pathname==="/api/health") return send(res,200,{ok:true,app:"GestionPro RDC",database:"sqlite-local",time:new Date().toISOString()});
    if(req.method==="POST" && url.pathname==="/api/signup") {
      const b=await readBody(req),name=cleanText(b.name),company=cleanText(b.company),email=cleanText(b.email,254).toLowerCase(),password=String(b.password||"");
      if(name.length<2||company.length<2||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10) return send(res,400,{error:"Vérifiez les champs. Mot de passe : 10 caractères minimum."});
      if(q("SELECT id FROM users WHERE email=?",email)) return send(res,409,{error:"Cette adresse e-mail est déjà utilisée."});
      const c=db.prepare("INSERT INTO companies(name) VALUES(?)").run(company);
      const userId=Number(db.prepare("INSERT INTO users(company_id,name,email,password_hash,role) VALUES(?,?,?,?,?)").run(Number(c.lastInsertRowid),name,email,hashPassword(password),"COMPANY_OWNER").lastInsertRowid);
      const token=createSession(userId);
      audit({id:userId,company_id:Number(c.lastInsertRowid)},"company.create","company",Number(c.lastInsertRowid),"Inscription de l'entreprise");
      return send(res,201,{ok:true}, {"Set-Cookie":cookie(token)});
    }
    if(req.method==="POST" && url.pathname==="/api/login") {
      const b=await readBody(req),email=cleanText(b.email,254).toLowerCase(),password=String(b.password||"");
      const user=q("SELECT * FROM users WHERE email=?",email);
      if(!user||!verifyPassword(password,user.password_hash)) return send(res,401,{error:"E-mail ou mot de passe incorrect."});
      const token=createSession(user.id);
      return send(res,200,{ok:true},{"Set-Cookie":cookie(token)});
    }
    if(req.method==="POST" && url.pathname==="/api/demo") {
      const user=q("SELECT id FROM users WHERE email=?","demo@gestionpro.cd");
      const token=createSession(user.id);
      return send(res,200,{ok:true},{"Set-Cookie":cookie(token)});
    }
    if(req.method==="POST" && url.pathname==="/api/logout") {
      const u=currentUser(req);
      const cookies=Object.fromEntries((req.headers.cookie||"").split(";").map(s=>s.trim()).filter(Boolean).map(s=>{const i=s.indexOf("=");return[s.slice(0,i),decodeURIComponent(s.slice(i+1))]}));
      if(cookies.gp_session) run("DELETE FROM sessions WHERE token_hash=?",tokenHash(cookies.gp_session));
      return send(res,200,{ok:true},{"Set-Cookie":cookie("",0)});
    }
    const user=requireUser(req,res); if(!user)return;
    if(req.method==="GET" && url.pathname==="/api/me") return send(res,200,{id:user.id,name:user.name,email:user.email,role:user.role,companyId:user.company_id,companyName:user.company_name,currency:user.currency});
    if(req.method==="GET" && url.pathname==="/api/dashboard") return send(res,200,dashboard(user));
    if(req.method==="GET" && url.pathname==="/api/inventory") return send(res,200,inventory(user));
    if(req.method==="GET" && url.pathname==="/api/finance") return send(res,200,all("SELECT id,kind,label,amount,currency,category,created_at FROM transactions WHERE company_id=? ORDER BY id DESC LIMIT 100",user.company_id));
    if(req.method==="GET" && url.pathname==="/api/fleet") return send(res,200,all("SELECT id,registration,label,driver,status FROM vehicles WHERE company_id=? ORDER BY id DESC",user.company_id));
    if(req.method==="GET" && url.pathname==="/api/audit") return send(res,200,all("SELECT id,action,entity,entity_id,details,created_at FROM audit_logs WHERE company_id=? ORDER BY id DESC LIMIT 50",user.company_id));
    if(req.method==="POST" && url.pathname==="/api/warehouses") {
      const b=await readBody(req),name=cleanText(b.name,100),location=cleanText(b.location,120);
      if(!name)return send(res,400,{error:"Le nom du dépôt est obligatoire."});
      try { const r=run("INSERT INTO warehouses(company_id,name,location) VALUES(?,?,?)",user.company_id,name,location); audit(user,"warehouse.create","warehouse",Number(r.lastInsertRowid),name); return send(res,201,{ok:true}); }
      catch(e){if(String(e.message).includes("UNIQUE"))return send(res,409,{error:"Un dépôt porte déjà ce nom."});throw e;}
    }
    if(req.method==="POST" && url.pathname==="/api/products") {
      const b=await readBody(req),code=cleanText(b.code,40),name=cleanText(b.name,150),unit=cleanText(b.unit,30)||"unité",min=Number(b.minStock||0);
      if(!code||!name||!Number.isSafeInteger(min)||min<0)return send(res,400,{error:"Code, désignation et seuil de stock valide requis."});
      try {const r=run("INSERT INTO products(company_id,code,name,unit,min_stock) VALUES(?,?,?,?,?)",user.company_id,code,name,unit,min);audit(user,"product.create","product",Number(r.lastInsertRowid),`${code} ${name}`);return send(res,201,{ok:true,id:Number(r.lastInsertRowid)});}
      catch(e){if(String(e.message).includes("UNIQUE"))return send(res,409,{error:"Ce code produit existe déjà."});throw e;}
    }
    if(req.method==="POST" && url.pathname==="/api/movements") {
      const b=await readBody(req),productId=Number(b.productId),warehouseId=Number(b.warehouseId),qty=Number(b.quantity),reason=String(b.reason||"");
      const positive=["PURCHASE","ADJUSTMENT_IN"].includes(reason),negative=["ISSUE","DAMAGED","LOST","EXPIRED","ADJUSTMENT_OUT"].includes(reason);
      if(!Number.isSafeInteger(productId)||!Number.isSafeInteger(warehouseId)||!Number.isSafeInteger(qty)||qty<=0||(!positive&&!negative))return send(res,400,{error:"Vérifiez le produit, le dépôt, le motif et la quantité entière positive."});
      if(["ADJUSTMENT_IN","ADJUSTMENT_OUT"].includes(reason)&&!cleanText(b.note,300))return send(res,400,{error:"Une justification est obligatoire pour un ajustement."});
      const product=q("SELECT id FROM products WHERE id=? AND company_id=?",productId,user.company_id);
      const warehouse=q("SELECT id FROM warehouses WHERE id=? AND company_id=?",warehouseId,user.company_id);
      if(!product||!warehouse)return send(res,404,{error:"Produit ou dépôt introuvable dans cette entreprise."});
      const delta=positive?qty:-qty;
      const current=Number(q("SELECT COALESCE(SUM(quantity),0) n FROM stock_movements WHERE company_id=? AND product_id=? AND warehouse_id=?",user.company_id,productId,warehouseId).n);
      if(current+delta<0)return send(res,409,{error:"Stock insuffisant dans ce dépôt."});
      db.exec("BEGIN IMMEDIATE");
      try {
        const latest=Number(q("SELECT COALESCE(SUM(quantity),0) n FROM stock_movements WHERE company_id=? AND product_id=? AND warehouse_id=?",user.company_id,productId,warehouseId).n);
        if(latest+delta<0){db.exec("ROLLBACK");return send(res,409,{error:"Stock insuffisant dans ce dépôt."});}
        const r=run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,productId,warehouseId,delta,reason,cleanText(b.note,300),user.id);
        db.exec("COMMIT");audit(user,"stock.movement","stock_movement",Number(r.lastInsertRowid),`${reason} ${delta}`);
        return send(res,201,{ok:true});
      } catch(e){try{db.exec("ROLLBACK")}catch{}throw e;}
    }
    if(req.method==="POST" && url.pathname==="/api/transfers") {
      const b=await readBody(req),pid=Number(b.productId),from=Number(b.fromId),to=Number(b.toId),qty=Number(b.quantity);
      if(!Number.isSafeInteger(pid)||!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||from===to||!Number.isSafeInteger(qty)||qty<=0)return send(res,400,{error:"Transfert invalide : vérifiez les dépôts et la quantité."});
      const p=q("SELECT id FROM products WHERE id=? AND company_id=?",pid,user.company_id);
      const a=q("SELECT id FROM warehouses WHERE id=? AND company_id=?",from,user.company_id),z=q("SELECT id FROM warehouses WHERE id=? AND company_id=?",to,user.company_id);
      if(!p||!a||!z)return send(res,404,{error:"Produit ou dépôt introuvable."});
      db.exec("BEGIN IMMEDIATE");
      try{
        const stock=Number(q("SELECT COALESCE(SUM(quantity),0) n FROM stock_movements WHERE company_id=? AND product_id=? AND warehouse_id=?",user.company_id,pid,from).n);
        if(stock<qty){db.exec("ROLLBACK");return send(res,409,{error:"Stock insuffisant pour ce transfert."});}
        run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,pid,from,-qty,"TRANSFER_OUT",`Transfert vers dépôt ${to}`,user.id);
        run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,pid,to,qty,"TRANSFER_IN",`Transfert depuis dépôt ${from}`,user.id);
        db.exec("COMMIT");audit(user,"stock.transfer","product",pid,`${qty} unités de ${from} vers ${to}`);return send(res,201,{ok:true});
      }catch(e){try{db.exec("ROLLBACK")}catch{}throw e;}
    }
    if(req.method==="POST" && url.pathname==="/api/transactions") {
      const b=await readBody(req),kind=String(b.kind||""),label=cleanText(b.label,160),amount=Number(b.amount),currency=String(b.currency||"USD"),category=cleanText(b.category,80);
      if(!["INCOME","EXPENSE"].includes(kind)||!label||!Number.isFinite(amount)||amount<=0||!["USD","CDF"].includes(currency))return send(res,400,{error:"Vérifiez le type, le libellé, le montant et la devise."});
      const r=run("INSERT INTO transactions(company_id,kind,label,amount,currency,category,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,kind,label,amount,currency,category,user.id);
      audit(user,"finance.transaction","transaction",Number(r.lastInsertRowid),`${kind} ${amount} ${currency} ${label}`);
      return send(res,201,{ok:true});
    }
    if(req.method==="POST" && url.pathname==="/api/simulation") {
      const suffix=String(Date.now()).slice(-6), code=`SIM-${suffix}`, registration=`SIM-${suffix}`;
      const wh=q("SELECT id FROM warehouses WHERE company_id=? ORDER BY id LIMIT 1",user.company_id);
      if(!wh)return send(res,400,{error:"Créez un dépôt avant de lancer la simulation."});
      db.exec("BEGIN IMMEDIATE");
      try {
        const productId=Number(run("INSERT INTO products(company_id,code,name,unit,min_stock) VALUES(?,?,?,?,?)",user.company_id,code,"Kit de maintenance (simulation)","kit",2).lastInsertRowid);
        run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,productId,wh.id,20,"PURCHASE","Simulation : réception fournisseur",user.id);
        run("INSERT INTO stock_movements(company_id,product_id,warehouse_id,quantity,reason,note,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,productId,wh.id,-3,"ISSUE","Simulation : utilisation atelier",user.id);
        run("INSERT INTO transactions(company_id,kind,label,amount,currency,category,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,"INCOME","Simulation — prestation client",1250,"USD","Services",user.id);
        run("INSERT INTO transactions(company_id,kind,label,amount,currency,category,created_by) VALUES(?,?,?,?,?,?,?)",user.company_id,"EXPENSE","Simulation — achat consommables",450000,"CDF","Approvisionnement",user.id);
        run("INSERT INTO vehicles(company_id,registration,label,driver,status) VALUES(?,?,?,?,?)",user.company_id,registration,"Véhicule de test",user.name,"Disponible");
        db.exec("COMMIT");
        audit(user,"simulation.run","simulation",productId,"Réception 20 kits, sortie 3 kits, revenu 1 250 USD, dépense 450 000 CDF, véhicule de test créé");
        return send(res,201,{ok:true,productCode:code,registration,stock:17,incomeUSD:1250,expenseCDF:450000,message:"Simulation terminée : stock, finances et flotte mis à jour."});
      } catch(e){try{db.exec("ROLLBACK")}catch{}throw e;}
    }
    if(req.method==="POST" && url.pathname==="/api/vehicles") {
      const b=await readBody(req),registration=cleanText(b.registration,30).toUpperCase(),label=cleanText(b.label,100),driver=cleanText(b.driver,100),status=cleanText(b.status,30)||"Disponible";
      if(!registration||!label)return send(res,400,{error:"Immatriculation et véhicule sont obligatoires."});
      try{const r=run("INSERT INTO vehicles(company_id,registration,label,driver,status) VALUES(?,?,?,?,?)",user.company_id,registration,label,driver,status);audit(user,"fleet.vehicle.create","vehicle",Number(r.lastInsertRowid),registration);return send(res,201,{ok:true});}
      catch(e){if(String(e.message).includes("UNIQUE"))return send(res,409,{error:"Cette immatriculation existe déjà."});throw e;}
    }
    return send(res,404,{error:"Route introuvable."});
  } catch(e) {
    console.error(e);
    return send(res,500,{error:"Erreur serveur. Consultez les logs locaux."});
  }
});
const PORT=Number(process.env.PORT||3000);
server.listen(PORT,"0.0.0.0",()=>console.log(`GestionPro RDC running at http://localhost:${PORT}`));
process.on("SIGINT",()=>{server.close(()=>{db.close();process.exit(0)})});
