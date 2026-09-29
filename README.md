# Estudio de uñas — web de trabajos, precios y turnos

Web app para una manicurista: la clienta ve la galería de trabajos, la lista de precios y los turnos libres de los próximos 7 días, y solicita turno en un minuto. La manicurista administra todo desde `/admin`.

Sin dependencias: Node 22.13+ con `node:sqlite`, servidor `node:http`, HTML/CSS/JS sin framework.

## Arrancar

```bash
ADMIN_PASSWORD=unaClaveLarga npm start      # http://localhost:3000  y  /admin
npm run semilla                              # opcional: carga servicios de ejemplo
```

| Variable | Para qué |
|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel. **Obligatoria en producción.** |
| `DATA_DIR` | Carpeta de la base y las fotos. En Railway, apúntala al volumen (ej. `/data`). |
| `TZ_NEGOCIO` | Zona horaria para "hoy" y ocultar turnos pasados. Por defecto `America/Havana`. |
| `PORT` | Lo pone Railway solo. |

**Railway:** crea el servicio desde el repo, agrega un volumen montado en `/data`, define `DATA_DIR=/data` y `ADMIN_PASSWORD`. Start command: `npm start`.

## Flujo

1. La manicurista abre turnos en **Admin → Turnos** (días que trabaja + horas de inicio, para 1–4 semanas).
2. La clienta elige **día → hora → datos**. El turno queda *pendiente* y se bloquea al instante (transacción SQLite, sin dobles reservas).
3. La clienta tiene un botón para avisar por WhatsApp con el mensaje ya escrito.
4. En **Admin → Reservas** la manicurista confirma, escribe por WhatsApp, manda recordatorio, marca *completada* / *no vino*, o cancela (el turno vuelve a quedar libre).

## Los 4 principios de diseño, aplicados

**1. Skeletons.** Mientras carga, cada sección muestra la silueta exacta de su contenido: cuadrícula de fotos, filas de precio, días y horas. En el panel igual. Los contenedores llevan `aria-busy` para lectores de pantalla y la animación se apaga con `prefers-reduced-motion`.

**2. Ley de Hick (no violarla).** Cada pantalla pide una sola decisión:
- Solo 3 pestañas: Trabajos, Precios, Turnos.
- Reserva en pasos: primero el día (ya viene marcado el primero con huecos), después aparece la hora, después el formulario.
- Filtros de galería limitados a 4 categorías fijas; solo se muestran las que tienen trabajos.
- "Más pedido" marca el servicio sugerido y viene preseleccionado.
- Desde Precios o desde una foto ("Quiero este diseño") se salta directo a Turnos con esa elección ya hecha.

**3. Design tokens.** Todo color, fuente, tamaño, radio, espacio y duración vive en `public/design.css` (bloque `:root`). Cambiar la marca de otra clienta = editar ese bloque. Tema oscuro incluido redefiniendo solo los tokens.

**4. Accesibilidad (WCAG 2.2 AA).** `lang="es"`, enlace "Saltar al contenido", pestañas con patrón ARIA y flechas del teclado, días y horas como radios nativos agrupados en `fieldset`/`legend`, etiquetas en todos los campos, errores junto al campo con `aria-invalid` y `aria-describedby`, avisos en `aria-live`, foco visible, objetivos táctiles de 44 px, contraste verificado (texto secundario 6.4:1, acento 7.3:1), `alt` en fotos, diálogos nativos `<dialog>` que atrapan el foco.

## Agregado (lo que suelen tener hoy estas apps)

- **Seña y política de cancelación visibles** antes de reservar y en la confirmación (editable en Ajustes). Pagos pensados para Transfermóvil/EnZona.
- **WhatsApp integrado:** mensaje prellenado para la clienta; botones de confirmar y recordar para la manicurista.
- **"Próximo turno libre"** en la portada.
- **Aviso si la semana está llena** con botón para pedir que le avisen.
- **Estados de reserva:** pendiente, confirmada, completada, no vino, cancelada (para medir ausencias).
- **Fotos comprimidas en el navegador** (1200 px WEBP) antes de subir: menos datos móviles para ella y para las clientas.
- **Notas en la reserva:** diseño deseado, forma, largo, alergias.
- **Anti-spam:** máximo 5 solicitudes por hora por IP.
- **Etiquetas Open Graph** para que el enlace se vea bien al compartirlo en WhatsApp e Instagram.

## Siguientes pasos posibles

- Turnos según duración del servicio (un acrílico de 2 h ocupa dos huecos).
- Lista de espera automática cuando se cancela un turno.
- PWA instalable y recordatorios automáticos 24 h antes.
- Varias manicuristas en el mismo local.
