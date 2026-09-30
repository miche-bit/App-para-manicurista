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
if (ADMIN_PASSWORD === 'cambiar') console.warn('Aviso: define ADMIN_PASSWORD en las variables de entorno.');

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
CREATE TABLE IF NOT EXISTS resenas (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, estrellas INTEGER NOT NULL, texto TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente', creado TEXT DEFAULT (datetime('now')));
`);
// Migraciones suaves para bases creadas con la versión 1
function columna(tabla, col, def) {
  if (!db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
}
columna('servicios', 'extra', 'INTEGER DEFAULT 0');
columna('reservas', 'extras', "TEXT DEFAULT ''");

const HORARIO_BASE = [
  { abierto: false, abre: '09:00', cierra: '13:00' },
  ...Array.from({ length: 5 }, () => ({ abierto: true, abre: '09:00', cierra: '18:00' })),
  { abierto: true, abre: '09:00', cierra: '14:00' },
];
const AJUSTES_BASE = {
  nombre: 'Mi Estudio de Uñas',
  eslogan: 'Manicura, pedicura y diseños a mano',
  whatsapp: '5350000000',
  instagram: '',
  facebook: '',
  direccion: 'Calle y número',
  referencia: '',
  ciudad: 'Cienfuegos, Cuba',
  lat: '',
  lng: '',
  horario: JSON.stringify(HORARIO_BASE),
  moneda: 'CUP',
  sena: 'Para apartar el turno se pide una seña del 30 % por Transfermóvil o EnZona.',
  politica: 'Si no puedes venir, avisa con 24 horas. Con más de 15 minutos de retraso el turno puede perderse.',
  promo_activa: '0',
  promo_texto: '',
  fidelidad_activa: '1',
  fidelidad_visitas: '6',
  fidelidad_premio: 'La 7.ª manicura en gel es gratis',
  faq: JSON.stringify([
    { p: '¿Cuánto dura el esmalte en gel?', r: 'Entre 2 y 3 semanas si usas guantes al fregar y no usas las uñas como herramienta.' },
    { p: '¿Puedo llevar una foto del diseño que quiero?', r: 'Sí. Al reservar escríbelo en las notas o toca "Quiero este diseño" en la galería.' },
    { p: '¿Cómo cuido las uñas después?', r: 'Hidrata las cutículas con aceite cada noche y evita quitarte el gel tú misma: se daña la uña natural.' },
  ]),
};
const insAjuste = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(AJUSTES_BASE)) insAjuste.run(k, v);

let SECRET = db.prepare("SELECT valor FROM ajustes WHERE clave='_secret'").get()?.valor;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('_secret', ?)").run(SECRET);
}

// ---------- Utilidades ----------
const err = (msg, status = 400, campo) => Object.assign(new Error(msg), { status, campo });
function ahoraEnTZ() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const fecha = `${p.year}-${p.month}-${p.day}`;
  return { fecha, hora: `${p.hour}:${p.minute}`, dow: new Date(fecha + 'T12:00:00Z').getUTCDay() };
}
function sumarDias(iso, n) {
  const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const JSON_KEYS = ['horario', 'faq'];
function ajustes() {
  const out = {};
  for (const r of db.prepare("SELECT clave, valor FROM ajustes WHERE clave NOT LIKE '\\_%' ESCAPE '\\'").all()) {
    out[r.clave] = JSON_KEYS.includes(r.clave) ? (() => { try { return JSON.parse(r.valor); } catch { return JSON.parse(AJUSTES_BASE[r.clave]); } })() : r.valor;
  }
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
    req.on('data', c => { tam += c.length; if (tam > limite) { reject(err('El archivo es demasiado grande', 413)); req.destroy(); } else trozos.push(c); });
    req.on('end', () => { try { resolve(trozos.length ? JSON.parse(Buffer.concat(trozos).toString()) : {}); } catch { reject(err('JSON inválido')); } });
    req.on('error', reject);
  });
}
const texto = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const entero = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };
const soloDigitos = t => String(t || '').replace(/\D/g, '');
const ultimos8 = t => soloDigitos(t).slice(-8);
function transaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
function guardarImagen(dataUrl) {
  const m = /^data:image\/(webp|jpeg|png);base64,(.+)$/.exec(dataUrl || '');
  if (!m) throw err('La imagen debe ser WEBP, JPG o PNG');
  const nombre = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOADS, nombre), Buffer.from(m[2], 'base64'));
  return `/uploads/${nombre}`;
}
function borrarImagen(ruta) {
  if (ruta && ruta.startsWith('/uploads/')) fs.rm(path.join(UPLOADS, path.basename(ruta)), () => {});
}
function ipDe(req) { return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress; }

// Límite simple por IP y tipo de acción (evita spam)
const intentos = new Map();
function limitar(req, tipo, max) {
  const k = tipo + ':' + ipDe(req); const ahora = Date.now();
  const lista = (intentos.get(k) || []).filter(t => ahora - t < 3600_000);
  lista.push(ahora); intentos.set(k, lista);
  if (lista.length > max) throw err('Demasiadas solicitudes. Intenta más tarde o escribe por WhatsApp.', 429);
}
setInterval(() => intentos.clear(), 6 * 3600_000).unref();

// ---------- Datos públicos ----------
function datosPublicos() {
  const ahora = ahoraEnTZ();
  const hasta = sumarDias(ahora.fecha, 6);
  const turnos = db.prepare("SELECT id, fecha, hora FROM turnos WHERE estado='libre' AND fecha BETWEEN ? AND ? ORDER BY fecha, hora").all(ahora.fecha, hasta)
    .filter(t => t.fecha > ahora.fecha || t.hora > ahora.hora);
  const dias = [];
  for (let i = 0; i < 7; i++) {
    const f = sumarDias(ahora.fecha, i);
    dias.push({ fecha: f, turnos: turnos.filter(t => t.fecha === f).map(t => ({ id: t.id, hora: t.hora })) });
  }
  const resenas = db.prepare("SELECT id, nombre, estrellas, texto, creado FROM resenas WHERE estado='aprobada' ORDER BY id DESC LIMIT 30").all();
  const stats = db.prepare("SELECT COUNT(*) n, AVG(estrellas) prom FROM resenas WHERE estado='aprobada'").get();
  return {
    ahora,
    ajustes: ajustes(),
    categorias: CATEGORIAS,
    servicios: db.prepare('SELECT id, nombre, categoria, precio, duracion, descripcion, popular, extra FROM servicios WHERE activo=1 ORDER BY orden, id').all(),
    trabajos: db.prepare("SELECT id, titulo, categoria, imagen, forma, color, (creado >= datetime('now', '-14 days')) AS nuevo FROM trabajos ORDER BY id DESC LIMIT 60").all(),
    resenas, resumenResenas: { total: stats.n, promedio: stats.prom ? Math.round(stats.prom * 10) / 10 : null },
    dias,
  };
}

// ---------- Rutas ----------
const rutas = [];
const ruta = (metodo, patron, admin, fn) => rutas.push({ metodo, patron: new RegExp('^' + patron.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), admin, fn });

ruta('GET', '/api/publico', false, () => datosPublicos());

ruta('POST', '/api/reservas', false, async (req) => {
  limitar(req, 'reserva', 5);
  const b = await leerJSON(req, 20_000);
  const nombre = texto(b.nombre, 80); const telefono = texto(b.telefono, 20).replace(/[^\d+]/g, ''); const notas = texto(b.notas, 400);
  if (nombre.length < 2) throw err('Escribe tu nombre.', 400, 'nombre');
  if (soloDigitos(telefono).length < 8) throw err('Escribe un teléfono de al menos 8 dígitos.', 400, 'telefono');
  const serv = db.prepare('SELECT * FROM servicios WHERE id=? AND activo=1 AND extra=0').get(entero(b.servicio_id));
  if (!serv) throw err('Elige un servicio.', 400, 'servicio');
  const ids = (Array.isArray(b.extras) ? b.extras : []).map(entero).filter(Number.isFinite).slice(0, 10);
  const extras = ids.length ? db.prepare(`SELECT * FROM servicios WHERE activo=1 AND extra=1 AND id IN (${ids.map(() => '?').join(',')})`).all(...ids) : [];
  const total = serv.precio + extras.reduce((s, e) => s + e.precio, 0);
  return transaccion(() => {
    const t = db.prepare("SELECT * FROM turnos WHERE id=? AND estado='libre'").get(entero(b.turno_id));
    if (!t) throw err('Ese turno se acaba de ocupar. Elige otra hora.', 409);
    db.prepare("UPDATE turnos SET estado='reservado' WHERE id=?").run(t.id);
    const r = db.prepare('INSERT INTO reservas (turno_id, servicio_id, fecha, hora, servicio, extras, precio, nombre, telefono, notas) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, serv.id, t.fecha, t.hora, serv.nombre, extras.map(e => e.nombre).join(', '), total, nombre, telefono, notas);
    return { id: Number(r.lastInsertRowid), fecha: t.fecha, hora: t.hora, servicio: serv.nombre, extras: extras.map(e => e.nombre), precio: total, duracion: serv.duracion + extras.reduce((s, e) => s + e.duracion, 0), estado: 'pendiente' };
  });
});

ruta('POST', '/api/resenas', false, async (req) => {
  limitar(req, 'resena', 3);
  const b = await leerJSON(req, 5000);
  const nombre = texto(b.nombre, 40); const t = texto(b.texto, 500); const e = entero(b.estrellas);
  if (nombre.length < 2) throw err('Escribe tu nombre.', 400, 'nombre');
  if (!(e >= 1 && e <= 5)) throw err('Elige de 1 a 5 estrellas.', 400, 'estrellas');
  if (t.length < 5) throw err('Cuéntanos un poco más (mínimo 5 letras).', 400, 'texto');
  db.prepare('INSERT INTO resenas (nombre, estrellas, texto) VALUES (?,?,?)').run(nombre, e, t);
  return { ok: true };
});

ruta('GET', '/api/fidelidad', false, (req, p, url) => {
  limitar(req, 'sellos', 20);
  const tel = ultimos8(url.searchParams.get('telefono'));
  const a = ajustes();
  if (a.fidelidad_activa !== '1') throw err('La tarjeta de sellos no está activa.', 404);
  if (tel.length < 8) throw err('Escribe el teléfono con el que reservas.', 400, 'telefono');
  const visitas = db.prepare("SELECT telefono FROM reservas WHERE estado='completada'").all().filter(r => ultimos8(r.telefono) === tel).length;
  const meta = Math.max(entero(a.fidelidad_visitas) || 6, 2);
  return { meta, sellos: visitas % meta, premiosGanados: Math.floor(visitas / meta), visitas, premio: a.fidelidad_premio };
});

ruta('GET', '/salud', false, () => ({ ok: true }));

ruta('POST', '/api/admin/login', false, async (req) => {
  limitar(req, 'login', 20);
  const b = await leerJSON(req, 2000);
  const a = crypto.createHash('sha256').update(String(b.clave || '')).digest();
  const e = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, e)) { await new Promise(r => setTimeout(r, 600)); throw err('Contraseña incorrecta.', 401); }
  return { token: crearToken() };
});

ruta('GET', '/api/admin/datos', true, () => {
  const ahora = ahoraEnTZ();
  return {
    hoy: ahora.fecha, ahora,
    ajustes: ajustes(),
    categorias: CATEGORIAS,
    servicios: db.prepare('SELECT * FROM servicios ORDER BY orden, id').all(),
    trabajos: db.prepare('SELECT * FROM trabajos ORDER BY id DESC').all(),
    turnos: db.prepare('SELECT * FROM turnos WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(ahora.fecha, -1)),
    reservas: db.prepare('SELECT * FROM reservas WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(ahora.fecha, -60)),
    resenas: db.prepare('SELECT * FROM resenas ORDER BY id DESC').all(),
  };
});

// Servicios
function validarServicio(b) {
  const s = { nombre: texto(b.nombre, 80), categoria: texto(b.categoria, 30), precio: entero(b.precio), duracion: entero(b.duracion) || 60,
    descripcion: texto(b.descripcion, 240), popular: b.popular ? 1 : 0, extra: b.extra ? 1 : 0, activo: b.activo === false ? 0 : 1, orden: entero(b.orden) || 0 };
  if (!s.nombre) throw err('Falta el nombre del servicio.');
  if (!CATEGORIAS.includes(s.categoria)) throw err('Categoría no válida.');
  if (!(s.precio >= 0)) throw err('El precio debe ser un número.');
  return s;
}
const COLS_SERV = ['nombre', 'categoria', 'precio', 'duracion', 'descripcion', 'popular', 'extra', 'activo', 'orden'];
ruta('POST', '/api/admin/servicios', true, async (req) => {
  const s = validarServicio(await leerJSON(req));
  const r = db.prepare(`INSERT INTO servicios (${COLS_SERV.join(',')}) VALUES (${COLS_SERV.map(() => '?').join(',')})`).run(...COLS_SERV.map(c => s[c]));
  return { id: Number(r.lastInsertRowid) };
});
ruta('PUT', '/api/admin/servicios/:id', true, async (req, p) => {
  const s = validarServicio(await leerJSON(req));
  db.prepare(`UPDATE servicios SET ${COLS_SERV.map(c => c + '=?').join(',')} WHERE id=?`).run(...COLS_SERV.map(c => s[c]), entero(p.id));
  return { ok: true };
});
ruta('DELETE', '/api/admin/servicios/:id', true, (req, p) => { db.prepare('DELETE FROM servicios WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Trabajos (galería)
ruta('POST', '/api/admin/trabajos', true, async (req) => {
  const b = await leerJSON(req);
  const titulo = texto(b.titulo, 80); const categoria = texto(b.categoria, 30);
  if (!titulo) throw err('Ponle un título al trabajo.');
  if (!CATEGORIAS.includes(categoria)) throw err('Categoría no válida.');
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
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(b.desde) ? b.desde : ahoraEnTZ().fecha;
  const dias = Math.min(Math.max(entero(b.dias) || 7, 1), 31);
  const semana = Array.isArray(b.diasSemana) ? b.diasSemana.map(Number) : [1, 2, 3, 4, 5, 6];
  const horas = (Array.isArray(b.horas) ? b.horas : []).filter(h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h));
  if (!horas.length) throw err('Agrega al menos una hora (ej. 09:00).');
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
  if (!['libre', 'bloqueado'].includes(b.estado)) throw err('Estado no válido.');
  const r = db.prepare("UPDATE turnos SET estado=? WHERE id=? AND estado!='reservado'").run(b.estado, entero(p.id));
  if (!r.changes) throw err('Ese turno tiene una reserva. Cancélala primero.', 409);
  return { ok: true };
});
ruta('DELETE', '/api/admin/turnos/:id', true, (req, p) => {
  const r = db.prepare("DELETE FROM turnos WHERE id=? AND estado!='reservado'").run(entero(p.id));
  if (!r.changes) throw err('Ese turno tiene una reserva. Cancélala primero.', 409);
  return { ok: true };
});

// Reservas
ruta('PUT', '/api/admin/reservas/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!ESTADOS.includes(b.estado)) throw err('Estado no válido.');
  transaccion(() => {
    const r = db.prepare('SELECT * FROM reservas WHERE id=?').get(entero(p.id));
    if (!r) throw err('Reserva no encontrada.', 404);
    db.prepare('UPDATE reservas SET estado=? WHERE id=?').run(b.estado, r.id);
    if (b.estado === 'cancelada') db.prepare("UPDATE turnos SET estado='libre' WHERE id=?").run(r.turno_id);
    else if (r.estado === 'cancelada') {
      const ok = db.prepare("UPDATE turnos SET estado='reservado' WHERE id=? AND estado='libre'").run(r.turno_id);
      if (!ok.changes) throw err('Ese turno ya lo tomó otra persona.', 409);
    }
  });
  return { ok: true };
});

// Reseñas
ruta('PUT', '/api/admin/resenas/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!['aprobada', 'pendiente'].includes(b.estado)) throw err('Estado no válido.');
  db.prepare('UPDATE resenas SET estado=? WHERE id=?').run(b.estado, entero(p.id)); return { ok: true };
});
ruta('DELETE', '/api/admin/resenas/:id', true, (req, p) => { db.prepare('DELETE FROM resenas WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Ajustes (datos, ubicación, horario, promo, fidelidad, preguntas)
ruta('PUT', '/api/admin/ajustes', true, async (req) => {
  const b = await leerJSON(req, 60_000);
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor');
  for (const k of Object.keys(AJUSTES_BASE)) {
    if (!(k in b)) continue;
    let v = b[k];
    if (k === 'horario') {
      if (!Array.isArray(v) || v.length !== 7) throw err('El horario debe tener los 7 días.');
      v = JSON.stringify(v.map(d => ({ abierto: !!d.abierto, abre: /^\d{2}:\d{2}$/.test(d.abre) ? d.abre : '09:00', cierra: /^\d{2}:\d{2}$/.test(d.cierra) ? d.cierra : '18:00' })));
    } else if (k === 'faq') {
      if (!Array.isArray(v)) throw err('Las preguntas no tienen el formato correcto.');
      v = JSON.stringify(v.slice(0, 20).map(x => ({ p: texto(x.p, 160), r: texto(x.r, 800) })).filter(x => x.p && x.r));
    } else if (k === 'lat' || k === 'lng') {
      const n = Number(String(v).replace(',', '.'));
      if (String(v).trim() !== '' && (!Number.isFinite(n) || Math.abs(n) > (k === 'lat' ? 90 : 180))) throw err(`La ${k === 'lat' ? 'latitud' : 'longitud'} no es válida.`);
      v = String(v).trim() === '' ? '' : n.toFixed(6);
    } else if (k === 'promo_activa' || k === 'fidelidad_activa') v = v ? '1' : '0';
    else v = texto(v, 600);
    up.run(k, v);
  }
  return { ok: true };
});

// ---------- Archivos estáticos ----------
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function estatico(req, res, url) {
  let base = PUBLIC_DIR; let rel = decodeURIComponent(url.pathname);
  if (rel.startsWith('/uploads/')) { base = UPLOADS; rel = rel.slice('/uploads'.length); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const archivo = path.join(base, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!archivo.startsWith(base)) { res.writeHead(403); return res.end(); }
  fs.stat(archivo, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(archivo);
    if (ext === '.html') {
      // Las páginas se escriben sin <head>; aquí se envuelven con idioma, charset, viewport y manifiesto
      const html = fs.readFileSync(archivo, 'utf8');
      res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
      return res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icono.svg" type="image/svg+xml">${html}`);
    }
    res.writeHead(200, { 'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': base === UPLOADS ? 'public, max-age=31536000, immutable' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(archivo).pipe(res);
  });
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/salud') return estatico(req, res, url);
  for (const r of rutas) {
    const m = r.metodo === req.method && r.patron.exec(url.pathname);
    if (!m) continue;
    if (r.admin && !tokenValido(req)) return enviar(res, 401, { error: 'Tu sesión venció. Vuelve a entrar.' });
    try { return enviar(res, 200, await r.fn(req, m.groups || {}, url)); }
    catch (e) {
      if (!e.status) console.error(e);
      return enviar(res, e.status || 500, { error: e.status ? e.message : 'Error del servidor. Intenta de nuevo.', campo: e.campo });
    }
  }
  enviar(res, 404, { error: 'Ruta no encontrada' });
});
servidor.listen(PORT, '0.0.0.0', () => console.log(`Estudio de uñas escuchando en el puerto ${PORT} (admin: /admin)`));

// Apagado ordenado: Railway manda SIGTERM al reemplazar el contenedor
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { servidor.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });
