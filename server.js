// Estudio de uñas — servidor sin dependencias (Node 22.13+ con node:sqlite)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

// ============================================================
// 1. VARIABLES DE ENTORNO (validadas al arrancar)
// ============================================================
try { if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env')); } catch {}

const EN_PRODUCCION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;
const CONFIG = Object.freeze({
  PORT: Number(process.env.PORT) || 3000,
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, 'data'),
  TZ: process.env.TZ_NEGOCIO || 'America/Havana',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  // Orígenes extra que pueden llamar a la API desde otro dominio (coma). Vacío = solo el propio dominio.
  CORS_ORIGINS: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean),
  // Detrás del proxy de Railway la IP real llega en X-Forwarded-For
  TRUST_PROXY: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === '1' : !!process.env.RAILWAY_ENVIRONMENT,
  SESSION_HOURS: Math.min(Math.max(Number(process.env.SESSION_HOURS) || 72, 1), 720),
  DIAS_COMPROBANTES: Math.max(Number(process.env.DIAS_COMPROBANTES) || 120, 7),
});

if (!CONFIG.ADMIN_PASSWORD || CONFIG.ADMIN_PASSWORD === 'cambiar') {
  if (EN_PRODUCCION) {
    console.error('ERROR: falta la variable ADMIN_PASSWORD. Defínela en Railway > Variables y vuelve a desplegar.');
    process.exit(1);
  }
  console.warn('Aviso (solo local): sin ADMIN_PASSWORD; se usa "cambiar".');
}
const ADMIN_PASSWORD = CONFIG.ADMIN_PASSWORD || 'cambiar';
if (ADMIN_PASSWORD.length < 12) console.warn('Aviso: usa una ADMIN_PASSWORD de 12 caracteres o más.');

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS = path.join(CONFIG.DATA_DIR, 'uploads');                  // fotos públicas de la galería
const PRIVADO = path.join(CONFIG.DATA_DIR, 'privado', 'comprobantes');   // comprobantes: nunca públicos
const CATEGORIAS = ['Manos', 'Pies', 'Extensiones', 'Diseños'];
const ESTADOS = ['pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio'];
// Cambios de estado permitidos (evita saltos imposibles, p. ej. pendiente → completada)
const TRANSICIONES = {
  pendiente: ['confirmada', 'cancelada'],
  confirmada: ['completada', 'no_asistio', 'cancelada'],
  completada: ['confirmada', 'no_asistio'],
  no_asistio: ['confirmada', 'completada'],
  cancelada: ['pendiente'],
};

fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(PRIVADO, { recursive: true, mode: 0o700 });

