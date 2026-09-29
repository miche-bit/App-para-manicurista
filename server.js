// Estudio de uñas — servidor sin dependencias (Node 22.13+ con node:sqlite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TZ = process.env.TZ_NEGOCIO || 'America/Havana';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiar';
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS = path.join(DATA_DIR, 'uploads');
const CATEGORIAS = ['Manos', 'Pies', 'Extensiones', 'Diseños'];
const ESTADOS = ['pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio'];

fs.mkdirSync(UPLOADS, { recursive: true });
if (ADMIN_PASSWORD === 'cambiar') console.warn('⚠ Define ADMIN_PASSWORD en las variables de entorno.');

// ---------- Base de datos ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'estudio.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS servicios (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, categoria TEXT NOT NULL,
  precio INTEGER NOT NULL, duracion INTEGER NOT NULL DEFAULT 60,
  descripcion TEXT DEFAULT '', popular INTEGER DEFAULT 0, activo INTEGER DEFAULT 1, orden INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS trabajos (
  id INTEGER PRIMARY KEY, titulo TEXT NOT NULL, categoria TEXT NOT NULL,
  imagen TEXT, forma TEXT DEFAULT 'almendra', color TEXT DEFAULT '#A3123F',
  creado TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS turnos (
  id INTEGER PRIMARY KEY, fecha TEXT NOT NULL, hora TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'libre', UNIQUE(fecha, hora));
CREATE TABLE IF NOT EXISTS reservas (
  id INTEGER PRIMARY KEY, turno_id INTEGER REFERENCES turnos(id) ON DELETE SET NULL,
  servicio_id INTEGER REFERENCES servicios(id) ON DELETE SET NULL,
  fecha TEXT, hora TEXT, servicio TEXT, precio INTEGER,
  nombre TEXT NOT NULL, telefono TEXT NOT NULL, notas TEXT DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente', creado TEXT DEFAULT (datetime('now')));
`);

const AJUSTES_BASE = {
  nombre: 'Mi Estudio de Uñas',
  eslogan: 'Manicura, pedicura y diseños a mano',
  whatsapp: '5350000000',
  instagram: '',
  direccion: 'Cienfuegos, Cuba',
  moneda: 'CUP',
  sena: 'Para apartar el turno se pide una seña del 30 % por Transfermóvil o EnZona.',
  politica: 'Si no puedes venir, avisa con 24 horas. Con más de 15 minutos de retraso el turno puede perderse.',
};
const insAjuste = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(AJUSTES_BASE)) insAjuste.run(k, v);

let SECRET = db.prepare("SELECT valor FROM ajustes WHERE clave='_secret'").get()?.valor;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('_secret', ?)").run(SECRET);
}

// ---------- Utilidades ----------
function hoyEnTZ() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}` };
}
function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ajustes() {
  const out = {};
  for (const r of db.prepare("SELECT clave, valor FROM ajustes WHERE clave NOT LIKE '\\_%' ESCAPE '\\'").all()) out[r.clave] = r.valor;
  return out;
}
function firmar(exp) { return crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex'); }
function crearToken() { const exp = Date.now() + 1000 * 60 * 60 * 24 * 7; return `${exp}.${firmar(exp)}`; }
function tokenValido(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const esperado = firmar(exp);
  return sig.length === esperado.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado));
}
function enviar(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function leerJSON(req, limite = 6 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let tam = 0; const trozos = [];
    req.on('data', c => { tam += c.length; if (tam > limite) { reject(Object.assign(new Error('El archivo es demasiado grande'), { status: 413 })); req.destroy(); } else trozos.push(c); });
    req.on('end', () => { try { resolve(trozos.length ? JSON.parse(Buffer.concat(trozos).toString()) : {}); } catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const entero = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };
function transaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function guardarImagen(dataUrl) {
  const m = /^data:image\/(webp|jpeg|png);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw Object.assign(new Error('La imagen debe ser WEBP, JPG o PNG'), { status: 400 });
  const nombre = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, nombre), Buffer.from(m[2], 'base64'));
  return `/uploads/${nombre}`;
}
function borrarImagen(ruta) {
  if (ruta && ruta.startsWith('/uploads/')) fs.rm(path.join(UPLOADS, path.basename(ruta)), () => {});
}

// Límite simple de reservas por IP (evita spam)
const intentos = new Map();
function limitar(ip) {
  const ahora = Date.now(); const lista = (intentos.get(ip) || []).filter(t => ahora - t < 3600_000);
  lista.push(ahora); intentos.set(ip, lista); return lista.length > 5;
}

// ---------- Datos públicos ----------
function datosPublicos() {
  const { fecha, hora } = hoyEnTZ();
  const hasta = sumarDias(fecha, 6);
  const turnos = db.prepare("SELECT id, fecha, hora FROM turnos WHERE estado='libre' AND fecha BETWEEN ? AND ? ORDER BY fecha, hora").all(fecha, hasta)
    .filter(t => t.fecha > fecha || t.hora > hora);
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const f = sumarDias(fecha, i);
    dias.push({ fecha: f, turnos: turnos.filter(t => t.fecha === f).map(t => ({ id: t.id, hora: t.hora })) });
  }
  return {
    ajustes: ajustes(),
    categorias: CATEGORIAS,
    servicios: db.prepare('SELECT id, nombre, categoria, precio, duracion, descripcion, popular FROM servicios WHERE activo=1 ORDER BY orden, id').all(),
    trabajos: db.prepare('SELECT id, titulo, categoria, imagen, forma, color FROM trabajos ORDER BY id DESC LIMIT 60').all(),
    dias,
  };
}

