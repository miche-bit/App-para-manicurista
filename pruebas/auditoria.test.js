// Auditoría automática de la API, los flujos y la seguridad.
// Uso: npm test   (levanta un servidor temporal con una base vacía; no toca tus datos)
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const FALSO_PNG = 'data:image/png;base64,' + Buffer.from('<script>alert(1)</script>').toString('base64');
const CLAVE = 'clave-de-prueba-larga-123';
const PERMITIDO = 'https://permitido.example';
let srv; let B; let dataDir; let token; let ipN = 1;
const nuevaIP = () => `10.0.0.${ipN++}`;

function arrancar(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    const onData = d => { log += d; const m = /puerto (\d+)/.exec(log); if (m) resolve({ p, log: () => log }); };
    p.stdout.on('data', onData); p.stderr.on('data', d => { log += d; });
    p.on('exit', code => reject(new Error('El servidor se cerró: ' + code + '\n' + log)));
    setTimeout(() => reject(new Error('Tiempo agotado\n' + log)), 8000);
  });
}
async function pedir(metodo, ruta, { body, tok, headers = {}, ip = nuevaIP(), crudo } = {}) {
  const h = { 'X-Forwarded-For': ip, ...headers };
  if (body !== undefined) h['Content-Type'] = h['Content-Type'] || 'application/json';
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(B + ruta, { method: metodo, headers: h, body: body === undefined ? undefined : (crudo ? body : JSON.stringify(body)) });
  const tipo = r.headers.get('content-type') || '';
  const datos = tipo.includes('json') ? await r.json() : await r.text();
  return { status: r.status, datos, h: r.headers };
}
const publico = async () => (await pedir('GET', '/api/publico')).datos;
const admin = async () => (await pedir('GET', '/api/admin/datos', { tok: token })).datos;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-prueba-'));
  const puerto = 3900 + Math.floor(Math.random() * 500);
  srv = await arrancar({ ADMIN_PASSWORD: CLAVE, DATA_DIR: dataDir, PORT: String(puerto), TRUST_PROXY: '1', CORS_ORIGINS: PERMITIDO, NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  B = `http://127.0.0.1:${puerto}`;
});
after(() => { srv?.p.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// ---------------- Arranque y variables de entorno ----------------
test('en producción no arranca sin ADMIN_PASSWORD', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'estudio-env-'));
  await assert.rejects(arrancar({ ADMIN_PASSWORD: '', DATA_DIR: dir, PORT: '0', NODE_ENV: 'production' }), /ADMIN_PASSWORD/);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('carga los servicios iniciales de la clienta', async () => {
  const d = await publico();
  assert.equal(d.servicios.length, 6);
  const tips = d.servicios.find(s => s.nombre === 'Acrílico en tips');
  assert.equal(tips.variantes.length, 6);
  assert.equal(tips.precio, 1800, 'el precio "desde" es el más barato');
});

// ---------------- Cabeceras y archivos ----------------
test('cabeceras de seguridad y CSP con nonce', async () => {
  const r = await pedir('GET', '/');
  assert.equal(r.status, 200);
  for (const h of ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy', 'content-security-policy']) assert.ok(r.h.get(h), 'falta ' + h);
  const nonce = /nonce-([^']+)'/.exec(r.h.get('content-security-policy'))[1];
  assert.ok(r.datos.includes(`<script nonce="${nonce}">`), 'el script lleva el nonce');
  assert.ok(!/<script>/.test(r.datos), 'ningún script sin nonce');
  assert.ok(r.datos.startsWith('<!doctype html><html lang="es">'));
});
test('HSTS cuando llega por https detrás del proxy', async () => {
  const r = await pedir('GET', '/salud', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(r.h.get('strict-transport-security') || '', /max-age/);
});
test('no se puede leer código ni la base (path traversal)', async () => {
  for (const ruta of ['/../server.js', '/%2e%2e/server.js', '/uploads/../estudio.db', '/uploads/%2e%2e/estudio.db', '/..%2fserver.js', '/.env', '/uploads/../privado/comprobantes/x']) {
    const r = await fetch(B + ruta, { redirect: 'manual' });
    assert.ok([400, 404].includes(r.status), `${ruta} devolvió ${r.status}`);
    const t = await r.text(); assert.ok(!t.includes('require(') && !t.includes('SQLite'), 'no filtra contenido: ' + ruta);
  }
});
test('una URL malformada no tumba el servidor', async () => {
  const r = await fetch(B + '/%E0%A4%A');
  assert.equal(r.status, 400);
  assert.equal((await pedir('GET', '/salud')).status, 200);
});
test('métodos raros en archivos estáticos', async () => {
  assert.equal((await fetch(B + '/', { method: 'POST' })).status, 405);
});

// ---------------- CORS ----------------
test('CORS: origen desconocido bloqueado en preflight y en escrituras', async () => {
  const pre = await fetch(B + '/api/reservas', { method: 'OPTIONS', headers: { Origin: 'https://malo.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 403);
  assert.equal(pre.headers.get('access-control-allow-origin'), null);
  const r = await pedir('POST', '/api/resenas', { body: { nombre: 'X', estrellas: 5, texto: 'hola hola' }, headers: { Origin: 'https://malo.example' } });
  assert.equal(r.status, 403);
});
test('CORS: origen permitido recibe cabeceras; mismo origen funciona', async () => {
  const pre = await fetch(B + '/api/publico', { method: 'OPTIONS', headers: { Origin: PERMITIDO } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), PERMITIDO);
  const mismo = await pedir('GET', '/api/publico', { headers: { Origin: B } });
  assert.equal(mismo.status, 200);
});

// ---------------- Acceso (equivalente a RLS) ----------------
test('panel: sin token, token falso o manipulado → 401', async () => {
  assert.equal((await pedir('GET', '/api/admin/datos')).status, 401);
  assert.equal((await pedir('GET', '/api/admin/datos', { tok: 'abc' })).status, 401);
  const exp = Date.now() + 1e9;
  assert.equal((await pedir('GET', '/api/admin/datos', { tok: `${exp}.${'a'.repeat(64)}` })).status, 401);
  for (const [m, r] of [['POST', '/api/admin/servicios'], ['PUT', '/api/admin/ajustes'], ['DELETE', '/api/admin/tarjetas/1'], ['GET', '/api/admin/reservas/1/comprobante']])
    assert.equal((await pedir(m, r, { body: m === 'GET' || m === 'DELETE' ? undefined : {} })).status, 401, `${m} ${r}`);
});
test('login: contraseña mala 401, buena da token', async () => {
  assert.equal((await pedir('POST', '/api/admin/login', { body: { clave: 'mala' } })).status, 401);
  const r = await pedir('POST', '/api/admin/login', { body: { clave: CLAVE } });
  assert.equal(r.status, 200); token = r.datos.token;
  assert.match(token, /^\d+\.[a-f0-9]{64}$/);
});
test('login: fuerza bruta frenada por IP', async () => {
  const ip = nuevaIP(); let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await pedir('POST', '/api/admin/login', { body: { clave: 'x' + i }, ip });
  assert.equal(ultimo.status, 429);
});
test('la IP del limitador no se puede falsificar con X-Forwarded-For', async () => {
  const real = nuevaIP(); let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await pedir('POST', '/api/admin/login', { body: { clave: 'y' }, headers: { 'X-Forwarded-For': `1.2.3.${i}, ${real}` } });
  assert.equal(ultimo.status, 429, 'se usa la IP que agrega el proxy (la última)');
});
test('datos públicos no exponen reservas, teléfonos, secretos ni filas ocultas', async () => {
  await pedir('POST', '/api/admin/tarjetas', { tok: token, body: { banco: 'Oculta', numero: '9225111122223333', confirmar: '51111111', activa: false } });
  await pedir('POST', '/api/resenas', { body: { nombre: 'Pendiente', estrellas: 3, texto: 'aún sin revisar' } });
  const d = await publico();
  assert.ok(!('reservas' in d));
  const claves = new Set(); (function recorrer(o) { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { claves.add(k); recorrer(v); } })(d);
  for (const prohibida of ['_secret', 'telefono', 'comprobante', 'transaccion', 'notas', 'estado', 'activa', 'activo']) assert.ok(!claves.has(prohibida), 'expone ' + prohibida);
  assert.ok(!d.tarjetas.some(t => t.banco === 'Oculta'), 'tarjeta inactiva oculta');
  assert.ok(!d.resenas.some(r => r.nombre === 'Pendiente'), 'reseña sin aprobar oculta');
  assert.ok(!d.resenas.some(r => 'estado' in r));
});
test('JSON requerido y tamaño máximo', async () => {
  assert.equal((await pedir('POST', '/api/resenas', { body: 'nombre=x', crudo: true, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  const grande = { nombre: 'a', estrellas: 5, texto: 'x'.repeat(10000) };
  assert.equal((await pedir('POST', '/api/resenas', { body: grande })).status, 413);
});

// ---------------- Configuración del estudio ----------------
test('ajustes: validaciones', async () => {
  const mal = [{ lat: '999' }, { horario: [1, 2] }, { sena_porcentaje: 150 }, { whatsapp: '12' }, { facebook: 'javascript:alert(1)' }, { instagram: 'a b<' },
    { horario: Array.from({ length: 7 }, () => ({ abierto: true, abre: '18:00', cierra: '09:00' })) }];
  for (const b of mal) assert.equal((await pedir('PUT', '/api/admin/ajustes', { tok: token, body: b })).status, 400, JSON.stringify(b));
  const ok = await pedir('PUT', '/api/admin/ajustes', { tok: token, body: { lat: '22,1456', lng: '-80.4364', sena_porcentaje: 30, sena_activa: true, instagram: '@leyanis.nails' } });
  assert.equal(ok.status, 200);
  const a = (await publico()).ajustes;
  assert.equal(a.lat, '22.145600'); assert.equal(a.instagram, 'leyanis.nails'); assert.equal(a.sena_porcentaje, '30');
});
test('tarjetas: validación y CRUD', async () => {
  assert.equal((await pedir('POST', '/api/admin/tarjetas', { tok: token, body: { banco: 'BANDEC', numero: '1234', confirmar: '59092880' } })).status, 400);
  assert.equal((await pedir('POST', '/api/admin/tarjetas', { tok: token, body: { banco: 'BANDEC', numero: '9225 0000 1111 2222', confirmar: '12' } })).status, 400);
  const r = await pedir('POST', '/api/admin/tarjetas', { tok: token, body: { banco: 'BANDEC', numero: '9225 0000 1111 2222', confirmar: '59092880', titular: 'Leyanis' } });
  assert.equal(r.status, 200);
  const t = (await publico()).tarjetas.find(x => x.id === r.datos.id);
  assert.equal(t.numero, '9225000011112222'); assert.equal(t.confirmar, '59092880');
  assert.equal((await pedir('PUT', '/api/admin/tarjetas/9999', { tok: token, body: { banco: 'X', numero: '9225000011112222', confirmar: '59092880' } })).status, 404);
});
test('servicios: variantes, complementos y validaciones', async () => {
  assert.equal((await pedir('POST', '/api/admin/servicios', { tok: token, body: { nombre: 'X', categoria: 'Inventada', precio: 1 } })).status, 400);
  assert.equal((await pedir('POST', '/api/admin/servicios', { tok: token, body: { nombre: 'X', categoria: 'Diseños', extra: true, variantes: [{ nombre: 'a', precio: 1 }] } })).status, 400);
  const r = await pedir('POST', '/api/admin/servicios', { tok: token, body: { nombre: 'Decoración', categoria: 'Diseños', precio: 200, extra: true } });
  assert.equal(r.status, 200);
  const d = await publico(); assert.ok(d.servicios.find(s => s.id === r.datos.id).extra);
});

// ---------------- Turnos y reservas ----------------
let manana; let turnos = [];
test('turnos: validación y generación sin duplicados', async () => {
  const d = await publico();
  manana = new Date(d.ahora.fecha + 'T12:00:00Z'); manana.setUTCDate(manana.getUTCDate() + 1); manana = manana.toISOString().slice(0, 10);
  assert.equal((await pedir('POST', '/api/admin/turnos/generar', { tok: token, body: { horas: ['25:00'] } })).status, 400);
  const g = { desde: manana, dias: 3, diasSemana: [0, 1, 2, 3, 4, 5, 6], horas: ['09:00', '10:30', '12:00', '14:00', '15:30', '17:00'] };
  const r1 = await pedir('POST', '/api/admin/turnos/generar', { tok: token, body: g });
  assert.equal(r1.datos.creados, 18);
  const r2 = await pedir('POST', '/api/admin/turnos/generar', { tok: token, body: g });
  assert.equal(r2.datos.creados, 0, 'no duplica');
  turnos = (await publico()).dias.flatMap(x => x.turnos);
  assert.ok(turnos.length >= 12);
});
const reservaBase = () => ({ servicio_id: 5, variante: 3, nombre: 'Ana Pérez', telefono: '+53 5234 5678', notas: 'french', comprobante: PNG, transaccion: 'TMW123' });
test('reserva: validaciones de cada campo', async () => {
  const t = turnos[0].id; const casos = [
    [{ nombre: 'A' }, 'nombre'], [{ telefono: '123' }, 'telefono'], [{ servicio_id: 999 }, 'servicio'], [{ variante: undefined }, 'variante'],
    [{ variante: 99 }, 'variante'], [{ comprobante: undefined }, 'comprobante'],
  ];
  for (const [cambio, campo] of casos) {
    const r = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), ...cambio, turno_id: t } });
    assert.equal(r.status, 400, JSON.stringify(cambio)); assert.equal(r.datos.campo, campo);
  }
  assert.equal((await pedir('POST', '/api/reservas', { body: { ...reservaBase(), comprobante: FALSO_PNG, turno_id: t } })).status, 400, 'archivo disfrazado');
  assert.equal((await pedir('POST', '/api/reservas', { body: { ...reservaBase(), comprobante: 'data:image/svg+xml;base64,PHN2Zz4=', turno_id: t } })).status, 400, 'SVG no');
  assert.equal((await pedir('POST', '/api/reservas', { body: { ...reservaBase(), web: 'spam', turno_id: t } })).status, 400, 'campo trampa');
  assert.equal((await publico()).dias.flatMap(x => x.turnos).some(x => x.id === t), true, 'ningún intento fallido ocupó el turno');
});
test('reserva: turno pasado rechazado', async () => {
  const hoy = (await publico()).ahora.fecha;
  await pedir('POST', '/api/admin/turnos/generar', { tok: token, body: { desde: hoy, dias: 1, diasSemana: [0, 1, 2, 3, 4, 5, 6], horas: ['00:00'] } });
  const pasado = (await admin()).turnos.find(x => x.fecha === hoy && x.hora === '00:00');
  const r = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), turno_id: pasado.id } });
  assert.equal(r.status, 409);
  assert.ok(!(await publico()).dias[0].turnos.some(x => x.id === pasado.id), 'no se muestra en la web');
});
let reservaId;
test('reserva correcta: precio de la variante + seña del 30 % calculada en el servidor', async () => {
  const r = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), turno_id: turnos[0].id, extras: [7, 7] } });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  assert.equal(r.datos.servicio, 'Acrílico en tips · XL');
  assert.equal(r.datos.precio, 3500 + 200, 'XL + decoración (duplicado ignorado)');
  assert.equal(r.datos.sena, Math.ceil(3700 * 0.3));
  assert.equal(r.datos.pago, 'por_verificar');
  reservaId = r.datos.id;
  assert.ok(!(await publico()).dias.flatMap(x => x.turnos).some(x => x.id === turnos[0].id), 'el turno ya no está libre');
});
test('doble reserva simultánea del mismo turno: solo una gana', async () => {
  const t = turnos[1].id;
  const rs = await Promise.all(Array.from({ length: 6 }, () => pedir('POST', '/api/reservas', { body: { ...reservaBase(), turno_id: t } })));
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(rs.filter(r => r.status === 409).length, 5);
});
test('límite de reservas por IP', async () => {
  const ip = nuevaIP(); let ultimo;
  for (let i = 0; i < 6; i++) ultimo = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), nombre: 'A' }, ip });
  assert.equal(ultimo.status, 429);
});
test('comprobante: privado, solo con token y sin caché', async () => {
  const d = await admin(); const r = d.reservas.find(x => x.id === reservaId);
  assert.equal(r.tieneComprobante, true); assert.ok(!('comprobante' in r), 'el nombre del archivo no sale del servidor');
  assert.equal((await pedir('GET', `/api/admin/reservas/${reservaId}/comprobante`)).status, 401);
  const ok = await fetch(`${B}/api/admin/reservas/${reservaId}/comprobante`, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png'); assert.match(ok.headers.get('cache-control'), /no-store/);
  const archivos = fs.readdirSync(path.join(dataDir, 'privado', 'comprobantes'));
  for (const f of archivos) assert.equal((await fetch(`${B}/uploads/${f}`)).status, 404, 'no accesible por /uploads');
});
test('estados: transiciones inválidas bloqueadas; confirmar verifica el pago', async () => {
  assert.equal((await pedir('PUT', `/api/admin/reservas/${reservaId}`, { tok: token, body: { estado: 'completada' } })).status, 409);
  assert.equal((await pedir('PUT', `/api/admin/reservas/${reservaId}`, { tok: token, body: { estado: 'inventado' } })).status, 400);
  assert.equal((await pedir('PUT', `/api/admin/reservas/${reservaId}`, { tok: token, body: { estado: 'confirmada' } })).status, 200);
  const r = (await admin()).reservas.find(x => x.id === reservaId);
  assert.equal(r.estado, 'confirmada'); assert.equal(r.pago, 'verificado');
  assert.equal((await pedir('PUT', `/api/admin/reservas/${reservaId}`, { tok: token, body: { estado: 'completada' } })).status, 200);
});
test('rechazar pago: cancela, libera el turno y se puede reactivar', async () => {
  const r = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), turno_id: turnos[2].id } });
  const id = r.datos.id;
  assert.equal((await pedir('PUT', `/api/admin/reservas/${id}`, { tok: token, body: { estado: 'cancelada', pago: 'rechazado' } })).status, 200);
  let x = (await admin()).reservas.find(y => y.id === id);
  assert.equal(x.estado, 'cancelada'); assert.equal(x.pago, 'rechazado');
  assert.ok((await publico()).dias.flatMap(d => d.turnos).some(t => t.id === turnos[2].id), 'turno libre otra vez');
  assert.equal((await pedir('PUT', `/api/admin/reservas/${id}`, { tok: token, body: { estado: 'pendiente' } })).status, 200);
  x = (await admin()).reservas.find(y => y.id === id);
  assert.equal(x.pago, 'por_verificar', 'vuelve a quedar por verificar');
  assert.ok(!(await publico()).dias.flatMap(d => d.turnos).some(t => t.id === turnos[2].id), 'turno ocupado otra vez');
});
test('turno con reserva no se puede bloquear ni borrar', async () => {
  assert.equal((await pedir('PUT', `/api/admin/turnos/${turnos[0].id}`, { tok: token, body: { estado: 'bloqueado' } })).status, 409);
  assert.equal((await pedir('DELETE', `/api/admin/turnos/${turnos[0].id}`, { tok: token })).status, 409);
  assert.equal((await pedir('PUT', `/api/admin/turnos/${turnos[5].id}`, { tok: token, body: { estado: 'bloqueado' } })).status, 200);
  assert.ok(!(await publico()).dias.flatMap(d => d.turnos).some(t => t.id === turnos[5].id), 'bloqueado no aparece');
});
test('sin tarjetas activas no se pide seña', async () => {
  const d = await admin();
  for (const t of d.tarjetas) await pedir('PUT', `/api/admin/tarjetas/${t.id}`, { tok: token, body: { ...t, activa: false } });
  const r = await pedir('POST', '/api/reservas', { body: { ...reservaBase(), comprobante: undefined, turno_id: turnos[6].id } });
  assert.equal(r.status, 200, JSON.stringify(r.datos)); assert.equal(r.datos.sena, 0); assert.equal(r.datos.pago, 'sin_pago');
  for (const t of d.tarjetas) await pedir('PUT', `/api/admin/tarjetas/${t.id}`, { tok: token, body: { ...t } });
});

