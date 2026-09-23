# PLAN-13 — ai-workflows v1: el proceso se escribe como receta

Versión 5 · **Aprobado** por GPT-6 Sol `high` en 5 rondas (22-sep-2026) · Autor del spec: Claude Opus 5.5 · Issue #13
Revisor del spec: GPT-6 Sol `high` · Continúa `socialabs-margin/Socialabs#997 (privado)` (se muda aquí)

## En tres líneas

**Qué pasa hoy:** el motor existe y sus piezas funcionan, pero cada proyecto tiene que escribir su
proceso como un programa largo, y la parte de Socialabs se construyó dentro de Socialabs, donde un
paso a medio terminar llegó a trabar la fila de fusión.

**Qué cambia:** el motor pasa a funcionar como GitHub Actions: cada proyecto escribe una receta
corta y legible que arma bloques ya hechos, y todo se construye y se prueba fuera de Socialabs.

**Por qué importa:** el dueño puede leer qué exige su proceso sin saber programar, y Socialabs no
vuelve a sufrir un experimento: recibe el motor una sola vez, terminado, probado y con apagado.

---

## 1. De dónde venimos

`Socialabs#997` construyó el motor `ai-workflows` (v0.3.0, 9 469 líneas en `src/`, 70 archivos de
prueba) y lo instaló en Socialabs. La parte de Socialabs quedó escrita como programa:
`pipeline.config.ts` (1 848 líneas) más ~5 100 líneas de scripts en `scripts/pipeline/`,
`scripts/proceso/` y `scripts/candados/`. Una firma experimental (`pipeline-fila`) exigió repetir
toda la suite antes de entrar a la fila, trabó PRs ordinarios y se retiró (ADR 0219 de Socialabs,
18-sep). Desde entonces el motor está **apagado en Socialabs**, salvo dos piezas que sí operan y el
dueño usa a diario: el visto bueno con código corto (`visto-bueno.yml`) y el candado de la cola
nativa (`candado-cola.yml`).

Este plan **no** reinicia el diseño. Conserva todo lo que el spec anterior (PLAN-997 v9, aprobado
en 5 rondas) y la construcción demostraron, y cambia tres cosas: **dónde** se construye, **cómo**
declara cada proyecto su proceso y **cómo** se integra.

### 1.1 Lo que se conserva sin cambios (resumen de PLAN-997)

Se copia aquí porque PLAN-997 vive en un repositorio privado.

**Modelo de amenaza.**

| Nivel | Contra qué | Cómo |
|---|---|---|
| A — Descuido | Agente que se salta un paso o reporta verde sin correrlo | El motor **recomputa**; no cree archivos de evidencia |
| B — Elusión oportunista | `--no-verify`, PR desde la web, merge desde otra máquina | Un **check en GitHub** vuelve a comprobar lo esencial |
| C — Falsificación por un administrador | Quien tiene las llaves | **No se defiende; se declara.** Queda rastro y `doctor` avisa si las protecciones no son las esperadas |

Excepciones aceptadas del nivel B: un workflow deliberado con permiso de publicar estados puede
imitar el visto bueno (ADR 0214 de Socialabs) y el estado del juez (R13 de este plan). Ninguna
validación los presenta como resistentes; el juez deja rastro cuando detecta uno.

**Cuatro naturalezas de compuerta**, y ninguna promete más: *recompute* (se produce otra vez
ahora), *structure* (forma de un documento, no su verdad), *execution record* (propiedad histórica
validada contra el diario que escribió el motor), *attest* (juicio humano o de modelo publicado como
evento autenticado de GitHub con autor y SHA). Lo recomputable se recomputa; un comando obligatorio
que no pudo correr queda `blocked:technical`, nunca «atestiguado».

**Identidad.** Publicador (cuenta de GitHub) ≠ ejecución (proveedor + modelo + esfuerzo + sesión)
≠ pieza (repo, pieza, base, SHA). La independencia de un revisor se juzga por la identidad de
ejecución y la familia, nunca por la cuenta de GitHub.

**Pipeline lineal.** Una etapa tiene como máximo un predecesor; dos etapas con el mismo `after`
se rechazan. Si una pieza necesita paralelismo, se parte en dos piezas.

**Vigencia de la evidencia** (tabla §5.5 de PLAN-997): actualización limpia con la base conserva la
revisión con registro verificable y repite puerta y QA; conflicto de código obliga a revisar el
delta; commit nuevo o force push caducan la revisión; QA nunca se conserva si cambia el SHA; el
visto bueno se conserva si la huella de cambios propios es idéntica.

**Estados terminales:** `blocked:technical`, `blocked:rejected`, `waiting:decision` (la pieza que
preguntó espera entera; las demás siguen), `parked` (libera reservas, conserva carpeta y rama).

**Concurrencia y recuperación:** reserva con comparación de versión, arrendamiento con latido, todo
efecto externo con identificador de operación y estados `pending` / `confirmed` / `uncertain`, y
reanudación que reconcilia contra GitHub en vez de repetir. Estado en `refs/ai-workflows/*`, fuera
de ramas y etiquetas (ya construido en v0.2.0).

**Mensajes al dueño:** plantillas con el resumen de tres líneas al inicio, lista configurable de
palabras prohibidas y largo máximo; el detalle técnico se guarda aparte (D53 y D54 de PLAN-997).

**Los trece casos negativos** (CN-01…CN-13) con su control positivo siguen siendo la suite
permanente (§8.2).

---

## 2. Decisiones del dueño (entrevista del 22-sep-2026)

