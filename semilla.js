// Carga los servicios de servicios-iniciales.json
//   npm run semilla                 -> solo si no hay servicios
//   npm run semilla -- --reemplazar -> borra los servicios actuales y carga la lista
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const archivo = path.join(DATA_DIR, 'estudio.db');
if (!fs.existsSync(archivo)) { console.log('Arranca el servidor una vez (npm start): al crear la base carga la lista sola.'); process.exit(1); }
const db = new DatabaseSync(archivo);
const reemplazar = process.argv.includes('--reemplazar');
if (db.prepare('SELECT COUNT(*) n FROM servicios').get().n && !reemplazar) { console.log('Ya hay servicios; no se tocó nada. Usa --reemplazar para cambiarlos.'); process.exit(0); }
const lista = JSON.parse(fs.readFileSync(path.join(__dirname, 'servicios-iniciales.json'), 'utf8'));
const ins = db.prepare('INSERT INTO servicios (nombre, categoria, precio, duracion, descripcion, popular, extra, orden, variantes) VALUES (?,?,?,?,?,?,?,?,?)');
db.exec('BEGIN');
if (reemplazar) db.exec('DELETE FROM servicios');
lista.forEach((s, i) => {
  const vars = s.variantes || [];
  ins.run(s.nombre, s.categoria, vars.length ? Math.min(...vars.map(v => v.precio)) : s.precio, s.duracion || 0, s.descripcion || '',
    s.popular ? 1 : 0, s.extra ? 1 : 0, i, vars.length ? JSON.stringify(vars) : '');
});
db.exec('COMMIT');
console.log(`${lista.length} servicios cargados.`);