// ---------- Rutas ----------
const rutas = [];
const ruta = (metodo, patron, admin, fn) => rutas.push({ metodo, patron: new RegExp('^' + patron.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), admin, fn });

ruta('GET', '/api/publico', false, () => datosPublicos());

ruta('POST', '/api/reservas', false, async (req) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (limitar(ip)) throw Object.assign(new Error('Demasiadas solicitudes. Intenta más tarde o escribe por WhatsApp.'), { status: 429 });
  const b = await leerJSON(req, 20_000);
  const nombre = texto(b.nombre, 80); const telefono = texto(b.telefono, 20).replace(/[^\d+]/g, ''); const notas = texto(b.notas, 400);
  if (nombre.length < 2) throw Object.assign(new Error('Escribe tu nombre.'), { status: 400, campo: 'nombre' });
  if (telefono.replace(/\D/g, '').length < 8) throw Object.assign(new Error('Escribe un teléfono de al menos 8 dígitos.'), { status: 400, campo: 'telefono' });
  const serv = db.prepare('SELECT * FROM servicios WHERE id=? AND activo=1').get(entero(b.servicio_id));
  if (!serv) throw Object.assign(new Error('Elige un servicio.'), { status: 400, campo: 'servicio' });
  return transaccion(() => {
    const t = db.prepare("SELECT * FROM turnos WHERE id=? AND estado='libre'").get(entero(b.turno_id));
    if (!t) throw Object.assign(new Error('Ese turno se acaba de ocupar. Elige otra hora.'), { status: 409 });
    db.prepare("UPDATE turnos SET estado='reservado' WHERE id=?").run(t.id);
    const r = db.prepare('INSERT INTO reservas (turno_id, servicio_id, fecha, hora, servicio, precio, nombre, telefono, notas) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(t.id, serv.id, t.fecha, t.hora, serv.nombre, serv.precio, nombre, telefono, notas);
    return { id: Number(r.lastInsertRowid), fecha: t.fecha, hora: t.hora, servicio: serv.nombre, precio: serv.precio, estado: 'pendiente' };
  });
});

ruta('POST', '/api/admin/login', false, async (req) => {
  const b = await leerJSON(req, 2000);
  const a = Buffer.from(String(b.clave || '')); const e = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
    await new Promise(r => setTimeout(r, 600));
    throw Object.assign(new Error('Contraseña incorrecta.'), { status: 401 });
  }
  return { token: crearToken() };
});