| # | Decisión |
|---|---|
| R01 | **Todo fuera de Socialabs.** El motor, sus bloques, la receta de Socialabs y todas las pruebas se construyen fuera. Socialabs no recibe ningún cambio por esta pieza hasta el día de integrar. |
| R02 | **La receta la escriben los agentes y la lee el dueño.** Tiene que leerse como una lista de pasos sin saber programar. Lo complejo vive en bloques del motor. |
| R03 | **Dos campos de prueba:** el repositorio de ensayo pequeño (`socialabs-margin/ai-workflows-pruebas`) para los intentos de trampa, y una **copia privada de Socialabs** para el ensayo general, usada al final para cuidar minutos de GitHub. |
| R04 | **Lo dormido en Socialabs no se toca.** `pipeline.config.ts`, `scripts/pipeline/`, `scripts/proceso/` y la dependencia fija a v0.3.0 se quedan como están hasta integrar. `visto-bueno.yml` y `candado-cola.yml` siguen operando igual. |
| R05 | **Genérico, para los proyectos del dueño primero**, con una receta de ejemplo para arrancar un proyecto nuevo. No se pule como producto para desconocidos en esta versión. |
| R06 | **Corre en dos partes:** junto al agente (guía y frena cada etapa) y un check en GitHub antes de fusionar, para que los atajos ordinarios (`--no-verify`, PR desde la web, merge desde otra máquina) no se lo salten. Imitarlo a propósito es el límite aceptado en R13. |
| R07 | **La copia de Socialabs no tiene ninguna llave de producción.** Vista previa y base de datos se prueban contra proyectos de prueba propios y vacíos, gratuitos o del plan que ya se paga. |
| R08 | **Palabras de la receta en inglés, con notas en español.** El motor puede mostrar la receta entera explicada en español. |
| R09 | **Seguimiento en este repositorio y su tablero.** `Socialabs#997` se cierra con una nota que apunta aquí; el día de integrar se abre un issue nuevo en Socialabs. Lo pendiente de mutantes pasa a un issue propio de Socialabs. |
| R10 | **La receta de Socialabs copia el proceso vigente, sin reglas nuevas.** Las cuatro reglas que proponía #997 (parvada en todo código, retirar «lo cotidiano directo», elección de modelos al cerrar la entrevista, preguntas solo de negocio) se proponen después, una por una, cada una como un cambio de receta. |
| R11 | **Se integra solo cuando se cumplan las condiciones de ADR 0219** (§7) y el dueño lo apruebe en un único cambio. |
| R12 | **Modelos de esta pieza:** constructor GPT-6 Sol `high`; relevo DeepSeek V4.1 Flash `high` por OpenCode; revisión del spec GPT-6 Sol `high`; revisión del código, parvada de revisores Claude especializados en sesiones frescas. |
| R13 | **Se acepta el riesgo de que un workflow deliberado imite el estado del juez** (decisión del 22-sep, tras la ronda 2 de revisión), igual que ADR 0214 lo aceptó para `visto-bueno`. Se declara y se deja rastro; no se crea una app propia ni se paga el plan Enterprise por esto. Alternativas descartadas: app de GitHub propia (gratis, más montaje) y flujos obligatorios de Enterprise (~21 USD por persona al mes tras la prueba). |

Decisiones de construcción tomadas por el orquestador (el dueño decide qué, el orquestador cómo):
YAML 1.2 con esquema publicado (§3.2), condiciones estructuradas sin lenguaje de expresiones en v1
(§3.4), bloques con manifiesto (§4), check del servidor sin segunda suite pesada (§5), reutilizar
el núcleo de v0.3.0 (§6).

---

## 3. La receta

### 3.1 Dónde vive

Todo lo del motor en un proyecto vive en **una sola carpeta**, `.ai-workflows/`, igual que
`.github/workflows/`:

```
.ai-workflows/
  pipeline.yml        # la receta
  blocks/             # bloques propios del proyecto (opcional)
    <name>/block.yml  # manifiesto
    <name>/...        # su programa
```

Retirar el motor de un proyecto es borrar esa carpeta y el check del servidor.

### 3.2 Formato

- **YAML 1.2**, leído con la biblioteca `yaml` en modo estricto: `NO` sigue siendo texto,
  **claves duplicadas se rechazan**, **anclas y alias se rechazan** (la reutilización es con
  `uses:`), claves desconocidas se rechazan.
- **Esquema JSON publicado por versión** del motor. La receta lo declara en su primera línea
  (`# yaml-language-server: $schema=…`) y el editor valida, completa y explica mientras se escribe.
- `ai-workflows validate` rechaza con archivo, línea, columna y motivo. `run` y el check del
  servidor validan antes de hacer nada; una receta inválida nunca corre a medias.
- Palabras en inglés; cada etapa lleva `summary:` en el idioma de `locale:` para el dueño.

### 3.3 Qué contiene

```yaml
# yaml-language-server: $schema=https://github.com/luismichelcf/ai-workflows/releases/download/v1.0.0/recipe.schema.json
version: 1
locale: es
owner: luismichelcf                 # cuenta product_owner (visto bueno, decisiones «dueño»)

classify:                           # tablas de rutas: datos, no código
  money:      ["lib/calc/**", "**/*nomina*", "**/*cierre*"]
  security:   ["supabase/migrations/**", "**/*rls*"]
  visible:    ["app/**", "components/**", "public/**", "electron/**"]
  production: [".github/workflows/**", "scripts/fila/**"]

kinds:                              # tipos de cambio que declara cada pieza
  default: behavior
  from-paths:                       # si TODOS los archivos caen aquí, ese es el tipo
    docs: ["docs/**"]
    prototype: ["proto/**"]
  elevate:                          # el riesgo real manda sobre lo declarado
    - when: { touches-any: [money, security], kind-none: [behavior, ui-behavior] }
      to: behavior
    - when: { touches-any: [production], kind-any: [visual-only, config-no-prod, generated] }
      to: prod-config

stages:
  - id: red-test
    summary: "Primero una prueba que falla por la razón correcta"
    after: spec-review
    nature: execution-record
    applies-if: { kind-any: [behavior] }
    gate:
      uses: ai-workflows/red-test@1
      with: { command: "pnpm vitest run {tests}" }
    server: { require-check: ai-workflows/red-test }   # corrida sin privilegios, ver §5.2

  - id: flock-review
    summary: "Revisores independientes aprueban el cambio final"
    after: boundaries
    nature: attest
    applies-if: { touches-any: [money, security, production] }
    valid-while: same-fingerprint-or-clean-update
    gate:
      uses: ai-workflows/independent-review@1
      with: { forbid-same-family: true }
    server: attestation

  - id: owner-approval
    summary: "El dueño aprueba lo que se ve"
    after: qa
    nature: attest
    needs-human: true
    applies-if: { touches-any: [visible] }
    valid-while: same-fingerprint
    gate:
      uses: ai-workflows/approval-comment@1
      with: { command: /visto-bueno, code-length: 7 }
    server: attestation

  - id: merge-queue
    summary: "Entra a la cola de GitHub y la observa hasta el final"
    after: owner-approval
    phase: merge
    nature: recompute
    valid-while: same-sha
    gate:
      uses: ./.ai-workflows/blocks/fila      # bloque módulo: sus efectos van por runEffect
```