// ============================================================
// 2. BASE DE DATOS
// ============================================================
const DB_FILE = path.join(CONFIG.DATA_DIR, 'estudio.db');
const db = new DatabaseSync(DB_FILE);
try { fs.chmodSync(DB_FILE, 0o600); } catch {}
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT);
CREATE TABLE IF NOT EXISTS servicios (
  id INTEGER PRIMARY KEY, nombre TEXT NOT NULL, categoria TEXT NOT NULL,
  precio INTEGER NOT NULL, duracion INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS tarjetas (
  id INTEGER PRIMARY KEY, banco TEXT NOT NULL, numero TEXT NOT NULL, moneda TEXT NOT NULL DEFAULT 'CUP',
  titular TEXT DEFAULT '', confirmar TEXT NOT NULL, activa INTEGER DEFAULT 1, orden INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_reservas_fecha ON reservas(fecha);
CREATE INDEX IF NOT EXISTS idx_turnos_fecha ON turnos(fecha);
`);
function columna(tabla, col, def) {
  if (!db.prepare(`PRAGMA table_info(${tabla})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${def}`);
}
// Migraciones suaves (bases creadas con versiones anteriores)
columna('servicios', 'extra', 'INTEGER DEFAULT 0');
columna('servicios', 'variantes', "TEXT DEFAULT ''");
columna('reservas', 'extras', "TEXT DEFAULT ''");
columna('reservas', 'sena', 'INTEGER DEFAULT 0');
columna('reservas', 'comprobante', "TEXT DEFAULT ''");
columna('reservas', 'transaccion', "TEXT DEFAULT ''");
columna('reservas', 'pago', "TEXT DEFAULT 'sin_pago'");   // sin_pago | por_verificar | verificado | rechazado
columna('reservas', 'items', "TEXT DEFAULT ''");           // carrito: [{servicio_id, nombre, variante, precio, duracion, extra}]
columna('reservas', 'codigo', "TEXT DEFAULT ''");          // código de seguimiento que ve la clienta
columna('reservas', 'modo_pago', "TEXT DEFAULT 'sena'");   // sena | total
columna('reservas', 'nota_admin', "TEXT DEFAULT ''");      // motivo que ve la clienta si se rechaza el pago
columna('reservas', 'metodo', "TEXT DEFAULT ''");          // cómo pagó: "BANDEC ···· 2222", "Saldo móvil 5x xx xx xx"
columna('reservas', 'moneda_pago', "TEXT DEFAULT 'CUP'");
columna('reservas', 'monto_pago', 'REAL DEFAULT 0');       // monto en la moneda del método
columna('tarjetas', 'tipo', "TEXT DEFAULT 'tarjeta'");      // tarjeta | saldo (saldo móvil)
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_codigo ON reservas(codigo) WHERE codigo != ''");

function conVariantes(s) {
  if (!s) return s;
  let v = [];
  try { v = s.variantes ? JSON.parse(s.variantes) : []; } catch {}
  return { ...s, variantes: Array.isArray(v) ? v : [] };
}

// Primer arranque: si no hay servicios, se cargan los de servicios-iniciales.json
(function cargarServiciosIniciales() {
  if (db.prepare('SELECT COUNT(*) n FROM servicios').get().n) return;
  const archivo = path.join(__dirname, 'servicios-iniciales.json');
  if (!fs.existsSync(archivo)) return;
  const lista = JSON.parse(fs.readFileSync(archivo, 'utf8'));
  const ins = db.prepare('INSERT INTO servicios (nombre, categoria, precio, duracion, descripcion, popular, extra, orden, variantes) VALUES (?,?,?,?,?,?,?,?,?)');
  lista.forEach((s, i) => {
    const vars = s.variantes || [];
    ins.run(s.nombre, s.categoria, vars.length ? Math.min(...vars.map(v => v.precio)) : s.precio, s.duracion || 0, s.descripcion || '',
      s.popular ? 1 : 0, s.extra ? 1 : 0, i, vars.length ? JSON.stringify(vars) : '');
  });
  console.log(`Servicios iniciales cargados: ${lista.length}`);
})();

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
  sena_activa: '1',
  sena_porcentaje: '30',
  pago_total_activo: '1',
  tasa_mlc: '',      // CUP por 1 MLC (vacío = no se aceptan tarjetas MLC)
  tasa_usd: '',      // CUP por 1 USD
  sena: 'La seña se descuenta del total el día de tu turno.',
  politica: 'Si no puedes venir, avisa con 24 horas. Con más de 15 minutos de retraso el turno puede perderse.',
  promo_activa: '0',
  promo_texto: '',
  fidelidad_activa: '1',
  fidelidad_visitas: '6',
  fidelidad_premio: 'Tu 7.ª visita tiene un regalo',
  faq: JSON.stringify([
    { p: '¿Cómo pago la seña?', r: 'Al reservar verás la tarjeta y el número a confirmar. Transfiere por Transfermóvil o EnZona y sube la foto del comprobante.' },
    { p: '¿Puedo llevar una foto del diseño que quiero?', r: 'Sí. Escríbelo en las notas al reservar o toca "Quiero este diseño" en la galería.' },
    { p: '¿Cómo cuido las uñas después?', r: 'Hidrata las cutículas con aceite cada noche y no te quites el acrílico tú misma: se daña la uña natural.' },
  ]),
};
const insAjuste = db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)');
for (const [k, v] of Object.entries(AJUSTES_BASE)) insAjuste.run(k, v);

let SECRET = db.prepare("SELECT valor FROM ajustes WHERE clave='_secret'").get()?.valor;
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO ajustes (clave, valor) VALUES ('_secret', ?)").run(SECRET);
}

// ============================================================
// 3. UTILIDADES
// ============================================================
const err = (msg, status = 400, campo) => Object.assign(new Error(msg), { status, campo });
function ahoraEnTZ() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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
// El token incluye un resumen de la contraseña: si cambias ADMIN_PASSWORD, todas las sesiones se cierran
const HUELLA = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 16);
function firmar(exp) { return crypto.createHmac('sha256', SECRET).update(`${exp}:${HUELLA}`).digest('hex'); }
function crearToken() { const exp = Date.now() + CONFIG.SESSION_HOURS * 3600_000; return `${exp}.${firmar(exp)}`; }
function tokenValido(req) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  if (!/^\d+$/.test(exp || '') || !/^[a-f0-9]{64}$/.test(sig || '') || Number(exp) < Date.now()) return false;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(firmar(exp)));
}
function leerJSON(req, limite) {
  return new Promise((resolve, reject) => {
    if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] || '')) return reject(err('Formato no admitido: envía JSON.', 415));
    let tam = 0; const trozos = [];
    // Si se pasa del límite se responde 413 y se descarta el resto (con un tope, para no gastar ancho de banda)
    let demasiado = false;
    req.on('data', c => {
      tam += c.length;
      if (demasiado) { if (tam > limite + 8 * 1048576) req.destroy(); return; }
      if (tam > limite) { demasiado = true; trozos.length = 0; reject(err('El envío es demasiado grande. Usa una foto más liviana.', 413)); } else trozos.push(c);
    });
    req.on('end', () => { if (demasiado) return; try { const j = trozos.length ? JSON.parse(Buffer.concat(trozos).toString()) : {}; resolve(j && typeof j === 'object' && !Array.isArray(j) ? j : {}); } catch { reject(err('JSON inválido')); } });
    req.on('error', reject);
  });
}
const texto = (v, max = 200) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const entero = v => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : NaN; };
const soloDigitos = t => String(t || '').replace(/\D/g, '');
const ultimos8 = t => soloDigitos(t).slice(-8);
function transaccion(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
// Imagen en base64: se comprueba la firma real del archivo, no solo lo que dice el navegador
function decodificarImagen(dataUrl, maxBytes) {
  const m = /^data:image\/(webp|jpeg|png);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw err('La imagen debe ser una foto WEBP, JPG o PNG.');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw err(`La foto pesa demasiado (máximo ${Math.round(maxBytes / 1048576)} MB).`, 413);
  const esJPG = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const esPNG = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  const esWEBP = buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP';
  const ext = esJPG ? 'jpg' : esPNG ? 'png' : esWEBP ? 'webp' : null;
  if (!ext) throw err('El archivo no es una imagen válida.');
  return { buf, ext };
}
function guardarImagen(dataUrl, carpeta, maxBytes) {
  const { buf, ext } = decodificarImagen(dataUrl, maxBytes);
  const nombre = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(carpeta, nombre), buf, { mode: 0o600 });
  return nombre;
}
function borrarArchivo(carpeta, nombre) { if (nombre) fs.rm(path.join(carpeta, path.basename(nombre)), () => {}); }

function ipDe(req) {
  if (CONFIG.TRUST_PROXY) {
    // El proxy agrega la IP real al FINAL; la primera la puede inventar cualquiera
    const partes = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
    if (partes.length) return partes[partes.length - 1];
  }
  return req.socket.remoteAddress || '?';
}
// Límite por IP y acción (evita spam y fuerza bruta)
const intentos = new Map();
function limitar(req, tipo, max, ventanaMs = 3600_000) {
  const k = tipo + ':' + ipDe(req); const ahora = Date.now();
  const lista = (intentos.get(k) || []).filter(t => ahora - t < ventanaMs);
  lista.push(ahora); intentos.set(k, lista);
  if (lista.length > max) throw err('Demasiadas solicitudes seguidas. Espera un rato o escribe por WhatsApp.', 429);
}
setInterval(() => intentos.clear(), 6 * 3600_000).unref();

// ============================================================
// 4. CAPA DE ACCESO (equivalente a Row Level Security)
//    SQLite no tiene RLS, así que las reglas viven aquí y TODO
//    acceso pasa por ellas. Rol "publico": solo filas y columnas
//    listadas. Rol "admin": requiere token válido.
// ============================================================
const PUBLICO = {
  servicios: () => db.prepare('SELECT id, nombre, categoria, precio, duracion, descripcion, popular, extra, variantes FROM servicios WHERE activo=1 ORDER BY orden, id').all().map(conVariantes),
  trabajos: () => db.prepare("SELECT id, titulo, categoria, imagen, forma, color, (creado >= datetime('now', '-14 days')) AS nuevo FROM trabajos ORDER BY id DESC LIMIT 60").all()
    .map(t => ({ ...t, imagen: t.imagen ? '/uploads/' + t.imagen.replace(/^\/uploads\//, '') : null })),
  resenas: () => db.prepare("SELECT id, nombre, estrellas, texto FROM resenas WHERE estado='aprobada' ORDER BY id DESC LIMIT 30").all(),
  resumenResenas: () => { const s = db.prepare("SELECT COUNT(*) n, AVG(estrellas) prom FROM resenas WHERE estado='aprobada'").get(); return { total: s.n, promedio: s.prom ? Math.round(s.prom * 10) / 10 : null }; },
  tarjetas: () => metodosUsables(),
  turnosLibres: (desde, hasta) => db.prepare("SELECT id, fecha, hora FROM turnos WHERE estado='libre' AND fecha BETWEEN ? AND ? ORDER BY fecha, hora").all(desde, hasta),
  // Las reservas, teléfonos, notas y comprobantes NO tienen vista pública.
};

function datosPublicos() {
  const ahora = ahoraEnTZ();
  const turnos = PUBLICO.turnosLibres(ahora.fecha, sumarDias(ahora.fecha, 6)).filter(t => t.fecha > ahora.fecha || t.hora > ahora.hora);
  const dias = Array.from({ length: 7 }, (_, i) => {
    const f = sumarDias(ahora.fecha, i);
    return { fecha: f, turnos: turnos.filter(t => t.fecha === f).map(t => ({ id: t.id, hora: t.hora })) };
  });
  return { ahora, ajustes: ajustes(), categorias: CATEGORIAS, servicios: PUBLICO.servicios(), trabajos: PUBLICO.trabajos(),
    resenas: PUBLICO.resenas(), resumenResenas: PUBLICO.resumenResenas(), tarjetas: PUBLICO.tarjetas(), dias };
}
// Métodos de pago que la clienta puede usar ahora (tarjetas en MLC/USD solo si hay tasa de cambio)
function tasaDe(moneda, a = ajustes()) { if (moneda === 'CUP') return 1; const t = Number(a['tasa_' + moneda.toLowerCase()]); return t > 0 ? t : 0; }
function metodosUsables(a = ajustes()) {
  return db.prepare("SELECT id, tipo, banco, numero, moneda, titular, confirmar FROM tarjetas WHERE activa=1 ORDER BY orden, id").all()
    .filter(t => tasaDe(t.moneda, a) > 0);
}
function pagoRequerido(a = ajustes()) {
  return a.sena_activa === '1' && metodosUsables(a).length > 0;
}
const etiquetaMetodo = t => t.tipo === 'saldo' ? `Saldo móvil al ${t.numero}` : `${t.banco} ${t.moneda} ···· ${t.numero.slice(-4)}`;
const enMoneda = (cup, moneda, a) => moneda === 'CUP' ? cup : Math.ceil(cup / tasaDe(moneda, a) * 100) / 100;

// ============================================================
// 5. RUTAS
// ============================================================
const rutas = [];
const ruta = (metodo, patron, admin, fn) => rutas.push({ metodo, patron: new RegExp('^' + patron.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), admin, fn });

ruta('GET', '/salud', false, () => ({ ok: true }));
ruta('GET', '/api/publico', false, () => datosPublicos());

// Código de seguimiento: 10 caracteres sin letras que se confunden (0/O, 1/I)
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function nuevoCodigo() {
  for (;;) {
    const b = crypto.randomBytes(10); let c = '';
    for (let i = 0; i < 10; i++) c += ALFABETO[b[i] % ALFABETO.length];
    c = c.slice(0, 5) + '-' + c.slice(5);
    if (!db.prepare('SELECT 1 FROM reservas WHERE codigo=?').get(c)) return c;
  }
}
const codigoValido = c => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(String(c || ''));
const leerItems = r => { try { return r.items ? JSON.parse(r.items) : []; } catch { return []; } };

// Arma el pedido (carrito) validando cada servicio en el servidor: precios y variantes nunca vienen del navegador
function armarPedido(b) {
  let pedido = Array.isArray(b.items) && b.items.length ? b.items
    : [{ servicio_id: b.servicio_id, variante: b.variante }, ...(Array.isArray(b.extras) ? b.extras : []).map(id => ({ servicio_id: id }))];
  if (pedido.length > 8) throw err('Máximo 8 servicios por reserva.', 400, 'servicio');
  const vistos = new Set(); const items = [];
  for (const it of pedido) {
    const serv = conVariantes(db.prepare('SELECT * FROM servicios WHERE id=? AND activo=1').get(entero(it?.servicio_id)));
    if (!serv) { if (it?.servicio_id == null && items.length) continue; throw err('Uno de los servicios ya no está disponible. Revisa tu carrito.', 400, 'servicio'); }
    let precio = serv.precio; let variante = null;
    if (serv.variantes.length) {
      const v = serv.variantes[entero(it.variante)];
      if (!v) throw err(`Elige una opción para "${serv.nombre}".`, 400, 'variante');
      precio = v.precio; variante = v.nombre;
    }
    const clave = serv.id + '|' + (variante || '');
    if (serv.extra && vistos.has(clave)) continue;          // un complemento no se repite
    vistos.add(clave);
    items.push({ servicio_id: serv.id, nombre: serv.nombre, variante, precio, duracion: serv.duracion, extra: !!serv.extra });
  }
  if (!items.some(i => !i.extra)) throw err('Elige al menos un servicio (los complementos van junto a otro).', 400, 'servicio');
  return items;
}
const resumenItems = items => items.map(i => i.nombre + (i.variante ? ' · ' + i.variante : '')).join(' + ');

ruta('POST', '/api/reservas', false, async (req) => {
  limitar(req, 'reserva', 5);
  const b = await leerJSON(req, 6 * 1024 * 1024);
  if (b.web) throw err('No se pudo enviar la reserva.');   // campo trampa: solo lo llenan los robots
  const nombre = texto(b.nombre, 80); const telefono = texto(b.telefono, 20).replace(/[^\d+]/g, ''); const notas = texto(b.notas, 400);
  if (nombre.length < 2) throw err('Escribe tu nombre.', 400, 'nombre');
  if (soloDigitos(telefono).length < 8) throw err('Escribe un teléfono de al menos 8 dígitos.', 400, 'telefono');
  const items = armarPedido(b);
  const total = items.reduce((t, i) => t + i.precio, 0);
  const duracion = items.reduce((t, i) => t + i.duracion, 0);
  // Pago: seña o total, calculado en el servidor
  const a = ajustes(); const hayTarjetas = pagoRequerido(a);
  const pct = Math.min(Math.max(entero(a.sena_porcentaje) || 0, 0), 100);
  const modo = b.modo_pago === 'total' && a.pago_total_activo === '1' ? 'total' : 'sena';
  const monto = hayTarjetas ? (modo === 'total' ? total : Math.ceil(total * pct / 100)) : 0;
  const requierePago = monto > 0;
  let metodo = null;
  if (requierePago) {
    const usables = metodosUsables(a);
    metodo = b.metodo_id != null ? usables.find(t => t.id === entero(b.metodo_id)) : (usables.length === 1 ? usables[0] : null);
    if (!metodo) throw err('Elige cómo vas a pagar (tarjeta o saldo móvil).', 400, 'metodo');
  }
  if (requierePago && !b.comprobante) throw err('Sube la foto del comprobante de la transferencia.', 400, 'comprobante');
  if (requierePago) decodificarImagen(b.comprobante, 3 * 1024 * 1024);
  const ahora = ahoraEnTZ();
  let archivo = '';
  try {
    return transaccion(() => {
      const t = db.prepare("SELECT * FROM turnos WHERE id=? AND estado='libre'").get(entero(b.turno_id));
      if (!t) throw err('Ese turno se acaba de ocupar. Elige otra hora.', 409);
      if (t.fecha < ahora.fecha || (t.fecha === ahora.fecha && t.hora <= ahora.hora)) throw err('Ese turno ya pasó. Elige otra hora.', 409);
      if (requierePago) archivo = guardarImagen(b.comprobante, PRIVADO, 3 * 1024 * 1024);
      const codigo = nuevoCodigo();
      db.prepare("UPDATE turnos SET estado='reservado' WHERE id=?").run(t.id);
      const principal = items.find(i => !i.extra);
      const r = db.prepare(`INSERT INTO reservas (turno_id, servicio_id, fecha, hora, servicio, extras, precio, nombre, telefono, notas, sena, comprobante, transaccion, pago, items, codigo, modo_pago)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(t.id, principal.servicio_id, t.fecha, t.hora, resumenItems(items), '', total, nombre, telefono, notas, monto, archivo, texto(b.transaccion, 60),
          requierePago ? 'por_verificar' : 'sin_pago', JSON.stringify(items), codigo, modo);
      const pagoMetodo = metodo ? { metodo: etiquetaMetodo(metodo), moneda_pago: metodo.moneda, monto_pago: enMoneda(monto, metodo.moneda, a) } : { metodo: '', moneda_pago: 'CUP', monto_pago: 0 };
      db.prepare('UPDATE reservas SET metodo=?, moneda_pago=?, monto_pago=? WHERE id=?').run(pagoMetodo.metodo, pagoMetodo.moneda_pago, pagoMetodo.monto_pago, r.lastInsertRowid);
      return { id: Number(r.lastInsertRowid), codigo, fecha: t.fecha, hora: t.hora, servicio: resumenItems(items), items, extras: [], precio: total, ...pagoMetodo,
        sena: monto, modo_pago: modo, pago: requierePago ? 'por_verificar' : 'sin_pago', duracion, estado: 'pendiente' };
    });
  } catch (e) { borrarArchivo(PRIVADO, archivo); throw e; }
});

