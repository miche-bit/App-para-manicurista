# Estudio de uñas v3 — web de trabajos, precios, turnos, seña y estudio

Web app para una manicurista. La clienta ve la galería, los precios, los turnos libres de los próximos 7 días, la ubicación, el horario, las opiniones y su tarjeta de sellos, y reserva en un minuto. La manicurista administra **todo** desde `/admin`, incluida la ubicación y el horario.

Sin dependencias: Node 22.13+ con `node:sqlite`, servidor `node:http`, HTML/CSS/JS sin framework.

## Arrancar

```bash
ADMIN_PASSWORD=unaClaveLarga npm start      # http://localhost:3000  y  /admin
```

**Servicios de la clienta:** están en `servicios-iniciales.json` (pedicuras, acrílico en tips y rellenos con sus precios por largo). Se cargan solos la primera vez que arranca el servidor con la base vacía. Si la base ya tiene servicios de prueba: `npm run semilla -- --reemplazar` (o edítalos desde el panel).

**Opciones de precio (variantes):** un servicio puede tener opciones como Cortas / Medianas / … / XXXL o "Solo en el pulgar / En todas las uñas". En la web se muestra "desde" el más barato, cada opción es un botón que lleva directo a reservar con ese largo, y al reservar la clienta elige una. En el panel se escriben una por línea: `Cortas = 1800`.

## Variables de entorno

Todas están explicadas en `.env.example`. En Railway van en **Variables**; en tu PC, copia `.env.example` como `.env` (el servidor lo lee solo y está en `.gitignore`).

| Variable | Para qué | En Railway |
|---|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel. **Sin ella el servidor no arranca en producción.** Si la cambias, se cierran todas las sesiones abiertas. | Obligatoria, 12+ caracteres |
| `DATA_DIR` | Base de datos, fotos y comprobantes | `/data` (el volumen) |
| `TZ_NEGOCIO` | Zona horaria del negocio | `America/Havana` |
| `CORS_ORIGINS` | Dominios extra que pueden llamar a la API (coma). Vacío = solo el propio | Vacío, salvo que uses dominio propio además del de Railway |
| `TRUST_PROXY` | Usar la IP real que agrega el proxy | Se activa sola |
| `SESSION_HOURS` | Duración de la sesión del panel | 72 |
| `DIAS_COMPROBANTES` | Días que se guardan los comprobantes antes de borrarse | 120 |

**Railway:** volumen en `/data`, Healthcheck Path `/salud`, start `npm start`. Cierre ordenado con `SIGTERM`. Las bases de versiones anteriores se migran solas.

## Pago de la seña (nuevo)

1. En **Mi estudio → Pago de la seña**, Leyanis activa la seña y pone el porcentaje (30 % por defecto).
2. En **Tarjetas para recibir la seña** agrega una o varias tarjetas: banco, número de 16 dígitos, moneda, titular y **número a confirmar** (su móvil). Puede ocultarlas sin borrarlas.
3. Al reservar, la clienta ve el paso 2 de 2: el monto exacto de la seña (lo calcula el servidor), las tarjetas con botón de copiar, el número a confirmar, y **debe subir la foto del comprobante** (se reduce en el teléfono antes de enviarla). El número de transacción es opcional.
4. En **Agenda** aparece "Pago por verificar". Con **Ver comprobante** Leyanis ve la foto junto a lo que debe decir (monto, nombre, fecha) y elige **Pago correcto: confirmar** o **Rechazar pago** (libera el turno y le da el mensaje de WhatsApp listo para avisar).
5. Si no hay ninguna tarjeta activa, la web no pide seña.

Los comprobantes son **privados**: se guardan fuera de la carpeta pública, solo se ven desde el panel con sesión, nunca se guardan en caché y se borran solos pasados `DIAS_COMPROBANTES` días.

## Seguridad

**Reglas de acceso (equivalente a RLS).** Row Level Security es una función de Postgres/Supabase; esta app usa SQLite, que no la tiene, así que las mismas reglas están en el servidor (sección 4 de `server.js`) y todo pasa por ellas:
- **Público:** solo servicios activos, trabajos, reseñas aprobadas, tarjetas activas, turnos libres futuros y ajustes sin claves internas. Las reservas, teléfonos, notas y comprobantes no tienen ninguna ruta pública. La tarjeta de sellos solo devuelve un conteo.
- **Panel:** todas las rutas exigen un token firmado (HMAC-SHA256) que caduca y que se invalida al cambiar `ADMIN_PASSWORD`.
- La base de datos no es accesible desde internet; el archivo tiene permisos 600.

**CORS.** Por defecto solo el propio dominio. Otro dominio necesita estar en `CORS_ORIGINS`; si no, el preflight y cualquier escritura reciben 403.

**Cabeceras.** CSP con *nonce* por petición (un script inyectado no se ejecuta), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, `COOP/CORP` y HSTS detrás de https.