Campos de etapa: `id`, `summary`, `after`, `phase` (`pre-merge` por omisión · `merge` · `post-merge`),
`required` (verdadero por omisión), `nature`, `applies-if`, `valid-while`, `needs-human`, `gate`
(`uses` + `with`, o `run` + `with`), `server`, `retry` (intentos y espera, con tope). Nada más.
Exactamente una etapa tiene `phase: merge`; `validate` rechaza cero o varias.

**Vigencia (`valid-while`), con semántica cerrada** (tabla §5.5 de PLAN-997):

| Valor | La evidencia sigue vigente si… | Caduca si… |
|---|---|---|
| `same-sha` | el SHA juzgado es el mismo | cambia el SHA por cualquier motivo |
| `same-fingerprint` | la huella de los cambios propios de la pieza (diff contra su base de fusión, sin renombres) es idéntica | cambia la huella |
| `same-fingerprint-or-clean-update` | el SHA juzgado sigue idéntico, o cambió **solo** por una actualización con la base **registrada por el motor o por el vigilante de la fila** como fusión sin conflicto, cuyo segundo padre es un commit de la base y cuyo árbol difiere del anterior únicamente en archivos que llegaron de la base | hubo conflicto resuelto (se exige revisar el delta), commit nuevo de la pieza, **force push aunque la huella sea idéntica**, o la actualización no tiene ese registro verificable |
| `forever` | siempre, salvo que la etapa desaparezca de la receta | nunca por sí sola |

El QA nunca puede declarar algo distinto de `same-sha`; `validate` lo rechaza.

### 3.4 Condiciones sin lenguaje de expresiones

`applies-if` acepta solo formas estructuradas: `touches-any`, `touches-none` (sobre `classify`),
`kind-any` (comportamiento, visual, configuración, papeles…), `lane-any`. Los umbrales van como
entradas tipadas del bloque (`with: { min-psa: 5 }`), no como expresiones. No hay `${{ }}` ni
interpolación en comandos: los datos llegan al programa como JSON por la entrada estándar.

Motivo: evita el problema documentado de GitHub Actions (conversión laxa de tipos e inyección en
scripts) y la única biblioteca JavaScript de CEL es beta. Si en el futuro hace falta una condición
que no quepa en estas formas, se evalúa CEL en un cambio aparte.

«No aplica» se registra como `skipped` con su motivo; nunca como «ejecutada y aprobada».

### 3.5 `explain` e `init`

- `ai-workflows explain` imprime la receta en el idioma de `locale`, sin jerga: qué etapas hay, en
  qué orden, cuándo aplica cada una y qué pasa si falla. Es lo que lee el dueño.
- `ai-workflows init` escribe una receta de ejemplo genérica (sin nada de Socialabs) para arrancar
  un proyecto nuevo.

---

## 4. Los bloques

### 4.1 Bloques del motor

`uses: ai-workflows/<name>@<major>`. Cada uno trae manifiesto: entradas tipadas con valores por
omisión, naturalezas permitidas, qué produce y cómo se verifica en el servidor. Lista v1, sacada de
las compuertas que hoy viven en `pipeline.config.ts` y del motor:

| Bloque | Hace | Naturaleza |
|---|---|---|
| `spec-structure` | Secciones exigidas, resumen de tres líneas, criterios con identificador, decisiones sin pendientes | structure |
| `benchmark-sources` | Cuenta fuentes por categoría, dominios distintos, URL alcanzable, apartados evidencia/inferencia/ausencia | structure |
| `sandboxed-review` | Veredicto de revisión emitido en solo lectura con árbol idéntico antes y después | recompute + attest |
| `red-test` | Corre la prueba y exige que falle la aserción identificada, no importación ni entorno | recompute + execution-record |
| `build-verify` | La prueba pasa; al retirar solo la implementación vuelve a fallar por la misma aserción; pruebas intactas; sin commits del constructor | recompute + execution-record |
| `command` | Corre un comando con tiempo límite y exige salida 0 | recompute |
| `scope-reconcile` | Compara archivos realmente tocados contra lo declarado y sube el carril si crece el riesgo | recompute |
| `independent-review` | Veredictos de la parvada: identidad de ejecución ≠ constructor, familia distinta, SHA vigente, todos terminados, sin bloqueantes | execution-record + attest |
| `approval-comment` | Visto bueno por comentario de `owner` con código corto y huella | attest + recompute |
| `preview-deployment` | El despliegue de vista previa de ese commit existe y está listo (Vercel, genérico por estado de GitHub) | recompute |
| `browser-qa` | Corre la suite de navegador del proyecto contra ese despliegue y exige cada criterio por identificador | recompute |
| `github-merge` | Arma la fusión automática sobre el SHA exacto o entra a la cola nativa, y observa hasta el final | recompute |
| `post-merge` | Workflows y despliegue de producción **de ese merge** en verde u omitidos con motivo | recompute |
| `cleanup` | Carpeta, rama, procesos hijos y reservas de la pieza | recompute |

### 4.2 Bloques del proyecto y salida de escape

Dos clases, según si el bloque produce efectos fuera del motor:

- **Bloque módulo** — `uses: ./.ai-workflows/blocks/<name>` con su `block.yml` y un módulo
  JavaScript. Recibe el **mismo contexto que una compuerta de v0.3.0** (`GateContext` de
  `src/contract.ts`): el cambio, el **diario de solo lectura**, `locale`, `mode`, la **señal de
  cancelación** y **`runEffect`** con identificador de operación y conciliación. **Todo efecto
  externo** (abrir un PR, pedir turno, publicar un veredicto, armar la fusión) va obligatoriamente
  por aquí y por `runEffect`.
- **Bloque comando** — `run: <comando>`, o `uses:` de un bloque con `kind: command`. Proceso aparte,
  **solo para comprobaciones sin efectos externos** y de naturaleza `recompute` o `structure`. Recibe
  por entrada estándar un JSON con la pieza, SHA, base, archivos tocados, clasificación, carril, modo
  ensayo, entradas `with` y el diario de solo lectura; escribe
  `{ "ok": true | false | "skipped", "reason": "...", "evidence": {...} }`. Al cancelar la pieza, el
  motor le envía la señal de terminar y espera a que el árbol de procesos acabe, con tope.
  `validate` rechaza un bloque comando declarado con naturaleza `attest` o `execution-record`.
- Salida distinta de 0, JSON inválido, campo desconocido, tiempo agotado u `ok` ausente →
  `blocked:technical` con el motivo. **Nunca** aprobado.
- **El motor valida la evidencia según la naturaleza declarada**, no la cree: un registro histórico
  sale del diario que escribió el motor, nunca de lo que imprime un bloque.
- En Socialabs serán bloques propios: la fila con la cola nativa, QA sobre preview con cuentas de
  prueba, release del escritorio, barrido de arquitectura y las rutas de dinero.

---

## 5. Las dos partes: junto al agente y en GitHub

### 5.1 Junto al agente

El CLI actual (`run`, `status`, `stop`, `pause`, `resume`, `doctor`, `validate`, `--dry-run`) lee
la receta en vez de `pipeline.config.ts`. Estado en `refs/ai-workflows/*` como hoy. Los ganchos de
editor y de git siguen siendo ayuda (nivel A).

### 5.2 Check en GitHub: «el juez»

El motor publica una **acción reutilizable** y una plantilla de workflow que el proyecto instala.
Sigue el patrón ya probado en Socialabs por `candado-cola.yml` (ADR 0225): corre con
`pull_request_target` y con `merge_group`, publica un **estado** con nombre propio sobre el SHA que
juzga, su job se llama distinto del estado, y nunca baja ni ejecuta código del PR.

**Procedencia del juez** (frontera de seguridad, ADR 0219):

- El workflow del juez, la versión de la acción (fijada por SHA, no por etiqueta movible), los
  bloques que ejecuta y la receta se leen **de la rama base**. El job con permiso de publicar estados
  no hace checkout del código del PR ni lo ejecuta.
- El estado se correlaciona con la corrida oficial: nombre del workflow, ruta del archivo en la
  base, emisor (la app de GitHub Actions de ese workflow) y el SHA juzgado. Un estado con el mismo
  nombre y otra procedencia **no cuenta para el juez**, que la detecta en su siguiente corrida y la
  reporta; pero GitHub puede aceptar el estado imitado para fusionar (límite aceptado, R13).
- **En `merge_group` el YAML del workflow sale de la rama temporal del grupo**, que incluye los
  cambios del PR (ADR 0225, «Por qué el candado no es un workflow obligatorio»). Por eso el juez de
  `pull_request_target`, que sí sale de la base, **rechaza todo PR que modifique los archivos del
  juez** (`.ai-workflows/`, su workflow, la versión fijada de la acción) salvo con una atestación
  específica del dueño para ese SHA. Así un juez alterado no puede formarse en la cola sin que el
  juez confiable lo haya dejado pasar a sabiendas.
- **Límite aceptado (R13):** cualquier workflow del repositorio publica estados con la misma
  identidad (la app de GitHub Actions), así que un workflow deliberado puede imitar el estado del
  juez y GitHub lo aceptaría. No se impide; se declara y se deja rastro: en cada corrida el juez
  lista los estados con su nombre que no salieron de su corrida oficial y los reporta en el PR y en
  el informe de seguridad de la rebanada 6.

