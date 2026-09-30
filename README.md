# Estudio de uñas v2 — web de trabajos, precios, turnos y estudio

Web app para una manicurista. La clienta ve la galería, los precios, los turnos libres de los próximos 7 días, la ubicación, el horario, las opiniones y su tarjeta de sellos, y reserva en un minuto. La manicurista administra **todo** desde `/admin`, incluida la ubicación y el horario.

Sin dependencias: Node 22.13+ con `node:sqlite`, servidor `node:http`, HTML/CSS/JS sin framework.

## Arrancar

```bash
ADMIN_PASSWORD=unaClaveLarga npm start      # http://localhost:3000  y  /admin
npm run semilla                              # opcional: servicios y complementos de ejemplo
```

| Variable | Para qué |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel. **Obligatoria en producción.** |
| `DATA_DIR` | Carpeta de la base y las fotos. En Railway, el volumen (`/data`). |
| `TZ_NEGOCIO` | Zona horaria para "hoy", "abierta ahora" y ocultar turnos pasados. Por defecto `America/Havana`. |
| `PORT` | Lo pone Railway. |

**Railway:** volumen en `/data`, `DATA_DIR=/data`, `ADMIN_PASSWORD`, start `npm start`. Opcional: Healthcheck Path `/salud`. El servidor escucha en `0.0.0.0`, cierra ordenado con `SIGTERM` y ya no imprime el aviso experimental de SQLite. Las bases de la v1 se migran solas (columnas nuevas).

## Qué configura la manicurista en el panel

| Pestaña | Contenido |
|---|---|
| **Agenda** | Resumen animado (por confirmar, ingresos confirmados de 7 días, ocupación, % de ausencias), clientas de hoy, reservas con WhatsApp para confirmar, recordar, **pedir opinión** e **invitar a volver**. |
| **Turnos** | Abrir turnos por semanas (los días vienen marcados según su horario), bloquear, liberar, quitar. |
| **Precios y galería** | Servicios, "Más pedido", **complementos** (cromado, pedrería, retiro) y fotos comprimidas a WEBP. |
| **Reseñas** | Las opiniones llegan como pendientes; solo se publican si ella las aprueba. |
| **Mi estudio** | Datos y redes · **Ubicación** (dirección, referencia, ciudad, lat/lng; se llenan pegando un enlace de Google Maps o con "Usar mi ubicación actual", con vista previa del mapa) · **Horario** por día · Promoción de portada · Tarjeta de sellos · Seña y políticas · Preguntas y cuidados. |

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
