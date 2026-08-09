# Plan: Uptime global histórico (día, semana, mes, año)

## Resumen
Añadir un sistema de registro histórico del **uptime global agregado** con resolución diaria, semanal, mensual y anual, exponerlo en el JSON de estado y mostrarlo en la página pública con un botón debajo del uptime del día que abra una vista de histórico general.

## Motivación actual
- `status.json` solo tiene `totalonline` como valor puntual del día actual.
- No existe histórico global; no se puede consultar si un mes fue 99.999 % o 98.438 %.
- El usuario pide: guardar el % global por día/semana/mes/año y un botón para ver esos datos.

## Enfoque elegido
1. **Backend (`utils/detector.js`)**: calcular y persistir el uptime global en 4 periodos dentro de `status.json` bajo `globalUptime`. Aprovechar `dailyHistory` de cada servicio para recomputar/agrupar.
2. **Frontend**: añadir una mini-sección/hero con el uptime del día y un botón "Ver histórico global". Al pulsarlo, se abre una nueva vista SPA (`view-global-uptime`) con tablas/grids de días/semanas/meses/años.
3. **Template & CSS**: actualizar `templates/index.template.html` y `public/main.css` para que la regeneración de `index.html` conserve los cambios.
4. **Textos**: añadir claves nuevas a `public/lang/es.json` e `en.json`.

## Cambios detallados

### 1. `utils/detector.js`
- Añadir helpers de agrupación temporal (usar zona UTC-6 ya existente):
  - `getWeekKey(date)` → `"2026-W30"` (semana ISO).
  - `getMonthKey(date)` → `"2026-08"`.
  - `getYearKey(date)` → `"2026"`.
- Inicializar `store.globalUptime` si no existe con la estructura:
  ```json
  {
    "daily":   [{"date":"2026-08-08","onlineper":99.998}],
    "weekly":  [{"year":2026,"week":30,"onlineper":99.998}],
    "monthly": [{"year":2026,"month":8,"onlineper":99.998}],
    "yearly":  [{"year":2026,"onlineper":99.998}]
  }
  ```
- Al final de cada ciclo de `runCheck`, después de calcular `store.totalonline`:
  - Registrar/actualizar la entrada del **día actual** con `store.totalonline` (promedio acumulado del día). Como el detector corre cada minuto, el valor del día actual se actualiza cada ciclo; cuando cambie el día, el valor final queda congelado.
  - Recomputar semanas/meses/años a partir del array `daily`.
  - Aplicar retención: días últimos 90, semanas últimas 52, meses últimos 24, años últimos 5.
- Nota: para no perder precisión, cada entrada diaria se guarda con `precise()` (truncado a 3 decimales) igual que el resto del sistema.

### 2. `public/index.html` y `templates/index.template.html`
- Reemplazar el bloque hero de uptime por:
  ```html
  <div class="uptime" aria-label="Total availability">
    <div data-text-key="total-uptime-label">Disponibilidad total</div>
    <strong id="uptime-percent" aria-live="polite">–</strong>
    <button id="btn-global-uptime" class="uptime-history-link" type="button">
      <span data-text-key="global-uptime-history-link">Ver histórico global</span>
    </button>
  </div>
  ```
- Añadir la nueva vista SPA justo después de `view-service`:
  ```html
  <div id="view-global-uptime" class="spa-view" hidden role="main" aria-label="Global uptime history"></div>
  ```

### 3. `public/js/main.js`
- Guardar referencia a `_allStatusData` (ya existe).
- Añadir `navigateGlobalUptime()` y `navigateHome()` compatible (la vista global tiene su propio botón de volver).
- Añadir listener al botón `#btn-global-uptime`.
- Implementar `renderGlobalUptime(container, data)` con:
  - Nav superior con botón atrás.
  - Título "Disponibilidad global".
  - Selector de periodo: **Día / Semana / Mes / Año**.
  - Tabla/grid con las entradas de `data.globalUptime` para el periodo activo, mostrando el periodo y el % con clase de color (`excellent/good/poor`).
- Actualizar `loadStatus` para refrescar la vista global si está abierta.

### 4. Nuevo archivo `public/js/globaluptime.js` (opcional)
- Para no engordar `main.js`, se puede crear este módulo con la lógica de renderizado y añadirlo a la lista de scripts en `index.html` y `templates/index.template.html`.
- Depende de `utils.js`.

### 5. `public/main.css`
- Estilos para `.uptime-history-link` (botón pequeño debajo del porcentaje).
- Estilos para la vista global: `.global-uptime-view`, `.period-tabs`, `.period-tab`, `.uptime-table`, `.uptime-row`, `.uptime-cell`, clases de color.
- Mantener consistencia con el diseño existente (glassmorphism, bordes suaves, colores de acento).

### 6. `public/lang/es.json` y `public/lang/en.json`
Nuevas claves:
- `global-uptime-history-link`
- `global-uptime-title`
- `global-uptime-period-day`
- `global-uptime-period-week`
- `global-uptime-period-month`
- `global-uptime-period-year`
- `global-uptime-back`
- `global-uptime-no-data`
- `global-uptime-date`
- `global-uptime-availability`

### 7. `data/status.json`
- No se edita manualmente; `detector.js` lo inicializará/actualizará automáticamente en el primer ciclo tras el despliegue.

## Flujo de datos
1. Detector recoge checks por servicio.
2. Cierra hora → día (`dailyHistory` de cada servicio).
3. Calcula `totalonline` promedio de todos los servicios activos.
4. Guarda/actualiza el día actual en `globalUptime.daily`.
5. Agrupa días en semanas/meses/años y guarda en `globalUptime.weekly/monthly/yearly`.
6. Endpoint `/uptime` devuelve `globalUptime` junto al resto del estado.
7. Frontend muestra el % del día y permite abrir el histórico global con los 4 periodos.

## Límites y retención
| Periodo | Retención |
|---------|-----------|
| Día     | 90 días   |
| Semana  | 52 semanas|
| Mes     | 24 meses  |
| Año     | 5 años    |

## Consideraciones
- El uptime global del día se computa como promedio de los `onlineper` de cada servicio (mismo criterio que `totalonline` actual). Los días con servicios eliminados o en mantenimiento no se incluyen en el promedio de ese día.
- Para semanas/meses/años sin datos completos (periodo parcial), se promedia con los días disponibles.
- Los textos seguirán respetando el idioma configurado en `appearance.json` (es/en).
- La regeneración de `index.html` desde el admin mantendrá la nueva estructura al actualizar `templates/index.template.html`.

## Verificación
- Iniciar/reiniciar el detector.
- Confirmar que `status.json` crece el campo `globalUptime.daily` con el día actual.
- Esperar/force-check varios ciclos y verificar que al cambiar de día se congela el día anterior.
- Abrir la web, pulsar "Ver histórico global" y comprobar que se ven las pestañas Día/Semana/Mes/Año.
- Verificar que el CSS y los textos se aplican correctamente en ambos idiomas.