// Estado de una reserva: solo quien tiene el código (sin teléfono, notas ni comprobante)
function vistaEstado(r) {
  return { codigo: r.codigo, estado: r.estado, pago: r.pago, fecha: r.fecha, hora: r.hora, servicio: r.servicio,
    items: leerItems(r).map(i => ({ nombre: i.nombre, variante: i.variante, precio: i.precio, extra: i.extra })),
    total: r.precio, sena: r.sena, modo_pago: r.modo_pago, metodo: r.metodo, moneda_pago: r.moneda_pago, monto_pago: r.monto_pago, nombre: String(r.nombre).split(' ')[0], nota: r.pago === 'rechazado' ? r.nota_admin : '' };
}
ruta('GET', '/api/reservas/estado/:codigo', false, (req, p) => {
  limitar(req, 'estado', 240);
  const c = String(p.codigo).toUpperCase();
  const r = codigoValido(c) && db.prepare('SELECT * FROM reservas WHERE codigo=?').get(c);
  if (!r) throw err('No encontramos una reserva con ese código.', 404);
  return vistaEstado(r);
});
// Reenviar comprobante cuando el pago fue rechazado (el turno sigue apartado)
ruta('POST', '/api/reservas/estado/:codigo/comprobante', false, async (req, p) => {
  limitar(req, 'reenvio', 6);
  const b = await leerJSON(req, 6 * 1024 * 1024);
  const c = String(p.codigo).toUpperCase();
  if (!codigoValido(c)) throw err('No encontramos una reserva con ese código.', 404);
  decodificarImagen(b.comprobante, 3 * 1024 * 1024);
  let viejo = ''; let nuevo = '';
  try {
    const r = transaccion(() => {
      const r = db.prepare('SELECT * FROM reservas WHERE codigo=?').get(c);
      if (!r) throw err('No encontramos una reserva con ese código.', 404);
      if (r.estado !== 'pendiente' || r.pago !== 'rechazado') throw err('Esta reserva no necesita un comprobante nuevo.', 409);
      nuevo = guardarImagen(b.comprobante, PRIVADO, 3 * 1024 * 1024); viejo = r.comprobante;
      db.prepare("UPDATE reservas SET comprobante=?, transaccion=?, pago='por_verificar', nota_admin='' WHERE id=?").run(nuevo, texto(b.transaccion, 60) || r.transaccion, r.id);
      return db.prepare('SELECT * FROM reservas WHERE id=?').get(r.id);
    });
    borrarArchivo(PRIVADO, viejo);
    return vistaEstado(r);
  } catch (e) { borrarArchivo(PRIVADO, nuevo); throw e; }
});