**Otras defensas.** Límite por IP en reservas (5/h), reseñas (3/h), sellos (20/h) y login (10/h, con demora); la IP no se puede falsificar con `X-Forwarded-For`. Campo trampa contra robots. Solo JSON y con tamaño máximo. Las fotos se validan por su firma real (un archivo disfrazado de PNG se rechaza; SVG no se acepta). Rutas de archivos protegidas contra `../`. Una URL malformada no tumba el servidor. Precios y seña se calculan en el servidor. Los estados de reserva solo cambian por transiciones válidas. Doble reserva del mismo turno imposible (transacción).

## Auditoría automática

```bash
npm test
```
Levanta un servidor temporal con una base vacía (no toca tus datos) y corre 33 pruebas de flujos y seguridad: variables de entorno, cabeceras, CORS, acceso, fuerza bruta, validaciones, seña, comprobantes privados, doble reserva simultánea, transiciones, reseñas, sellos, galería y sesiones.

## Qué configura la manicurista en el panel

| Pestaña | Contenido |
|---|---|
| **Agenda** | Resumen animado (por confirmar, **pagos por verificar**, ingresos confirmados de 7 días, ocupación, % de ausencias), clientas de hoy, reservas con **comprobante**, verificar o rechazar el pago, WhatsApp para confirmar, recordar, **pedir opinión** e **invitar a volver**. |
| **Turnos** | Abrir turnos por semanas (los días vienen marcados según su horario), bloquear, liberar, quitar. |
| **Precios y galería** | Servicios, "Más pedido", **complementos** (cromado, pedrería, retiro) y fotos comprimidas a WEBP. |
| **Reseñas** | Las opiniones llegan como pendientes; solo se publican si ella las aprueba. |
| **Mi estudio** | Datos y redes · **Ubicación** (dirección, referencia, ciudad, lat/lng; se llenan pegando un enlace de Google Maps o con "Usar mi ubicación actual", con vista previa del mapa) · **Horario** por día · Promoción de portada · Tarjeta de sellos · **Pago de la seña y tarjetas** · Política de cancelación · Preguntas y cuidados. |

## Web pública

4 pestañas (Ley de Hick: una decisión por pantalla):
- **Trabajos**: galería con filtros, primer trabajo destacado, etiqueta "Nuevo" (14 días), visor con deslizar/flechas y "Quiero este diseño".
- **Precios**: por categoría, complementos marcados, seña y política antes de reservar.
- **Turnos**: día → hora → datos. Complementos con total y duración que se actualizan animados. Recuerda nombre y teléfono si la clienta quiere. Al terminar: WhatsApp prellenado, **agregar a Google Calendar**, copiar número.
- **Estudio**: mapa (ilustrado por defecto; el interactivo de OpenStreetMap solo carga si la clienta lo pide, para ahorrar datos), "Cómo llegar" (Google Maps) y OpenStreetMap, horario con el día de hoy marcado y "Abierta ahora / abre mañana", opiniones con promedio, tarjeta de sellos por teléfono, preguntas frecuentes, contacto.

## Animaciones

Todas definidas con tokens de movimiento (`--dur`, `--ease-out`, `--ease-spring`) y apagadas con `prefers-reduced-motion`:
- Portada: letras del nombre que suben desenfocadas una a una, pincelada de esmalte que se pinta bajo el nombre con un brillo que la recorre, remolino de laca girando lento, contenido escalonado.
- Franja de promoción con destello, punto verde que late si está abierta.
- Barra inferior con indicador que se desliza con rebote; los paneles entran desde el lado de la pestaña elegida.
- Galería: entrada escalonada, tarjetas que se elevan con zoom y reflejo de laca al pasar.
- Días y horas con "pop" al elegir, botón Continuar que brilla cuando está listo, total con conteo animado.
- Diálogos que aparecen con escala y desenfoque del fondo, visor con deslizamiento.
- Éxito: círculo y check que se dibujan + confeti de gotas de esmalte.
- Estudio: pin del mapa que cae con rebote y onda, estrellas que se llenan, sellos que se estampan uno a uno, acordeón de preguntas suave, secciones que aparecen al hacer scroll.
- Panel: indicador de pestañas, cifras que cuentan, barras de ocupación que crecen.

## Los 4 principios de diseño

1. **Skeletons** con la forma exacta de cada sección (galería, precios, turnos, mapa, KPIs del panel) y `aria-busy`.
2. **Ley de Hick**: 4 pestañas públicas, flujo por pasos, primer día con huecos preseleccionado, servicio sugerido, filtros limitados.
3. **Design tokens** en `public/design.css`: color, tipografía, espacio, forma **y movimiento**, con tema oscuro.
4. **Accesibilidad WCAG 2.2 AA**: pestañas ARIA con teclado, radios nativos, errores por campo, `aria-live`, foco visible, 44 px, contraste verificado, diálogos nativos, animaciones respetando "reducir movimiento".

## Siguientes pasos posibles
- Turnos según duración del servicio (un acrílico de 2 h ocupa dos huecos).
- Lista de espera automática al cancelar.
- Tarjetas de regalo.
- Varias manicuristas en el mismo local.