**SHA que juzga:** en `pull_request_target`, la cabeza del PR; en `merge_group`, el SHA del grupo,
y los PRs del grupo se obtienen de la lista de la cola, no preguntando a qué PR pertenece el commit
(lección de #1091). La suite pesada se acredita con el check que ya la corre **sobre el SHA del
grupo**; un verde de la cabeza del PR no acredita al grupo.

**Frontera del merge.** Cada etapa declara `phase: pre-merge` (por omisión) o `post-merge`
(`post-merge` y `cleanup` por naturaleza). Toda etapa `pre-merge` que aplique debe tener
comprobación en el servidor:

| `server:` | Qué hace el juez | Costo |
|---|---|---|
| `recompute` | Vuelve a correr la comprobación, solo si es barata (esquema, alcance, huella, títulos) | segundos |
| `require-check: <nombre>` | Exige ese check verde **para el SHA juzgado** (cabeza o grupo, según el evento) | ninguno extra |
| `attestation` | Busca el evento autenticado (veredicto, comentario) que nombra el SHA o la huella vigente | segundos |
| `local-only` | **Solo permitido en etapas `post-merge` o informativas** (`required: false`). `validate` lo rechaza en una etapa `pre-merge` obligatoria | — |

**El juez no lee el diario ni el almacén** (`refs/ai-workflows/*`): quien puede empujar puede
reescribirlos (README del motor) y PLAN-997 D06 los define como proyección, no autoridad. Por eso:

- Lo que una etapa `execution-record` tiene de recomputable se recomputa en el servidor. Ejemplo:
  la prueba roja. Correrla exige ejecutar código del PR, así que **no la corre el juez**: la corre un
  **job aparte y sin privilegios** (eventos `pull_request` **y `merge_group`**, sin secretos,
  `permissions: contents: read`, sin permiso de publicar estados), que termina como check
  `ai-workflows/red-test` **sobre el SHA de su propio evento**:
  - en `pull_request`, ejecuta las pruebas nuevas o cambiadas del PR contra el árbol de su base
    (deben fallar por aserción) y contra la cabeza (deben pasar);
  - en `merge_group`, obtiene los PRs del grupo de la lista de la cola y, para cada pieza a la que
    aplica la etapa, ejecuta sus pruebas nuevas o cambiadas contra la base del grupo (deben fallar)
    y contra el SHA del grupo (deben pasar). Un check del SHA de un PR nunca acredita al grupo. El juez privilegiado solo lee la conclusión de ese check para
  el SHA juzgado (`require-check`). Esa corrida ejecuta código del PR, igual que `todo-verde`, y
  merece la misma confianza que él: nivel B frente a atajos, no frente a un PR malicioso.
- Lo que es puramente histórico (el orden «una prueba → su implementación») queda como **nivel A**:
  lo impone el motor junto al agente y `explain` lo declara así; el juez no lo presenta como
  comprobado en el servidor.
- Como el juez no depende del almacén, un almacén caído o corrupto no bloquea ningún PR en el
  servidor.

Regla: **el juez nunca corre una segunda suite pesada** (ADR 0219: una sola puerta pesada por
cabeza).

### 5.3 Interruptor y degradación

Un estado exigido por la protección de `main` que no se publica **bloquea** el merge, así que el
interruptor no puede ser solo «dejar de publicar». Dos llaves, coordinadas:

- **Variable del repositorio `AI_WORKFLOWS_MODE`** (`off` · `advisory` · `on`), que el juez lee en
  cada corrida. Con `off` publica su estado **en verde con la descripción «motor apagado»**; con
  `advisory` publica el veredicto real en un estado aparte no exigido (`ai-workflows/advisory`) y el
  estado principal en verde; con `on` publica el veredicto real en el estado principal.
- **La protección de `main`** exige el estado del juez **solo** a partir de la activación. Integrar
  lo deja instalado con `off` y **sin** exigirlo en la protección. Encender es: el dueño cambia la
  variable a `on` y enseguida añade el estado a la protección, igual que `COLA_NATIVA` (ADR 0225).
  Apagar es el camino inverso; con la variable en `off` basta para desatascar al instante, aunque la
  protección siga exigiéndolo.
- **Cada PR se juzga por separado.** El tipo de cambio sale del diff recomputado, sin almacén ni
  proveedores. Un PR de papeles, o cualquier PR cuyas etapas aplicables no dependan del componente
  caído, se juzga normalmente aunque otro PR esté en `blocked:technical`.
- Fallas que el juez sabe manejar con `on`: error interno del motor, proveedor de modelos caído,
  almacén ilegible. Solo bloquean las etapas que dependen de ellas, con motivo.
- **Límite declarado:** si la API de estados de GitHub o GitHub Actions están caídas, ningún estado
  exigido puede publicarse, tampoco `todo-verde`, y ni siquiera el verde «motor apagado» de `off`.
  El remedio es el mismo de hoy para cualquier check: el dueño lo quita de la protección.
- Plan de apagado documentado y **probado** en la copia antes de integrar, incluido el fallo a mitad
  del cambio (variable cambiada y protección no, y al revés).

---

### 5.4 Cómo queda la protección de `main` al encender

**El juez se suma; no reemplaza nada.** Al encender, la protección de `main` de Socialabs exige
`todo-verde`, `candado-cola` y el estado del juez. `visto-bueno.yml` y `candado-cola.yml` siguen
igual. Motivo: copia fiel primero (R10) y un solo cambio a la vez; retirar `candado-cola` si el juez
lo duplica es una propuesta posterior, con su propia evidencia. La rebanada 6 ensaya **exactamente**
esta topología en la copia (EG-00) y la 7 instala solo lo que se ensayó.

## 6. Qué se reutiliza del motor v0.3.0

Se conservan, con sus pruebas: máquina de estados y reanudación por evidencia (`engine.ts`),
almacén en GitHub y arrendamientos (`store-git.ts`, `store-github.ts`), identidad (`identity.ts`),
proveedores y relevo (`providers.ts`, `exec.ts`), candados (`locks/`), compuertas genéricas
(`gates.ts`). Se añade: lector y validador de receta, esquema, registro de bloques, contrato de
`run:`, `explain`, `init`, acción del servidor. `pipeline.config.ts` deja de ser la forma de
declarar un proceso; el tipo `StageConfig` se genera desde la receta.

La versión nueva es **1.0.0** y rompe con 0.x: Socialabs sigue fijado a 0.3.0 hasta integrar.

---

## 7. Condiciones para integrar (ADR 0219 de Socialabs, sin cambios)

1. Alcance completo: ninguna etapa «no disponible todavía» ni pasos manuales ocultos.
2. Pruebas positivas y negativas de punta a punta en entorno aislado: cabeza que cambia, base que
   avanza, corrida cancelada, permisos insuficientes y fallo de la suite.
3. Revisión adversarial de la frontera de seguridad: el PR no controla el código que lo autoriza, la
   firma tiene emisor inequívoco salvo las excepciones aceptadas y declaradas (ADR 0214 para
   `visto-bueno`, R13 para el estado del juez), y el job privilegiado nunca ejecuta código del PR.
4. Una sola puerta pesada por cabeza; esperas, reintentos y fallos acotados.
5. Evidencia real de que otros PRs siguen entrando a la fila con el motor degradado.
6. Plan de apagado probado y una activación que cambia código, documentación y checks juntos.

---

## 8. Casos de aceptación

Cada caso negativo comprueba **motivo, etapa resultante y ausencia de efectos**, y lleva su control
positivo. Las pruebas que tocan GitHub corren en un repositorio real, no simulado.

### 8.1 La receta

- **RC-01** Dada una receta con clave duplicada, ancla, clave desconocida, `after` inexistente, dos
  etapas con el mismo `after` o un ciclo, cuando se valida, entonces se rechaza con archivo, línea y
  motivo y nada corre. *Positivo:* la receta de ejemplo de `init` valida.
- **RC-02** Dada una receta que usa `NO`, `on` o `yes` como valor, cuando se lee, entonces se
  conservan como texto.
- **RC-03** Dado un bloque `run:` que sale con 1, imprime JSON inválido, omite `ok` o excede su
  tiempo, cuando corre, entonces la etapa queda `blocked:technical` con motivo, nunca aprobada.
  *Positivo:* `{ "ok": true }` avanza.
- **RC-04** Dada una etapa cuyo `applies-if` no se cumple, entonces queda `skipped` con motivo y
  `status` lo muestra así. *Positivo:* cuando se cumple, corre.
- **RC-05** Dado `explain` sobre la receta de ejemplo con `locale: es`, entonces lista todas las
  etapas en orden, en español, sin ninguna palabra de la lista prohibida por omisión.
- **RC-06** Dado un PR que modifica `.ai-workflows/pipeline.yml` para quitar una etapa, cuando corre
  el check del servidor, entonces juzga con la receta de la rama predeterminada.
- **RC-07** Dado el mismo proceso declarado en `pipeline.config.ts` de v0.3.0 y en YAML, cuando se
  corren sobre una **tabla literal** de piezas de prueba que cubre los **nueve tipos** vigentes (comportamiento,
  UI con comportamiento, solo visual, configuración de producción, configuración de producción sin
  comportamiento, configuración sin producción, código generado, papeles, prototipo), las
  **elevaciones por ruta** (dinero o permisos elevan a comportamiento; producción eleva visual,
  configuración sin producción y generado) y cada transición (actualización limpia con registro, actualización sin registro,
  conflicto resuelto, commit nuevo, force push con huella idéntica, **reanudación con el mismo
  SHA**), entonces coinciden, etapa por
  etapa, en: aplicabilidad, motivo de `skipped`, evidencia que se conserva o caduca, estado
  terminal y efectos pedidos. La reanudación con el mismo SHA no repite la revisión. Los esperados salen de las reglas de §3.3 y PLAN-997 §5.5, no de
  recalcular con el código.
- **RC-08** Dado un bloque comando declarado `attest` o `execution-record`, o una etapa `pre-merge`
  obligatoria con `server: local-only`, o cero o dos etapas `phase: merge`, entonces `validate` la
  rechaza. *Positivo:* `local-only` en una etapa `post-merge` valida.
- **RC-09** Dado un bloque módulo que abre un PR por `runEffect` y el motor muere antes de recibir
  su respuesta, cuando se reanuda, entonces concilia el efecto `pending` contra GitHub y no abre un
  segundo PR (CN-13 aplicado a bloques). *Positivo:* sin interrupción, abre exactamente uno.
- **RC-10** Dada una pieza cancelada mientras corre un bloque comando que lanzó procesos hijos,
  entonces el motor termina el árbol completo antes de liberar la reserva.

### 8.2 Suite negativa permanente (se conserva de PLAN-997)

CN-01 spec sin benchmark · CN-02 constructor que se revisa a sí mismo · CN-03 revisión de un diff
viejo · CN-04 suite de la zona en rojo · CN-05 cerrar sin visto bueno · CN-06 interrupción durante
escritura · CN-07 escribir código sin pieza activa · CN-08 fusionar desde carpeta libre · CN-09
cruzar fronteras de módulo · CN-10 alcance que crece sin subir de carril · CN-11 constructor que
modifica y restaura una prueba · CN-12 dos controladores sobre la misma pieza · CN-13 morir tras
crear el PR y antes de registrarlo. Cada uno con el control positivo de PLAN-997 §6.2.

### 8.3 El check del servidor y la degradación

- **SV-01** Dado un PR cuya etapa pesada declara `require-check: todo-verde`, cuando corre el juez,
  entonces no ejecuta ninguna suite y exige ese check verde para el SHA juzgado. *Positivo:* con
  `todo-verde` verde en ese SHA, pasa; en otro SHA, no.
- **SV-02** Con la protección real de un repositorio: `off` publica verde «motor apagado» y ningún
  PR queda bloqueado aunque la protección exija el estado; `advisory` publica el veredicto aparte y
  no bloquea; `on` bloquea sin evidencia vigente. Se prueban encender y apagar en ambos órdenes y
  con fallo a mitad del cambio (solo la variable, solo la protección).
- **SV-03** Con la variable en `on`: dado un fallo interno del motor, un proveedor caído o el
  almacén ilegible, cuando llegan un PR de papeles y un PR de otra pieza que no depende del
  componente caído, entonces ambos se juzgan normalmente y entran a la cola, y solo el PR afectado
  queda `blocked:technical` con motivo. Con `off` y `advisory`, ninguno queda bloqueado.
- **SV-04** Dado un workflow ajeno que publica un estado con el mismo nombre, entonces la siguiente
  corrida del juez lo reporta en el PR como estado de origen no oficial (rastro, R13; no se promete
  impedir el merge). Dado un PR que modifica el workflow del juez, `.ai-workflows/` o la versión fijada de la acción,
  entonces el juez de la base lo rechaza sin la atestación del dueño. *Positivo:* con la
  atestación del dueño para ese SHA, pasa.
- **SV-05** Cabeza que cambia, base que avanza, corrida cancelada y permisos insuficientes: cada
  uno termina en el estado de §1.1 con motivo, sin aprobar.
- **SV-06** Dada una pieza válida en todo salvo una etapa `pre-merge` cuya comprobación del
  servidor falla (p. ej. las pruebas nuevas no fallan contra la base), cuando se abre su PR, entonces
  el juez la rechaza nombrando la etapa. *Positivo:* con la comprobación en verde, pasa.
- **SV-09** Dado un PR cuyas pruebas intentan leer variables de entorno, secretos o el token del
  job, cuando corre `ai-workflows/red-test` **en `pull_request` y en `merge_group`**, entonces no encuentran ningún secreto ni token con
  permiso de publicar estados; y el job privilegiado del juez no hace checkout del PR (se comprueba
  en el registro de la corrida). Dado un grupo de la cola con una pieza a la que aplica la prueba
  roja, el check `ai-workflows/red-test` existe sobre el SHA del grupo y el juez lo exige ahí;
  *positivo:* con ese check en verde el grupo se fusiona; sin él, no.
- **SV-08** Dado un diario en `refs/ai-workflows/*` alterado a mano para marcar una etapa como
  hecha sin haberla corrido, entonces el juez no lo toma en cuenta y la rechaza por su comprobación
  propia.
- **SV-07** Con la cola nativa: el juez corre en `merge_group`, publica sobre el SHA del grupo,
  obtiene los PRs de la lista de la cola y exige `todo-verde` del grupo; un verde solo de la cabeza
  del PR no autoriza el grupo. Se prueban ambos recorridos (PR y grupo) y la procedencia del
  código del juez en cada uno.

### 8.4 Ensayo general en la copia de Socialabs

- **EG-01** Antes del primer push de la copia se hace un **inventario** de disparadores (workflows,
  crons, webhooks, integraciones de GitHub como Vercel y Supabase) y de **destinos de red escritos en
  el código** (por ejemplo el origen por omisión de `sintetico-escritorio.yml` y el
  `NEXT_PUBLIC_SITE_URL` de `build-desktop.yml`). Cada uno se desactiva o se apunta a un proyecto de
  prueba identificado. Dada la copia, cuando se revisan secretos, variables, integraciones y
  destinos, entonces no existe ninguna credencial ni destino de producción: una búsqueda de la lista de
  dominios de producción en código y configuración de la copia da cero fuera de `docs/`, y todo
  despliegue, vista previa y base usados en EG-02…EG-05 pertenece a un proyecto de prueba.
- **EG-02** Una pieza pequeña con comportamiento recorre de punta a punta todas las etapas de la
  receta de Socialabs, con vista previa y base de datos de prueba, hasta fusionarse en la copia.
- **EG-03** Una pieza visible se detiene esperando el visto bueno; con el comentario del dueño
  sobre el código corto correcto, avanza.
- **EG-04** Con dos piezas vivas, la que pregunta espera entera y la otra sigue.
- **EG-00** La copia reproduce la protección vigente de `main` de Socialabs al abrir la rebanada 6
  (hoy: cola nativa con `todo-verde` y `candado-cola`, ADR 0225) **más el estado del juez**, que es
  la topología de §5.4; si el plan de GitHub de la
  organización ya no ofrece la cola nativa en repos privados, se reporta antes de seguir.
- **EG-05** Se apaga el motor con el interruptor y un PR ordinario se fusiona con la puerta de
  siempre; se vuelve a encender y el siguiente PR vuelve a exigirlo.
- **EG-06** La receta de Socialabs tiene una tabla que liga cada regla vigente de su `CLAUDE.md`
  que el motor impone con su etapa, y declara las que no impone. Ninguna regla nueva (R10).

### 8.5 Socialabs intacto

- **SI-01** Durante toda la construcción, el historial de `socialabs-margin/Socialabs` no recibe
  commits, ramas ni PRs de esta pieza. Se comprueba al cerrar cada rebanada.

---

## 9. Alcance

**Dentro:** §3 a §8, la receta de ejemplo, la receta de Socialabs (en la copia), la copia de
Socialabs y sus servicios de prueba, la documentación del motor en inglés y `explain` en español.

**Fuera:** las cuatro reglas nuevas (R10) · mutantes (issue aparte de Socialabs) · CEL o cualquier
lenguaje de expresiones · pulido como producto para terceros · presupuesto por pieza · regresión
visual · runners propios · defensa contra un administrador (nivel C) · cualquier cambio en
Socialabs antes de la rebanada 7.

---

## 10. Rebanadas

Una rama y un PR por rebanada en este repositorio. Prueba roja primero en cada cambio de
comportamiento; el orquestador escribe las pruebas rojas y el constructor las pone verdes.

- [ ] **1. Receta:** lector estricto, esquema, `validate`, `explain`, `init`. (RC-01, 02, 04, 05)
- [ ] **2. Bloques:** registro de bloques, manifiestos, bloques módulo y comando, vigencias de §3.3
      y los bloques genéricos de §4.1 portados desde las compuertas existentes. (RC-03, RC-07…RC-10,
      CN-01…CN-04, CN-09…CN-11)
- [ ] **3. El juez:** acción reutilizable y plantilla de workflow, procedencia desde la base,
      `pull_request_target` y `merge_group`, frontera del merge, `server:`, interruptor de dos llaves.
      (RC-06, SV-01…SV-09, CN-05, CN-08)
- [ ] **4. Etapas finales genéricas:** revisión independiente, visto bueno, vista previa, QA de
      navegador, fusión, post-merge, limpieza y mensajes al dueño por plantilla. (CN-06, CN-12, CN-13)
- [ ] **5. Suite negativa completa** en `ai-workflows-pruebas` contra GitHub real, con informe.
- [ ] **6. Ensayo general:** copia de Socialabs sin producción, servicios de prueba, receta de
      Socialabs como copia fiel, bloques propios y EG-01…EG-06. Revisión adversarial de la
      frontera de seguridad. Publicar v1.0.0.
- [ ] **7. Integración (issue nuevo en Socialabs, con aprobación del dueño):** un solo PR que añade
      `.ai-workflows/`, retira lo dormido, deja el juez instalado con `AI_WORKFLOWS_MODE=off` y **sin**
      exigirlo en la protección de `main`, y documenta el apagado.
      Encender es una decisión aparte del dueño.

Rebanadas 1 → 2 → 3 → 4 en orden; 5 puede empezar tras 3; 6 tras 4 y 5; 7 tras 6.

---

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| El YAML no alcanza para expresar una compuerta de Socialabs | Salida de escape `run:` con contrato; RC-07 prueba equivalencia |
| La copia de Socialabs dispara algo contra producción | Sin secretos (EG-01); workflows de producción desactivados antes del primer push |
| El check del servidor vuelve a trabar la fila | Nunca corre suite pesada (SV-01); interruptor sin PR (SV-02); degradación probada (SV-03, EG-05) |
| La prueba de Enterprise de la organización vence y cambia qué ofrece GitHub (cola nativa) | El ensayo general comprueba el plan vigente al momento; si cambia, se reporta antes de integrar |
| Costo de servicios de prueba para la copia | Proyectos gratuitos primero; cualquier gasto nuevo se consulta antes |
| Deriva: Socialabs cambia su proceso mientras se construye | La receta de Socialabs se contrasta con el `CLAUDE.md` vigente al abrir la rebanada 7 |

---

## 12. Pendientes que no bloquean

- Qué proyecto de base de datos de prueba usar (gratuito o del plan Pro), según límites vigentes
  al abrir la rebanada 6.
- Que salieron de la parvada de la rebanada 1 y se resuelven al abrir la rebanada 2, antes de
  construir las vigencias y los tipos:
  - **Vigencia por omisión.** La receta leída deja `valid-while` sin valor si no se escribe; al
    traducirla al motor, «sin valor» no puede significar «nunca caduca» (eso conservaría la puerta
    tras un commit nuevo, contra §1.1). Opciones: hacerlo obligatorio o un valor conservador
    (`same-sha`).
  - **Tipos y carriles con vocabulario cerrado.** Hoy un error de escritura en `kind-any` o
    `lane-any` valida y deja la etapa omitida para siempre. Se cierra junto con RC-07.
  - **Reglas de `validate` diferidas:** exactamente una etapa `phase: merge`, `local-only` solo
    fuera de `pre-merge` obligatoria, bloques comando sin `attest` ni `execution-record` (RC-08);
    QA solo con `same-sha`; toda etapa `pre-merge` con `server:` (rebanada 3); orden de fases y
    `applies-if` sobre la etapa de fusión (a proponer).
  - **`{tests}` en `with.command`:** el bloque debe pasar los archivos como argumentos, nunca
    armados dentro de un texto de consola (§3.4).
  - **Salida saneada en todo el CLI (rebanada 4, mensajes al dueño):** `status`, `validate` y
    `explain` ya no pueden imprimir caracteres de control, de formato ni separadores; `pause`,
    `resume`, `stop` y `doctor` (heredados de v0.3.0) todavía repiten nombres de pieza y motivos
    tal cual. Se cierra con las plantillas de mensajes.
  - **Costo aceptado del saneado:** una receta rechaza emojis compuestos (👩‍💻), banderas con
    etiquetas y el guion suave que deja Word; los acentos, «», —, ¿¡ y los emojis simples pasan.
  - **Propuesta al dueño:** que `explain` muestre las clases y los tipos con un nombre en español
    (hoy dice «toca «security»»). Sería un campo nuevo de la receta; no se añade sin su visto
    bueno.

---

## 13. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura, 22-sep-2026 (versión 1):** REVISE, 7 bloqueantes, todos
aceptados tras comprobarlos en el código:
1. El interruptor no podía apagar un estado exigido → dos llaves coordinadas, `off` publica verde (§5.3, SV-02).
2. `local-only` dejaba una vía de omisión → frontera del merge con `phase`, `local-only` solo post-merge o informativo, `server: journal` (§5.2, RC-08, SV-06).
3. Faltaba la procedencia del juez → base, acción fijada por SHA, correlación de emisor, rechazo de cambios al juez sin atestación; ADR 0214 no se hereda (§5.2, SV-04).
4. Faltaba la cola nativa vigente (ADR 0225) → juez en `merge_group`, SHA del grupo, PRs desde la lista de la cola (§5.2, SV-07, EG-00).
5. El contrato `run:` perdía diario, cancelación y efectos → bloques módulo con `GateContext` completo; bloques comando solo sin efectos (§4.2, RC-09, RC-10).
6. Vigencias sin semántica → tabla cerrada de `valid-while`; RC-07 con carriles y transiciones literales (§3.3, RC-07).
7. Aislar la copia exige más que secretos → inventario de disparadores y destinos escritos en el código (EG-01).

**Ronda 2 — mismo revisor y sesión (versión 2):** REVISE, 6 bloqueantes; 5 aceptados y corregidos, 1 resuelto por el dueño:
1. El estado del juez se puede imitar desde otro workflow → **el dueño acepta el riesgo** (R13); se declara y se deja rastro (§5.2, SV-04).
2. `server: journal` hacía autoridad del diario → eliminado; el juez no lee el almacén, recomputa lo recomputable (prueba roja contra base y cabeza) y lo histórico queda en nivel A (§5.2, SV-06, SV-08).
3. Degradación sin probar en `on` → cada PR se juzga por separado, fallas acotadas, límite de la API de estados declarado (§5.3, SV-03).
4. RC-07 omitía dos tipos y las elevaciones → nueve tipos, elevaciones y `kinds:` declarativo (§3.3, RC-07).
5. Topología decidida tarde → el juez se suma a `todo-verde` y `candado-cola`, ensayada exactamente en EG-00 (§5.4).
6. Vigencia sin el caso del SHA idéntico → añadido, con caso de reanudación (§3.3, RC-07).

**Ronda 3 — mismo revisor y sesión (versión 3):** REVISE, 2 bloqueantes, ambos aceptados:
1. R13 no estaba expresada igual en todas partes → §1.1, R06, §5.2 y §7 nombran el límite aceptado.
2. Recomputar la prueba roja exigía ejecutar código del PR en el juez → job aparte sin privilegios; el juez solo lee su conclusión (§3.3, §5.2, SV-09).

**Ronda 4 — confirmación (versión 4):** R13 ya es consistente. 1 bloqueante aceptado: el job de la prueba roja no cubría `merge_group` → corre también ahí y publica sobre el SHA del grupo (§5.2, SV-09).

**Estado final:** APPROVED en la ronda 5 (sesión de revisión `01a0cb4a-68a4-71a2-b468-234363294a3f`). Revisión de texto, no de implementación.
