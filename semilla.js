// Carga servicios de ejemplo en una base vacía: npm run semilla
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const archivo = path.join(DATA_DIR, 'estudio.db');
if (!fs.existsSync(archivo)) { console.log('Arranca el servidor una vez (npm start) para crear la base.'); process.exit(1); }
const db = new DatabaseSync(archivo);
if (db.prepare('SELECT COUNT(*) n FROM servicios').get().n) { console.log('Ya hay servicios; no se tocó nada.'); process.exit(0); }
const ins = db.prepare('INSERT INTO servicios (nombre, categoria, precio, duracion, descripcion, popular, extra, orden) VALUES (?,?,?,?,?,?,?,?)');
[
  ['Manicura sencilla', 'Manos', 1200, 45, 'Limado, cutícula y esmalte tradicional.', 0, 0],
  ['Esmalte en gel', 'Manos', 2500, 60, 'Dura de 2 a 3 semanas sin descascararse.', 1, 0],
  ['Retiro de gel', 'Manos', 600, 20, 'Sin limar la uña natural.', 0, 1],
  ['Pedicura completa', 'Pies', 1800, 60, 'Baño, exfoliación, cutícula y esmalte.', 0, 0],
  ['Acrílico (juego completo)', 'Extensiones', 4500, 120, 'Forma almendra, cuadrada o coffin.', 1, 0],
  ['Relleno de acrílico', 'Extensiones', 3000, 90, 'Hasta 3 semanas de crecimiento.', 0, 0],
  ['Diseño a mano (por uña)', 'Diseños', 150, 10, 'French, flores, líneas finas.', 0, 1],
  ['Efecto cromado', 'Diseños', 500, 15, 'Acabado espejo en todas las uñas.', 0, 1],
  ['Pedrería', 'Diseños', 300, 10, 'Cristales en 2 uñas.', 0, 1],
].forEach((s, i) => ins.run(...s, i));
console.log('Servicios de ejemplo cargados. Edita precios desde /admin.');