// ---------------- Reseñas y sellos ----------------
test('reseñas: pendiente → aprobada → pública; validaciones', async () => {
  assert.equal((await pedir('POST', '/api/resenas', { body: { nombre: 'Eva', estrellas: 9, texto: 'muy bien' } })).status, 400);
  const htmlMalo = '<img src=x onerror=alert(1)>';
  await pedir('POST', '/api/resenas', { body: { nombre: 'Eva', estrellas: 5, texto: htmlMalo } });
  const r = (await admin()).resenas.find(x => x.texto === htmlMalo);
  await pedir('PUT', `/api/admin/resenas/${r.id}`, { tok: token, body: { estado: 'aprobada' } });
  const d = await publico();
  assert.ok(d.resenas.some(x => x.id === r.id)); assert.equal(d.resumenResenas.total, 1);
});
test('tarjeta de sellos: solo cuenta visitas completadas y no filtra datos', async () => {
  const r = await pedir('GET', '/api/fidelidad?telefono=52345678');
  assert.equal(r.status, 200); assert.equal(r.datos.sellos, 1);
  assert.deepEqual(Object.keys(r.datos).sort(), ['meta', 'premio', 'premiosGanados', 'sellos']);
  assert.equal((await pedir('GET', '/api/fidelidad?telefono=12')).status, 400);
});