ruta('GET', '/api/admin/datos', true, () => {
  const { fecha } = hoyEnTZ();
  return {
    hoy: fecha,
    ajustes: ajustes(),
    categorias: CATEGORIAS,
    servicios: db.prepare('SELECT * FROM servicios ORDER BY orden, id').all(),
    trabajos: db.prepare('SELECT * FROM trabajos ORDER BY id DESC').all(),
    turnos: db.prepare('SELECT * FROM turnos WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(fecha, -1)),
    reservas: db.prepare('SELECT * FROM reservas WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(fecha, -30)),
  };
});

// Servicios
function validarServicio(b) {
  const s = { nombre: texto(b.nombre, 80), categoria: texto(b.categoria, 30), precio: entero(b.precio), duracion: entero(b.duracion) || 60,
    descripcion: texto(b.descripcion, 240), popular: b.popular ? 1 : 0, activo: b.activo === false ? 0 : 1, orden: entero(b.orden) || 0 };
  if (!s.nombre) throw Object.assign(new Error('Falta el nombre del servicio.'), { status: 400 });
  if (!CATEGORIAS.includes(s.categoria)) throw Object.assign(new Error('Categoría no válida.'), { status: 400 });
  if (!(s.precio >= 0)) throw Object.assign(new Error('El precio debe ser un número.'), { status: 400 });
  return s;
}
ruta('POST', '/api/admin/servicios', true, async (req) => {
  const s = validarServicio(await leerJSON(req));
  const r = db.prepare('INSERT INTO servicios (nombre, categoria, precio, duracion, descripcion, popular, activo, orden) VALUES (?,?,?,?,?,?,?,?)')
    .run(s.nombre, s.categoria, s.precio, s.duracion, s.descripcion, s.popular, s.activo, s.orden);
  return { id: Number(r.lastInsertRowid) };
});
ruta('PUT', '/api/admin/servicios/:id', true, async (req, p) => {
  const s = validarServicio(await leerJSON(req));
  db.prepare('UPDATE servicios SET nombre=?, categoria=?, precio=?, duracion=?, descripcion=?, popular=?, activo=?, orden=? WHERE id=?')
    .run(s.nombre, s.categoria, s.precio, s.duracion, s.descripcion, s.popular, s.activo, s.orden, entero(p.id));
  return { ok: true };
});
ruta('DELETE', '/api/admin/servicios/:id', true, (req, p) => { db.prepare('DELETE FROM servicios WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Trabajos (galería)
ruta('POST', '/api/admin/trabajos', true, async (req) => {
  const b = await leerJSON(req);
  const titulo = texto(b.titulo, 80); const categoria = texto(b.categoria, 30);
  if (!titulo) throw Object.assign(new Error('Ponle un título al trabajo.'), { status: 400 });
  if (!CATEGORIAS.includes(categoria)) throw Object.assign(new Error('Categoría no válida.'), { status: 400 });
  const imagen = b.imagen ? guardarImagen(b.imagen) : null;
  const r = db.prepare('INSERT INTO trabajos (titulo, categoria, imagen, forma, color) VALUES (?,?,?,?,?)')
    .run(titulo, categoria, imagen, texto(b.forma, 20) || 'almendra', /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#A3123F');
  return { id: Number(r.lastInsertRowid), imagen };
});
ruta('DELETE', '/api/admin/trabajos/:id', true, (req, p) => {
  const t = db.prepare('SELECT imagen FROM trabajos WHERE id=?').get(entero(p.id));
  db.prepare('DELETE FROM trabajos WHERE id=?').run(entero(p.id)); borrarImagen(t?.imagen); return { ok: true };
});

// Turnos
ruta('POST', '/api/admin/turnos/generar', true, async (req) => {
  const b = await leerJSON(req, 10_000);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(b.desde) ? b.desde : hoyEnTZ().fecha;
  const dias = Math.min(Math.max(entero(b.dias) || 7, 1), 31);
  const semana = Array.isArray(b.diasSemana) ? b.diasSemana.map(Number) : [1, 2, 3, 4, 5, 6];
  const horas = (Array.isArray(b.horas) ? b.horas : []).filter(h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h));
  if (!horas.length) throw Object.assign(new Error('Agrega al menos una hora (ej. 09:00).'), { status: 400 });
  const ins = db.prepare('INSERT OR IGNORE INTO turnos (fecha, hora) VALUES (?, ?)');
  let creados = 0;
  transaccion(() => {
    for (let i = 0; i < dias; i++) {
      const f = sumarDias(desde, i); const dow = new Date(f + 'T12:00:00Z').getUTCDay();
      if (!semana.includes(dow)) continue;
      for (const h of horas) creados += Number(ins.run(f, h).changes);
    }
  });
  return { creados };
});
ruta('PUT', '/api/admin/turnos/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!['libre', 'bloqueado'].includes(b.estado)) throw Object.assign(new Error('Estado no válido.'), { status: 400 });
  const r = db.prepare("UPDATE turnos SET estado=? WHERE id=? AND estado!='reservado'").run(b.estado, entero(p.id));
  if (!r.changes) throw Object.assign(new Error('Ese turno tiene una reserva. Cancélala primero.'), { status: 409 });
  return { ok: true };
});
ruta('DELETE', '/api/admin/turnos/:id', true, (req, p) => {
  const r = db.prepare("DELETE FROM turnos WHERE id=? AND estado!='reservado'").run(entero(p.id));
  if (!r.changes) throw Object.assign(new Error('Ese turno tiene una reserva. Cancélala primero.'), { status: 409 });
  return { ok: true };
});

// Reservas
ruta('PUT', '/api/admin/reservas/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!ESTADOS.includes(b.estado)) throw Object.assign(new Error('Estado no válido.'), { status: 400 });
  transaccion(() => {
    const r = db.prepare('SELECT * FROM reservas WHERE id=?').get(entero(p.id));
    if (!r) throw Object.assign(new Error('Reserva no encontrada.'), { status: 404 });
    db.prepare('UPDATE reservas SET estado=? WHERE id=?').run(b.estado, r.id);
    // Al cancelar se libera el turno; al reactivar se vuelve a ocupar si sigue libre
    if (b.estado === 'cancelada') db.prepare("UPDATE turnos SET estado='libre' WHERE id=?").run(r.turno_id);
    else if (r.estado === 'cancelada') {
      const ok = db.prepare("UPDATE turnos SET estado='reservado' WHERE id=? AND estado='libre'").run(r.turno_id);
      if (!ok.changes) throw Object.assign(new Error('Ese turno ya lo tomó otra persona.'), { status: 409 });
    }
  });
  return { ok: true };
});

// Ajustes
ruta('PUT', '/api/admin/ajustes', true, async (req) => {
  const b = await leerJSON(req, 20_000);
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor');
  for (const k of Object.keys(AJUSTES_BASE)) if (k in b) up.run(k, texto(b[k], 600));
  return { ok: true };
});

// ---------- Archivos estáticos ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function estatico(req, res, url) {
  let base = PUBLIC_DIR; let rel = url.pathname;
  if (rel.startsWith('/uploads/')) { base = UPLOADS; rel = rel.slice('/uploads'.length); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const archivo = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!archivo.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.stat(archivo, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(archivo);
    if (ext === '.html') {
      // Las páginas se escriben sin <head>; aquí se envuelven con idioma, charset y viewport
      const html = fs.readFileSync(archivo, 'utf8');
      res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-cache' });
      return res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">${html}`);
    }
    res.writeHead(200, { 'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': base === UPLOADS ? 'public, max-age=31536000, immutable' : 'no-cache' });
    fs.createReadStream(archivo).pipe(res);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return estatico(req, res, url);
  for (const r of rutas) {
    const m = r.metodo === req.method && r.patron.exec(url.pathname);
    if (!m) continue;
    if (r.admin && !tokenValido(req)) return enviar(res, 401, { error: 'Tu sesión venció. Vuelve a entrar.' });
    try { return enviar(res, 200, await r.fn(req, m.groups || {})); }
    catch (e) {
      if (!e.status) console.error(e);
      return enviar(res, e.status || 500, { error: e.status ? e.message : 'Error del servidor. Intenta de nuevo.', campo: e.campo });
    }
  }
  enviar(res, 404, { error: 'Ruta no encontrada' });
}).listen(PORT, () => console.log(`Estudio de uñas en http://localhost:${PORT}  (admin: /admin)`));