ruta('POST', '/api/resenas', false, async (req) => {
  limitar(req, 'resena', 3);
  const b = await leerJSON(req, 5000);
  if (b.web) throw err('No se pudo enviar.');
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
  // Solo devuelve un conteo: nunca nombres, fechas ni servicios de esa persona
  const visitas = db.prepare("SELECT telefono FROM reservas WHERE estado='completada'").all().filter(r => ultimos8(r.telefono) === tel).length;
  const meta = Math.max(entero(a.fidelidad_visitas) || 6, 2);
  return { meta, sellos: visitas % meta, premiosGanados: Math.floor(visitas / meta), premio: a.fidelidad_premio };
});

ruta('POST', '/api/admin/login', false, async (req) => {
  limitar(req, 'login', 10);
  const b = await leerJSON(req, 2000);
  const a = crypto.createHash('sha256').update(String(b.clave || '')).digest();
  const e = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, e)) { await new Promise(r => setTimeout(r, 700)); throw err('Contraseña incorrecta.', 401); }
  return { token: crearToken(), horas: CONFIG.SESSION_HOURS };
});

ruta('GET', '/api/admin/datos', true, () => {
  const ahora = ahoraEnTZ();
  return {
    hoy: ahora.fecha, ahora, ajustes: ajustes(), categorias: CATEGORIAS,
    servicios: db.prepare('SELECT * FROM servicios ORDER BY orden, id').all().map(conVariantes),
    trabajos: db.prepare('SELECT * FROM trabajos ORDER BY id DESC').all().map(t => ({ ...t, imagen: t.imagen ? '/uploads/' + t.imagen.replace(/^\/uploads\//, '') : null })),
    turnos: db.prepare('SELECT * FROM turnos WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(ahora.fecha, -1)),
    // El nombre del archivo del comprobante no sale del servidor: solo si existe
    reservas: db.prepare('SELECT * FROM reservas WHERE fecha >= ? ORDER BY fecha, hora').all(sumarDias(ahora.fecha, -60))
      .map(({ comprobante, ...r }) => ({ ...r, items: leerItems(r), tieneComprobante: !!comprobante })),
    resenas: db.prepare('SELECT * FROM resenas ORDER BY id DESC').all(),
    tarjetas: db.prepare('SELECT * FROM tarjetas ORDER BY orden, id').all(),
  };
});

// Comprobante: solo el panel, con token, sin caché
ruta('GET', '/api/admin/reservas/:id/comprobante', true, (req, p, url, res) => {
  const r = db.prepare('SELECT comprobante FROM reservas WHERE id=?').get(entero(p.id));
  if (!r?.comprobante) throw err('Esta reserva no tiene comprobante.', 404);
  const archivo = path.join(PRIVADO, path.basename(r.comprobante));
  if (!fs.existsSync(archivo)) throw err('El comprobante ya no está guardado.', 404);
  const ext = path.extname(archivo).slice(1);
  res.writeHead(200, { 'Content-Type': { webp: 'image/webp', jpg: 'image/jpeg', png: 'image/png' }[ext], 'Cache-Control': 'no-store, private' });
  fs.createReadStream(archivo).pipe(res);
  return RESPONDIDO;
});

// Servicios
function validarServicio(b) {
  const dur = entero(b.duracion);
  const s = { nombre: texto(b.nombre, 80), categoria: texto(b.categoria, 30), precio: entero(b.precio), duracion: dur >= 0 ? Math.min(dur, 600) : 0,
    descripcion: texto(b.descripcion, 400), popular: b.popular ? 1 : 0, extra: b.extra ? 1 : 0, activo: [false, 0, "0"].includes(b.activo) ? 0 : 1, orden: entero(b.orden) || 0 };
  if (!s.nombre) throw err('Falta el nombre del servicio.');
  if (!CATEGORIAS.includes(s.categoria)) throw err('Categoría no válida.');
  const vars = (Array.isArray(b.variantes) ? b.variantes : []).slice(0, 12)
    .map(v => ({ nombre: texto(v?.nombre, 40), precio: entero(v?.precio) })).filter(v => v.nombre);
  if (vars.some(v => !(v.precio >= 0))) throw err('Cada opción necesita un precio en números.');
  if (vars.length && s.extra) throw err('Un complemento no puede tener opciones de precio.');
  if (vars.length) s.precio = Math.min(...vars.map(v => v.precio));
  if (!(s.precio >= 0)) throw err('El precio debe ser un número.');
  s.variantes = vars.length ? JSON.stringify(vars) : '';
  return s;
}
const COLS_SERV = ['nombre', 'categoria', 'precio', 'duracion', 'descripcion', 'popular', 'extra', 'activo', 'orden', 'variantes'];
ruta('POST', '/api/admin/servicios', true, async (req) => {
  const s = validarServicio(await leerJSON(req, 20_000));
  const r = db.prepare(`INSERT INTO servicios (${COLS_SERV.join(',')}) VALUES (${COLS_SERV.map(() => '?').join(',')})`).run(...COLS_SERV.map(c => s[c]));
  return { id: Number(r.lastInsertRowid) };
});
ruta('PUT', '/api/admin/servicios/:id', true, async (req, p) => {
  const s = validarServicio(await leerJSON(req, 20_000));
  const r = db.prepare(`UPDATE servicios SET ${COLS_SERV.map(c => c + '=?').join(',')} WHERE id=?`).run(...COLS_SERV.map(c => s[c]), entero(p.id));
  if (!r.changes) throw err('Servicio no encontrado.', 404);
  return { ok: true };
});
ruta('DELETE', '/api/admin/servicios/:id', true, (req, p) => { db.prepare('DELETE FROM servicios WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Trabajos (galería pública)
ruta('POST', '/api/admin/trabajos', true, async (req) => {
  const b = await leerJSON(req, 8 * 1024 * 1024);
  const titulo = texto(b.titulo, 80); const categoria = texto(b.categoria, 30);
  if (!titulo) throw err('Ponle un título al trabajo.');
  if (!CATEGORIAS.includes(categoria)) throw err('Categoría no válida.');
  const forma = ['almendra', 'cuadrada', 'coffin', 'redonda'].includes(b.forma) ? b.forma : 'almendra';
  const imagen = b.imagen ? guardarImagen(b.imagen, UPLOADS, 5 * 1024 * 1024) : null;
  const r = db.prepare('INSERT INTO trabajos (titulo, categoria, imagen, forma, color) VALUES (?,?,?,?,?)')
    .run(titulo, categoria, imagen, forma, /^#[0-9a-f]{6}$/i.test(b.color) ? b.color : '#A3123F');
  return { id: Number(r.lastInsertRowid), imagen: imagen ? '/uploads/' + imagen : null };
});
ruta('DELETE', '/api/admin/trabajos/:id', true, (req, p) => {
  const t = db.prepare('SELECT imagen FROM trabajos WHERE id=?').get(entero(p.id));
  db.prepare('DELETE FROM trabajos WHERE id=?').run(entero(p.id)); borrarArchivo(UPLOADS, t?.imagen); return { ok: true };
});

// Turnos
ruta('POST', '/api/admin/turnos/generar', true, async (req) => {
  const b = await leerJSON(req, 10_000);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(b.desde) && !isNaN(new Date(b.desde)) ? b.desde : ahoraEnTZ().fecha;
  const dias = Math.min(Math.max(entero(b.dias) || 7, 1), 31);
  const semana = Array.isArray(b.diasSemana) ? b.diasSemana.map(Number).filter(n => n >= 0 && n <= 6) : [1, 2, 3, 4, 5, 6];
  const horas = [...new Set((Array.isArray(b.horas) ? b.horas : []).filter(h => /^([01]\d|2[0-3]):[0-5]\d$/.test(h)))].slice(0, 24);
  if (!horas.length) throw err('Agrega al menos una hora válida (ej. 09:00).');
  if (!semana.length) throw err('Marca al menos un día de la semana.');
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
  if (!r.changes) throw err('Ese turno tiene una reserva o no existe. Cancela la reserva primero.', 409);
  return { ok: true };
});
ruta('DELETE', '/api/admin/turnos/:id', true, (req, p) => {
  const r = db.prepare("DELETE FROM turnos WHERE id=? AND estado!='reservado'").run(entero(p.id));
  if (!r.changes) throw err('Ese turno tiene una reserva o no existe. Cancela la reserva primero.', 409);
  return { ok: true };
});

// Reservas: cambios de estado y verificación del pago
ruta('PUT', '/api/admin/reservas/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!ESTADOS.includes(b.estado)) throw err('Estado no válido.');
  const hoy = ahoraEnTZ().fecha;
  transaccion(() => {
    const r = db.prepare('SELECT * FROM reservas WHERE id=?').get(entero(p.id));
    if (!r) throw err('Reserva no encontrada.', 404);
    if (r.estado === b.estado) return;
    if (!TRANSICIONES[r.estado]?.includes(b.estado)) throw err(`No se puede pasar de "${r.estado}" a "${b.estado}".`, 409);
    let pago = r.pago;
    if (b.estado === 'confirmada' && ['por_verificar', 'rechazado'].includes(r.pago) && r.comprobante) pago = 'verificado';
    if (b.estado === 'cancelada' && b.pago === 'rechazado') pago = 'rechazado';
    if (b.estado === 'cancelada') db.prepare("UPDATE turnos SET estado='libre' WHERE id=? AND estado='reservado'").run(r.turno_id);
    if (r.estado === 'cancelada') {
      if (r.fecha < hoy) throw err('No se puede reactivar una reserva de un día que ya pasó.', 409);
      const ok = r.turno_id ? db.prepare("UPDATE turnos SET estado='reservado' WHERE id=? AND estado='libre'").run(r.turno_id) : { changes: 0 };
      if (!ok.changes) throw err('Ese turno ya no está libre (lo tomó otra clienta o lo borraste).', 409);
      if (pago === 'rechazado') pago = r.comprobante ? 'por_verificar' : 'sin_pago';
    }
    db.prepare('UPDATE reservas SET estado=?, pago=? WHERE id=?').run(b.estado, pago, r.id);
  });
  return { ok: true };
});

// Rechazar el pago SIN cancelar: el turno sigue apartado y la clienta puede reenviar el comprobante
ruta('PUT', '/api/admin/reservas/:id/pago', true, async (req, p) => {
  const b = await leerJSON(req, 2000);
  if (b.pago !== 'rechazado') throw err('Acción no válida.');
  const r = db.prepare('SELECT * FROM reservas WHERE id=?').get(entero(p.id));
  if (!r) throw err('Reserva no encontrada.', 404);
  if (r.estado !== 'pendiente' || r.pago !== 'por_verificar') throw err('Solo se puede rechazar un pago que está por verificar.', 409);
  db.prepare("UPDATE reservas SET pago='rechazado', nota_admin=? WHERE id=?").run(texto(b.motivo, 200), r.id);
  return { ok: true };
});

// Reseñas
ruta('PUT', '/api/admin/resenas/:id', true, async (req, p) => {
  const b = await leerJSON(req, 1000);
  if (!['aprobada', 'pendiente'].includes(b.estado)) throw err('Estado no válido.');
  db.prepare('UPDATE resenas SET estado=? WHERE id=?').run(b.estado, entero(p.id)); return { ok: true };
});
ruta('DELETE', '/api/admin/resenas/:id', true, (req, p) => { db.prepare('DELETE FROM resenas WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Tarjetas para la seña
function validarTarjeta(b) {
  const tipo = b.tipo === 'saldo' ? 'saldo' : 'tarjeta';
  const t = { tipo, banco: texto(b.banco, 40), numero: soloDigitos(b.numero), moneda: tipo === 'saldo' ? 'CUP' : (['CUP', 'MLC', 'USD'].includes(b.moneda) ? b.moneda : 'CUP'),
    titular: texto(b.titular, 60), confirmar: soloDigitos(b.confirmar), activa: [false, 0, "0"].includes(b.activa) ? 0 : 1, orden: entero(b.orden) || 0 };
  if (tipo === 'saldo') {
    if (!t.banco) t.banco = 'Saldo móvil';
    if (t.numero.length < 8 || t.numero.length > 11) throw err('Escribe el número de móvil que recibe el saldo (8 dígitos).', 400, 'numero');
    if (!t.confirmar) t.confirmar = t.numero;
  }
  if (!t.banco) throw err('Escribe el banco (BANDEC, BPA, Metropolitano…).', 400, 'banco');
  if (tipo === 'tarjeta' && (t.numero.length < 16 || t.numero.length > 19)) throw err('El número de tarjeta debe tener 16 dígitos.', 400, 'numero');
  if (t.confirmar.length < 8 || t.confirmar.length > 11) throw err('Escribe el número de teléfono a confirmar (8 dígitos).', 400, 'confirmar');
  return t;
}
const COLS_TAR = ['tipo', 'banco', 'numero', 'moneda', 'titular', 'confirmar', 'activa', 'orden'];
ruta('POST', '/api/admin/tarjetas', true, async (req) => {
  const t = validarTarjeta(await leerJSON(req, 2000));
  if (db.prepare('SELECT COUNT(*) n FROM tarjetas').get().n >= 8) throw err('Máximo 8 métodos de pago.');
  const r = db.prepare(`INSERT INTO tarjetas (${COLS_TAR.join(',')}) VALUES (${COLS_TAR.map(() => '?').join(',')})`).run(...COLS_TAR.map(c => t[c]));
  return { id: Number(r.lastInsertRowid) };
});
ruta('PUT', '/api/admin/tarjetas/:id', true, async (req, p) => {
  const t = validarTarjeta(await leerJSON(req, 2000));
  const r = db.prepare(`UPDATE tarjetas SET ${COLS_TAR.map(c => c + '=?').join(',')} WHERE id=?`).run(...COLS_TAR.map(c => t[c]), entero(p.id));
  if (!r.changes) throw err('Tarjeta no encontrada.', 404);
  return { ok: true };
});
ruta('DELETE', '/api/admin/tarjetas/:id', true, (req, p) => { db.prepare('DELETE FROM tarjetas WHERE id=?').run(entero(p.id)); return { ok: true }; });

// Ajustes
ruta('PUT', '/api/admin/ajustes', true, async (req) => {
  const b = await leerJSON(req, 60_000);
  const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor=excluded.valor');
  const cambios = [];
  for (const k of Object.keys(AJUSTES_BASE)) {
    if (!(k in b)) continue;
    let v = b[k];
    if (k === 'horario') {
      if (!Array.isArray(v) || v.length !== 7) throw err('El horario debe tener los 7 días.');
      v = JSON.stringify(v.map(d => {
        const abre = /^([01]\d|2[0-3]):[0-5]\d$/.test(d?.abre) ? d.abre : '09:00'; const cierra = /^([01]\d|2[0-3]):[0-5]\d$/.test(d?.cierra) ? d.cierra : '18:00';
        if (d?.abierto && abre >= cierra) throw err('En el horario, la hora de cierre debe ser después de la de apertura.');
        return { abierto: !!d?.abierto, abre, cierra };
      }));
    } else if (k === 'faq') {
      if (!Array.isArray(v)) throw err('Las preguntas no tienen el formato correcto.');
      v = JSON.stringify(v.slice(0, 20).map(x => ({ p: texto(x?.p, 160), r: texto(x?.r, 800) })).filter(x => x.p && x.r));
    } else if (k === 'lat' || k === 'lng') {
      const n = Number(String(v).replace(',', '.'));
      if (String(v).trim() !== '' && (!Number.isFinite(n) || Math.abs(n) > (k === 'lat' ? 90 : 180))) throw err(`La ${k === 'lat' ? 'latitud' : 'longitud'} no es válida.`);
      v = String(v).trim() === '' ? '' : n.toFixed(6);
    } else if (['promo_activa', 'fidelidad_activa', 'sena_activa', 'pago_total_activo'].includes(k)) v = v ? '1' : '0';
    else if (k === 'sena_porcentaje' || k === 'fidelidad_visitas') {
      const n = entero(v); const [min, max] = k === 'sena_porcentaje' ? [0, 100] : [2, 30];
      if (!(n >= min && n <= max)) throw err(k === 'sena_porcentaje' ? 'El porcentaje de la seña va de 0 a 100.' : 'Las visitas para el premio van de 2 a 30.');
      v = String(n);
    } else if (k === 'tasa_mlc' || k === 'tasa_usd') {
      const n = Number(String(v).replace(',', '.'));
      if (String(v).trim() !== '' && !(n > 0 && n < 100000)) throw err('La tasa de cambio debe ser un número mayor que 0 (CUP por cada unidad).');
      v = String(v).trim() === '' ? '' : String(Math.round(n * 100) / 100);
    } else if (k === 'whatsapp') { v = soloDigitos(v); if (v.length < 8) throw err('El WhatsApp debe tener al menos 8 dígitos.'); }
    else if (k === 'facebook') { v = texto(v, 200); if (v && /^[a-z]+:/i.test(v) && !/^https:\/\/(www\.|m\.)?facebook\.com\//i.test(v)) throw err('El enlace de Facebook debe empezar por https://facebook.com/'); }
    else if (k === 'instagram') { v = texto(v, 60).replace(/^@/, ''); if (v && !/^[A-Za-z0-9._]+$/.test(v)) throw err('El usuario de Instagram solo lleva letras, números, punto y guion bajo.'); }
    else v = texto(v, 600);
    cambios.push([k, v]);
  }
  transaccion(() => cambios.forEach(([k, v]) => up.run(k, v)));
  return { ok: true };
});

// ============================================================
// 6. SEGURIDAD HTTP: cabeceras, CSP, CORS
// ============================================================
const RESPONDIDO = Symbol('respondido');
function cabecerasBase(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), payment=(), geolocation=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (CONFIG.TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
function csp(nonce) {
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com", "img-src 'self' data: blob: https://tile.openstreetmap.org", "connect-src 'self'",
    "frame-src 'none'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
    "form-action 'self'", "frame-ancestors 'none'",
  ].join('; ');
}
// CORS: por defecto solo el propio dominio. Otros orígenes solo si están en CORS_ORIGINS.
function revisarCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;                                   // misma página o petición sin navegador
  let host; try { host = new URL(origin).host; } catch { return false; }
  if (host === req.headers.host) return true;                 // mismo origen
  if (CONFIG.CORS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return false;
}
function enviar(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(status === 413 ? { Connection: 'close' } : {}) });
  res.end(JSON.stringify(data));
}

// ============================================================
// 7. ARCHIVOS ESTÁTICOS
// ============================================================
const TIPOS = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
function estatico(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Solicitud no válida'); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  let base = PUBLIC_DIR;
  if (rel.startsWith('/uploads/')) { base = UPLOADS; rel = rel.slice('/uploads'.length); }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin') rel = '/admin.html';
  const archivo = path.resolve(base, '.' + path.posix.normalize(rel));
  if (!archivo.startsWith(base + path.sep)) { res.writeHead(404); return res.end('No encontrado'); }
  fs.stat(archivo, (e, st) => {
    if (e || !st.isFile() || path.basename(archivo).startsWith('.')) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
    const ext = path.extname(archivo);
    if (ext === '.html') {
      // Las páginas se escriben sin <head>; aquí se envuelven y cada <script> recibe un nonce único (CSP)
      const nonce = crypto.randomBytes(16).toString('base64');
      const html = fs.readFileSync(archivo, 'utf8').replace(/<script>/g, `<script nonce="${nonce}">`);
      res.writeHead(200, { 'Content-Type': TIPOS['.html'], 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp(nonce) });
      return res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icono.svg" type="image/svg+xml">${html}`);
    }
    res.writeHead(200, { 'Content-Type': TIPOS[ext] || 'application/octet-stream',
      'Cache-Control': base === UPLOADS ? 'public, max-age=31536000, immutable' : 'public, max-age=3600' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(archivo).pipe(res);
  });
}

// ============================================================
// 8. SERVIDOR
// ============================================================
const servidor = http.createServer(async (req, res) => {
  cabecerasBase(req, res);
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const esApi = url.pathname.startsWith('/api/') || url.pathname === '/salud';
  if (!esApi) return estatico(req, res, url);

  const corsOk = revisarCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(corsOk ? 204 : 403); return res.end(); }
  if (!corsOk) return enviar(res, 403, { error: 'Origen no permitido.' });

  for (const r of rutas) {
    const m = r.metodo === req.method && r.patron.exec(url.pathname);
    if (!m) continue;
    if (r.admin && !tokenValido(req)) return enviar(res, 401, { error: 'Tu sesión venció. Vuelve a entrar.' });
    try {
      const out = await r.fn(req, m.groups || {}, url, res);
      if (out !== RESPONDIDO) enviar(res, 200, out);
    } catch (e) {
      if (!e.status) console.error(new Date().toISOString(), req.method, url.pathname, e);
      enviar(res, e.status || 500, { error: e.status ? e.message : 'Error del servidor. Intenta de nuevo.', campo: e.campo });
    }
    return;
  }
  enviar(res, rutas.some(r => r.patron.test(url.pathname)) ? 405 : 404, { error: 'Ruta no encontrada' });
});
servidor.requestTimeout = 90_000;   // subidas lentas con datos móviles
servidor.headersTimeout = 20_000;
servidor.keepAliveTimeout = 65_000;
servidor.listen(CONFIG.PORT, '0.0.0.0', () => console.log(`Estudio de uñas escuchando en el puerto ${CONFIG.PORT} (admin: /admin)`));

// Limpieza diaria: comprobantes viejos se borran (datos personales que ya no hacen falta)
function limpiarComprobantes() {
  const limite = sumarDias(ahoraEnTZ().fecha, -CONFIG.DIAS_COMPROBANTES);
  for (const r of db.prepare("SELECT id, comprobante FROM reservas WHERE comprobante != '' AND fecha < ?").all(limite)) {
    borrarArchivo(PRIVADO, r.comprobante);
    db.prepare("UPDATE reservas SET comprobante='' WHERE id=?").run(r.id);
  }
}
limpiarComprobantes();
setInterval(limpiarComprobantes, 24 * 3600_000).unref();

process.on('unhandledRejection', e => console.error('Promesa sin manejar:', e));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { servidor.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); });

module.exports = { servidor };