// ---------------- Galería ----------------
test('galería: imagen falsa rechazada; foto válida se publica con nosniff', async () => {
  assert.equal((await pedir('POST', '/api/admin/trabajos', { tok: token, body: { titulo: 'X', categoria: 'Pies', imagen: FALSO_PNG } })).status, 400);
  const r = await pedir('POST', '/api/admin/trabajos', { tok: token, body: { titulo: 'French', categoria: 'Pies', imagen: PNG, color: 'red;background:url(x)' } });
  assert.equal(r.status, 200);
  const f = await fetch(B + r.datos.imagen);
  assert.equal(f.status, 200); assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
  const t = (await publico()).trabajos.find(x => x.id === r.datos.id);
  assert.equal(t.color, '#A3123F', 'color inválido reemplazado');
});

// ---------------- Sesiones ----------------
test('cambiar ADMIN_PASSWORD invalida las sesiones anteriores', async () => {
  srv.p.kill(); await new Promise(r => setTimeout(r, 400));
  const puerto = Number(new URL(B).port);
  srv = await arrancar({ ADMIN_PASSWORD: 'otra-clave-distinta-456', DATA_DIR: dataDir, PORT: String(puerto), TRUST_PROXY: '1', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '' });
  assert.equal((await pedir('GET', '/api/admin/datos', { tok: token })).status, 401);
});
