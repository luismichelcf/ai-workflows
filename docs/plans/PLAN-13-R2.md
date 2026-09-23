# PLAN-13 · Rebanada 2 — Bloques

Diseño de construcción de la rebanada 2 de [PLAN-13](PLAN-13.md) (issue #13). El plan decide
*qué*; este documento fija *cómo*. Autor: Claude Opus 5.5 (orquestador). Revisor: GPT-6 Sol `high`
(R12). Versión 5 · 22-sep-2026 (corrige los bloqueantes de las rondas 1 a 4, §10). Constructor
de esta rebanada: DeepSeek V4.1 Flash `high` (R17).

## En tres líneas

**Qué pasa hoy:** la receta se lee, se valida y se explica, pero sus etapas nombran bloques que no
existen: nada de lo que dice la receta corre todavía.
**Qué cambia:** existen los bloques (del motor y del proyecto), la receta se traduce a la
configuración del motor con vigencias reales, y las compuertas genéricas de Socialabs quedan
portadas como bloques con sus casos negativos.
**Por qué importa:** es el paso en que la receta deja de ser papel; todo lo que viene (el juez, las
etapas finales, el ensayo) se apoya en estos bloques.

## 0. Alcance

Dentro: R14–R16, reglas de `validate` diferidas (RC-08), registro y manifiestos de bloques, bloques
módulo y comando, hechos del cambio desde git, vigencias de §3.3, traducción receta → motor, y los
bloques `spec-structure`, `benchmark-sources`, `sandboxed-review`, `red-test`, `build-verify`,
`command`, `scope-reconcile`. Casos: RC-03, RC-07…RC-10, CN-01…CN-04, CN-09…CN-11.

Fuera (y dónde va): el juez y `server:` (rebanada 3); los bloques de §4.1 de la rebanada 4
(`independent-review`, `approval-comment`, `preview-deployment`, `browser-qa`, `github-merge`,
`post-merge`, `cleanup`), que en esta rebanada existen solo como **manifiesto** y al correr quedan
`blocked:technical` con «bloque no construido todavía (rebanada 4)»; `required: false` y `retry`
en ejecución (rebanada 4, junto a `post-merge` y `cleanup`, que son quienes los usan); conectar
`run`/`status`/`stop` del binario a la receta y de dónde sale el tipo declarado por la pieza
(rebanada 4, con los mensajes al dueño). Esta rebanada entrega la traducción receta → motor como
función (`compileRecipe`) probada de punta a punta con el almacén en memoria y un repositorio git
real temporal.

## 1. La receta (R14, R15, R16, RC-08)

### 1.1 Vocabulario y nombres

```yaml
kinds:
  names: [behavior, ui-behavior, visual-only, docs]   # R15: vocabulario cerrado
  default: behavior
  from-paths: { docs: ["docs/**"] }
  elevate: [...]
lanes:                                                 # R15: opcional; sale del tipo efectivo
  full: [behavior, ui-behavior]
  light: [visual-only, docs]
labels:                                                # R16: opcional, idioma de `locale`
  security: "permisos y datos"
  behavior: "comportamiento"
```

- `kinds.names` es obligatorio si hay `kinds:`. `default`, las claves de `from-paths`, `elevate[].to`
  y todo `kind-any`/`kind-none` deben estar en `kinds.names`; si no hay `kinds:`, cualquier
  `kind-any`/`kind-none` se rechaza.
- `lanes:` reparte **todos** los tipos de `kinds.names` entre carriles: cada tipo en exactamente
  un carril (falta uno o sobra uno → rechazo). El carril **no se declara**: sale del tipo efectivo
  (§4.2), así que cuando el riesgo sube el tipo, el carril sube con él y no hay forma de conservar
  un carril viejo (CN-10). `lane-any` debe nombrar carriles declarados; sin `lanes:`, `lane-any` se
  rechaza.
- `labels`: cada clave debe ser una clase de `classify`, un tipo o un carril declarado; valor texto
  no vacío, saneado igual que `summary`. `explain` y los motivos de `skipped` usan la etiqueta
  cuando existe y la palabra en inglés cuando no.

### 1.2 Vigencia por omisión (R14)

`constructRecipe` pone `validWhile: 'same-sha'` cuando falta; `RecipeStage.validWhile` deja de ser
opcional. `explain` añade una línea por etapa con la vigencia en palabras llanas («Vale mientras
el código no cambie», «Vale mientras los cambios propios de la pieza sean los mismos», «…o se
actualice limpio con la base», «Vale siempre»).

### 1.3 Reglas de `validate` que entran ahora

1. Exactamente una etapa `phase: merge` (RC-08).
2. Orden de fases: ninguna `pre-merge` después de la `merge`, ninguna `post-merge` antes.
3. `server: local-only` solo en `post-merge` o con `required: false` (RC-08).
4. Un bloque comando (`run:` o bloque con `kind: command`) solo con naturaleza `recompute` o
   `structure` (RC-08).
5. La naturaleza de la etapa debe estar entre las que el manifiesto del bloque permite.
6. `valid-while` debe estar entre los que el manifiesto permite (así «QA solo `same-sha`» es una
   línea del manifiesto de `browser-qa`, y `red-test` exige `forever`, §3.4).
7. `with:` se valida contra las entradas del manifiesto: clave desconocida, tipo equivocado,
   obligatoria ausente o fuera de rango se rechazan con línea y columna.
8. `uses:` de un bloque del motor inexistente o de una versión mayor que no existe se rechaza.

`validate` necesita leer los manifiestos de los bloques del proyecto, así que `parseRecipe` sigue
puro (texto → receta) y se añade `validateRecipeBlocks(recipe, source, readProjectFile)`, que el CLI
`validate`/`explain` llama después de leer. Los errores siguen el formato archivo:línea:columna.

### 1.4 Comandos sin consola (`{tests}`, §12)

Un texto de comando (`with.command`, `run:`) se parte por espacios en argumentos y **nunca** pasa
por una consola. `validate` rechaza comillas, `$`, `` ` ``, `|`, `;`, `&`, `<`, `>`, `(`, `)`,
`*`, `?`, `~` y saltos de línea. `{tests}` solo puede aparecer como argumento completo y se
reemplaza por N argumentos (uno por archivo); `{piece}` se reemplaza dentro de un argumento por el
identificador de la pieza (que ya es `^[A-Za-z0-9._-]+$`). Cualquier otra llave se rechaza.
Límite declarado de v1: ningún argumento puede contener espacios, tampoco en `run:` de un
`block.yml`; quien lo necesite escribe un **bloque módulo** del proyecto, que arma sus argumentos
en código. Así la misma línea se lee igual en Windows y en Linux.

## 2. Bloques

### 2.1 Manifiesto

```ts
interface BlockManifest {
  name: string;                     // 'red-test' | ruta del bloque del proyecto
  kind: 'module' | 'command';
  natures: readonly GateNature[];   // permitidas
  validWhile?: readonly ValidWhile[]; // permitidas; ausente = todas
  inputs: Record<string, InputSpec>;
}
type InputSpec =
  | { type: 'string'; required?: boolean; default?: string; pattern?: string }
  | { type: 'integer'; required?: boolean; default?: number; min: number; max: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'string-list'; required?: boolean; default?: string[] }
  | { type: 'command'; required?: boolean; default?: string }  // texto con reglas de §1.4
  | { type: 'glob-list'; required?: boolean; default?: string[] }
  | { type: 'object'; required?: boolean; fields: Record<string, InputSpec> }
  | { type: 'object-list'; required?: boolean; items: Record<string, InputSpec> };
```

Los bloques del motor viven en `src/blocks/<name>.ts`, cada uno exporta
`{ manifest, create(inputs, deps): Gate }`, y un registro `ENGINE_BLOCKS` los indexa por
`<name>@<major>`. Las entradas llegan al bloque ya validadas y con valores por omisión aplicados,
con claves en camelCase.

### 2.2 Bloques del proyecto

`./.ai-workflows/blocks/<name>/block.yml` (leído con el mismo lector YAML estricto):

```yaml
kind: module            # o command
natures: [recompute]
valid-while: [same-sha]            # opcional
inputs: { min-psa: { type: integer, min: 0, max: 50, default: 5 } }
main: index.mjs                    # kind: module
run: node check.mjs                # kind: command (reglas de §1.4)
timeout-minutes: 10                # kind: command, 1…120, por omisión 10
```

`main` y el primer argumento relativo de `run` deben quedar dentro de la carpeta del bloque (sin
`..`, sin rutas absolutas, sin enlaces que salgan de ella: se resuelve con `realpath` y se compara
el prefijo). Un `block.yml` inválido invalida la receta.

**Bloque módulo:** `import()` del archivo; su exportación por omisión es
`(context: GateContext, inputs) => GateResult | Promise<GateResult>`. Recibe el `GateContext`
completo del motor (`runEffect`, `signal`, `journal`, `mode`). Corre en el mismo proceso que el
motor, con sus privilegios: por eso solo corre junto al agente, nunca en el juez (rebanada 3).

**Bloque comando (RC-03, RC-10):**
- Se lanza sin consola, con `cwd` = raíz del proyecto, entrada estándar = JSON
  `{ piece, sha, base, files, classes, kind, lane, mode, with, journal }` y salida estándar
  limitada a 1 MB.
- La salida estándar completa debe ser **un** objeto JSON con exactamente las claves permitidas
  `ok` (obligatoria: `true` · `false` · `"skipped"`), `reason` (texto, obligatorio si `ok` no es
  `true`) y `evidence` (JSON, opcional).
- El ejecutor de procesos devuelve un resultado **estructurado**, no un `CheckResult`:
  `{ kind: 'exited', code, stdout, stderr, truncated } | { kind: 'technical', reason }`
  (`technical` = no arrancó, tiempo agotado, salida mayor al límite, cancelado). `runGateCommand`
  se reescribe encima de él sin cambiar su comportamiento público.
- Bloque comando: `technical`, salida ≠ 0, JSON inválido o con basura alrededor, clave desconocida,
  `ok` ausente o de otro tipo → el bloque **lanza** un error con el motivo; el motor lo registra
  como `failed` y la pieza queda `blocked:technical`. Nunca aprobado.
- Bloque `command@1` del motor (§3.6): `technical` → lanza (`blocked:technical`); `exited` con
  código ≠ 0 o lectura roja → rechazo ordinario (`blocked:rejected`), porque ahí la suite roja
  es la respuesta, no una avería.
- `{ok:false, reason}` válido → rechazo ordinario (`blocked:rejected`).
- **Cancelación y cierre (RC-10).** Al abortarse `context.signal`, o al terminar normalmente el
  bloque, el ejecutor vacía **todo el grupo** de procesos del bloque y **confirma** que quedó vacío
  antes de devolver, con tope de 10 s. Un único mecanismo por sistema, sin enumerar procesos:
  - *Windows:* el bloque comando se lanza dentro de un **objeto de trabajo** (Job Object) del
    sistema **con nombre único** (`Local\ai-workflows-<uuid>`), por un pequeño lanzador en
    PowerShell que compila con `Add-Type` las llamadas `CreateJobObject`,
    `SetInformationJobObject` (`KILL_ON_JOB_CLOSE`, **sin** `BREAKAWAY_OK`), `CreateProcess` con
    `CREATE_SUSPENDED`, `AssignProcessToJobObject` y `ResumeThread`. El hijo entra al trabajo
    **antes** de ejecutar una sola instrucción, y todo lo que lance después, a cualquier
    profundidad y aunque su padre muera, pertenece al mismo trabajo por regla del sistema. El
    identificador del trabajo no se hereda al hijo. El lanzador hereda al hijo su salida estándar
    y de error, le entrega el JSON de entrada por una tubería propia y recibe órdenes por su
    entrada estándar. Al terminar el hijo, o al recibir `kill`, llama a `TerminateJobObject`,
    espera a que `QueryInformationJobObject` informe **cero procesos activos** y escribe su
    resultado (`{ childExit, treeEmpty }`) en un archivo temporal cuya ruta recibió como
    argumento. No se usa `taskkill` ni ninguna lista de procesos. Si el propio lanzador muere,
    `KILL_ON_JOB_CLOSE` hace que el sistema termine el trabajo entero.
  - *POSIX:* el hijo nace en su propio grupo de procesos (`detached`); se envía `SIGKILL` al grupo
    y se confirma con `kill(-pgid, 0)` → `ESRCH`. Límite declarado: un descendiente que crea **a
    propósito** su propia sesión (`setsid`) sale del grupo; eso es evasión deliberada de código del
    proyecto (nivel A), no un accidente.
- **Salida no confirmada.** Si el vaciado no se confirma (tope vencido, `treeEmpty: false`,
  lanzador sin resultado o sin archivo, grupo POSIX que sigue respondiendo), el ejecutor lanza
  `ProcessTreeSurvived` con una **cuarentena**, que no es una lista de procesos sino la forma de
  volver a preguntar: `{ host, platform: 'win32', job: <nombre> }` o
  `{ host, platform: 'posix', pgid }`, más `confirmed: false`.
- **Cambio del motor.** Hoy una excepción después de la cancelación se trata como cancelación
  antes de registrar `failed`; `ProcessTreeSurvived` es la excepción a esa regla: siempre se
  registra como `failed` y deja la pieza `blocked:technical` con la cuarentena guardada en su
  estado, también cuando llegó por una cancelación. `stop`/`resume` no la levantan.
- **Comprobación independiente antes de cada corrida.** `run` sobre una pieza en cuarentena, venga
  de quien venga y aunque haya vencido el arrendamiento, vuelve a preguntar al sistema y solo
  levanta la cuarentena con una respuesta afirmativa de vacío:
  - Windows: el lanzador en modo `check <nombre>` abre el trabajo por nombre. Si el sistema dice
    que no existe, ya no queda ningún proceso (un trabajo con `KILL_ON_JOB_CLOSE` solo desaparece
    después de terminar todos los suyos). Si existe, lo termina y exige cero procesos activos.
  - POSIX: `kill(-pgid, 0)` → `ESRCH`.
  - Otra máquina (`host` distinto) no puede preguntar: la pieza sigue `blocked:technical` con
    motivo «hay procesos por confirmar en <host>».
  - Cualquier otra respuesta (error, tope, procesos activos) → `blocked:technical` sin correr
    ninguna etapa. Límite aceptado del lado seguro: en POSIX, si el número de grupo lo reutiliza
    otro programa, la cuarentena se mantiene de más (bloquea de más, nunca de menos) y el motivo
    lo dice.
- La reserva se libera como siempre: lo que impide otra corrida es la cuarentena guardada, no el
  arrendamiento.
- `mode: dry-run`: el bloque comando no se lanza; la etapa se registra como no ensayable
  (comportamiento actual del motor para `dry-run`).

### 2.3 Lo que el motor valida según la naturaleza (§4.2)

El envoltorio que traduce cada etapa (§5) guarda la evidencia del bloque como
`{ judged: { sha, snapshot, fingerprint }, block: <evidencia del bloque> }`. `judged` lo pone el
motor desde los hechos del cambio (§4.1), nunca el bloque: un bloque no puede declarar qué juzgó.

**Instantánea antes y después.** El motor calcula los hechos del cambio una vez por corrida. El
envoltorio recalcula `sha` y `snapshot` (§4.1) inmediatamente antes y después del bloque, y ambas
lecturas deben ser iguales a las de los hechos de la corrida. Si difieren (el árbol cambió entre
etapas o mientras la etapa corría), el resultado no vale: el envoltorio lanza «el árbol de trabajo
cambió mientras corría la etapa» y la pieza queda `blocked:technical`; la siguiente corrida parte
de hechos nuevos. Así nunca se sella con una instantánea evidencia producida sobre otra.

Un bloque `execution-record` lee el diario (`context.journal`), nunca su propia salida anterior.

## 3. Los bloques del motor de esta rebanada

Todos devuelven motivos en el idioma de `locale` (es/en) y ninguno contiene nada propio de
Socialabs: rutas, títulos y umbrales llegan por `with:`.

### 3.1 `spec-structure@1` — structure
Entradas: `file` (texto con `{piece}`, obligatorio), `sections` (lista, secciones que deben existir
con contenido, vía `requireSections`), `summary` (objeto opcional `{section, labels[]}`: la sección
debe mencionar cada etiqueta, comparación sin acentos ni mayúsculas), `criteria` (objeto opcional
`{section, id-prefix, words[]}`: al menos un criterio `<prefix>\d{2}` y cada uno contiene cada
palabra), `decisions` (objeto opcional `{section, pending-markers[]}`: ninguna línea de la sección
contiene un marcador; por omisión `["[ ]", "pendiente", "por decidir", "TBD"]`).
Rechazo: archivo ausente; lista completa de faltantes en un solo motivo. Evidencia: `{ file,
sha256 }`.

### 3.2 `benchmark-sources@1` — structure (CN-01)
Entradas: `files` (glob con `{piece}`, obligatorio), `categories` (lista de `{heading, min}`: los
enlaces bajo un título de nivel 1–2 que contiene `heading` cuentan para esa categoría; se asigna a
la primera que coincide en el orden escrito), `min-total` (entero, por omisión 0),
`sections` (lista opcional, p. ej. evidencia/inferencia/ausencia), `waiver` (texto opcional: si el
archivo del spec contiene una línea `<waiver> — <motivo>` con motivo no vacío, el bloque devuelve
`skipped` con ese motivo), `spec` (texto con `{piece}`, requerido si hay `waiver`),
`check-reachable` (booleano, por omisión `false`: si es `true`, cada dominio contado debe
responder a `HEAD` o `GET` con estado < 400 en 10 s; sin red → `blocked:technical`, nunca
aprobado). Cuenta dominios con `countDistinctSources`. Primer archivo que cumple, gana.
Evidencia: `{ file, counts: {<heading>: n} }`.

### 3.3 `sandboxed-review@1` — recompute + attest (CN-02, CN-03)
El veredicto **lo produce el motor**, no se recibe: el bloque corre al revisor y observa él mismo
todo lo que luego exige.
- Entradas: `reviewer` (objeto `{provider, model, effort}`), `prompt` (ruta de un archivo del
  proyecto, con `{piece}`), `angle` (texto), `forbid-same-family` (booleano, por omisión `true`),
  `timeout-minutes`.
- Exige árbol limpio (`clean`): se revisan versiones guardadas, no cambios sueltos.
- Corre al revisor con `buildInvocation` en modo de solo lectura, sin consola, con la huella del
  árbol de trabajo (sha256 de rutas y contenidos, sin `.git` ni `node_modules`) tomada **por el
  bloque** antes y después. Árbol distinto → rechazo «la revisión modificó el árbol de trabajo»,
  aunque el revisor diga que aprueba.
- La identidad del revisor sale de `parseRun` sobre la salida real del proveedor (sesión y modelo
  confirmados), nunca de lo que el revisor escriba en su texto. El veredicto se lee de una línea
  exacta `VERDICT:APPROVED` o `VERDICT:REVISE`; ninguna o las dos → `blocked:technical`.
  `VERDICT:REVISE` → rechazo con el texto del revisor.
- **Constructor (CN-02):** la identidad del constructor es un dato **declarado** por la pieza
  (`change.builder`, como el tipo). Sin ella → rechazo («no se sabe quién construyó»). Se rechaza
  si el revisor observado es la misma ejecución que el constructor declarado
  (`requireDifferentBuilder`, también con otra etiqueta de modelo en la misma sesión) o, con
  `forbid-same-family`, de la misma familia. Límite declarado (nivel A): si la pieza miente sobre
  quién construyó, el motor no puede saberlo; `explain` lo dice.
- **Versión revisada (CN-03):** el veredicto queda sellado con el `sha` observado; la etapa usa
  `same-sha` o `same-fingerprint-or-clean-update` (el manifiesto no admite `forever`), así que una
  revisión de A no vale para B, salvo que B sea una actualización limpia registrada y verificada
  de A (§6).
- Evidencia: `{ reviewer: {provider, model, session}, sha, angle, approved: true, workspace }`.
- Publicar el veredicto como evento autenticado en GitHub (la parte `attest`) llega en la
  rebanada 4 con `independent-review`; aquí queda en el diario.
- Pruebas: el proveedor es un borde externo; se sustituye por un ejecutable falso (script de Node)
  que imprime la salida grabada de un proveedor real, con variantes que escriben un archivo, que
  dicen en su texto ser otra sesión o que no emiten veredicto.
La familia se deduce del proveedor (`anthropic`/`claude` → anthropic, `openai`/`codex` → openai,
`google`/`gemini` → google, `deepseek`, y si no, el prefijo antes de `/` del modelo).

### 3.4 `red-test@1` — recompute + execution-record
Manifiesto: `validWhile: ['forever']` (es un registro histórico: con `same-sha` la prueba se
volvería a correr tras la implementación y ya no fallaría). Entradas: `command` (obligatoria, debe
contener `{tests}`), `tests` (glob, por omisión `["**/*.test.ts", "**/*.test.tsx"]`),
`timeout-minutes` (1…120, por omisión 30). Corre el comando con los archivos de prueba del cambio;
exige `isRedEvidence(parseTestRun(run))` (fallo de aserción, no de importación ni de entorno).
Sin archivos de prueba → rechazo. El motivo distingue «la prueba pasó (no está roja)», «falló
por importación o entorno, no por su aserción» y «no se pudo correr» (este último es técnico).
Evidencia: `{ files: {ruta: sha256}, failures, assertions }`.
Lector: el de Vitest (`parseTestRun`); se declara así en el manifiesto.

### 3.5 `build-verify@1` — recompute + execution-record (CN-11)
Manifiesto: `validWhile: ['same-sha']`. Entradas: `command` (con `{tests}`), `tests` (glob),
`red-stage` (id de la etapa roja, obligatoria; `validate` exige que exista, sea anterior y use
`red-test`), `implementation-exclude` (glob, por omisión `["docs/**"]`), `timeout-minutes`.
En orden:
1. Última entrada `passed` de `red-stage` en el diario con `files`, `failures` y `assertions` no
   vacíos; si no, rechazo.
2. `requireSameFiles(registradas, actuales)` sobre los archivos de prueba (CN-11).
3. **Pruebas intactas en la historia:** `git log --format=%H <sha de la roja>..HEAD -- <pruebas>`
   debe estar vacío; un commit que modificó y luego restauró una prueba se detecta aquí aunque el
   contenido final sea idéntico. Esto es lo que el plan llama «sin commits del constructor sobre
   las pruebas». Límite declarado: modificar y restaurar en el árbol de trabajo sin commit no se
   detecta (nivel A, igual que hoy).
4. Corrida en verde (`isGreenRun`).
5. Retirada **desde la misma instantánea**: se crea un commit temporal sin rama con
   `git commit-tree <snapshot> -p HEAD` (el árbol exacto de la corrida verde, con lo no guardado
   y lo nuevo) y `git worktree add --detach` sobre él en carpeta temporal; allí cada archivo de
   implementación (tocados − pruebas − `implementation-exclude`) se restaura desde la base de
   fusión o se borra si es nuevo; se enlaza `node_modules`; la misma corrida debe dar
   `isRedEvidence` con al menos un fallo y una aserción iguales a los de la roja. Sin archivos de
   implementación → rechazo. La carpeta temporal se retira siempre (`worktree remove --force` +
   `prune`), también si falla. La corrida verde del paso 4 y la retirada usan la misma
   `snapshot`, comprobada por el envoltorio antes y después (§2.3).
Evidencia: `{ retired: [...] }`.

### 3.6 `command@1` — recompute (CN-04, CN-09)
Entradas: `command` (obligatoria), `timeout-minutes` (1…120, por omisión 30), `reader` (`exit-code`
por omisión · `vitest`: además exige `isGreenRun`, así una suite en rojo que sale con 0 no pasa).
La suite de una zona (CN-04) y las fronteras de módulos (CN-09) se expresan como etapas `command`
con `applies-if` sobre las clases de la receta; el motor no conoce zonas ni reglas de fronteras.

### 3.7 `scope-reconcile@1` — recompute (CN-10)
Recalcula el tipo efectivo desde los archivos realmente tocados (§4.2) y lo compara con el tipo
declarado. Si subió, pasa y deja evidencia `{ declared, effective, raisedBy: [<regla de elevate o
from-paths>] }`, y el motivo que lee el dueño lo dice. Si el tipo declarado no está en el
vocabulario, rechazo. El efecto de subir el carril lo produce el motor: `applies-if` se evalúa con
el tipo efectivo y se reevalúa en cada corrida, así que una etapa antes omitida corre (CN-10).

### 3.8 Manifiestos de la rebanada 4
`independent-review`, `approval-comment`, `preview-deployment`, `browser-qa` (`validWhile:
['same-sha']`), `github-merge`, `post-merge`, `cleanup`: manifiesto completo (naturalezas,
vigencias, entradas) para que la receta de ejemplo valide; su `create` lanza «bloque no construido
todavía (rebanada 4)».

## 4. Hechos del cambio

### 4.1 Desde git
`describeChangeFromGit({ root, baseRef, recipe, declared })` devuelve
`{ piece, sha, snapshot, base, mergeBase, files, fingerprint, classes, declaredKind, kind, lane,
clean, builder? }`:
- `sha`: `git rev-parse HEAD` (40 hex). `base`: `git rev-parse <baseRef>`. `mergeBase`: `git
  merge-base`.
- `files`: unión ordenada y sin duplicados de `git diff --name-only -z --no-renames
  <mergeBase>..HEAD`, `git diff --name-only -z --no-renames HEAD` y `git ls-files --others
  --exclude-standard -z`.
- `snapshot`: el id de árbol del **estado de trabajo completo** (HEAD + cambios sin guardar +
  archivos nuevos no ignorados), calculado con un índice temporal (`GIT_INDEX_FILE` en carpeta
  temporal, `git read-tree HEAD`, `git add -A`, `git write-tree`) sin tocar el índice real. Con el
  árbol limpio es el árbol de `sha`.
- `fingerprint`: sha256 de los **bytes** de `git diff --no-renames --no-color --no-ext-diff
  --no-textconv --full-index --binary --src-prefix=a/ --dst-prefix=b/ -U3 <mergeBase> <snapshot>`,
  es decir, de **todo** lo que se juzga, incluida la parte sin guardar, con posición de cada
  cambio. No se usa `git patch-id`: ignora la posición de los fragmentos y da la misma huella a
  una misma sustitución hecha en otro lugar (hallazgo de la ronda 2). Vacío si no hay diff (y
  entonces `same-fingerprint` no puede conservar nada). Consecuencia aceptada: una actualización
  con la base que desplaza líneas cambia la huella y caduca `same-fingerprint` (conservador); la
  vigencia que sobrevive a actualizaciones es `same-fingerprint-or-clean-update`.
- `clean`: `snapshot` es igual al árbol de `sha`.
- `declared` (`{kind?, builder?}`) llega como parámetro; de dónde lo toma el CLI es rebanada 4. El
  carril no se declara (§1.1). `builder` es `{provider, model, session}`.
Todo por `execFile` sin consola, con tope de tiempo; un fallo lanza (la etapa queda
`blocked:technical`), nunca devuelve hechos a medias.

### 4.2 Tipo efectivo (puro)
`effectiveKind(recipe, declared, files)`: (1) si todos los archivos caen en una clave de
`from-paths`, ese tipo, sin importar lo declarado; (2) si no, el declarado, o `kinds.default` si no
hay; (3) se aplican las reglas de `elevate` en orden, cada una sobre el resultado de la anterior,
con `when` evaluado sobre las clases tocadas y el tipo en curso; (4) el carril es el de `lanes:`
que contiene el tipo resultante. Devuelve también qué reglas actuaron. Un tipo declarado fuera del
vocabulario lanza.

## 5. De la receta al motor

`compileRecipe(recipe, deps) → { config: PipelineConfig, describeChange, confirmFacts }`, con
`deps = { root, baseRef, declared, store, projectBlocks, providers?, now? }`. `store` es el mismo
almacén que usa el motor: el envoltorio lo necesita para `reconcileEffect` y `recordCleanUpdate`,
y ningún bloque del proyecto lo recibe.
- `name` = `id`, `summary`, `after`, `nature`, `needsHuman` tal cual.
- `appliesWhen` = `appliesIfFor(recipe, id)` (ya existe) sobre los hechos de §4 con tipo efectivo.
- `gate` = el bloque creado con sus entradas, envuelto para sellar `judged` (§2.3).
- `stillValid` = la vigencia de §6.
- **Conciliación de efectos (RC-09):** un bloque módulo puede exportar además
  `reconcile(operationId, context) → { confirmed: JsonValue } | { didNotHappen: true } |
  undefined`. Cuando el bloque recibe `EffectNeedsReconciliation`, el envoltorio llama a
  `reconcile` para esa operación: con respuesta, llama a `store.reconcileEffect` y vuelve a correr
  el bloque una sola vez (el efecto confirmado devuelve su resultado sin repetirse); con
  `undefined` o sin `reconcile`, la etapa queda `blocked:technical` diciendo qué efecto está en
  duda. Nunca se reintenta a ciegas.
- Sin `retry` ni `required: false` en ejecución todavía: `compileRecipe` los rechaza con un error
  claro («no disponible hasta la rebanada 4») en vez de ignorarlos en silencio.

## 6. Vigencias (§3.3 del plan, RC-07)

`stillValid(entry, context)` con los hechos actuales:
- `same-sha`: `judged.sha === change.sha` **y** `judged.snapshot === change.snapshot`, todos
  presentes y bien formados; si falta alguno, `false`. Con cambios sin guardar distintos y el mismo
  `HEAD`, la evidencia caduca.
- `same-fingerprint`: huellas iguales y no vacías (la huella cubre también lo no guardado, §4.1); si
  falta alguna, `false`.
- `forever`: `true`.
- `same-fingerprint-or-clean-update`: `true` si `sha` y `snapshot` son los mismos. Si no, exige
  árbol limpio ahora **y** que la instantánea juzgada fuera el árbol de `judged.sha` (lo juzgado
  estaba guardado), y es `true` solo si existe una
  cadena `judged.sha = S0 → S1 → … → Sn = change.sha` en la que cada paso tiene **(a)** un
  registro en el diario escrito por el motor (entrada reservada `@clean-update` con
  `{ from, to, base }`) y **(b)** forma verificable en git: `to` es un commit de fusión con padres
  exactamente `[from, p2]`, `p2` es ancestro de `baseRef`, y **la fusión de tres vías de `from` con
  `p2`, recalculada por el motor con `git merge-tree --write-tree --merge-base=<base de fusión de
  from y p2> from p2`, termina sin conflicto y produce exactamente el árbol de `to`**. Así una
  fusión limpia en la que la pieza y la base editaron líneas distintas del mismo archivo conserva
  la revisión, y cualquier edición a mano durante la fusión (conflicto resuelto o cambio colado)
  la caduca. Commit nuevo de la pieza, force push (el SHA juzgado no es el primer padre) o paso sin
  registro → `false`. Requiere git 2.38 o más; `doctor` lo comprueba y, con un git más viejo, esta
  vigencia caduca siempre (nunca conserva sin verificar).
- El diario acepta entradas cuyo `stage` empieza con `@` como registros del motor: no son etapas y
  no bloquean la reanudación por «etapa desconocida».
- **Quién escribe `@clean-update`:** solo código del motor. `recordCleanUpdate` **no** está en
  `GateContext` (que reciben los bloques del proyecto): es una dependencia privilegiada que solo
  reciben los bloques del motor al crearse (`create(inputs, deps)`), y la usará `github-merge` en
  la rebanada 4. Antes de escribir, `recordCleanUpdate` verifica en git la forma del paso (b) y
  rechaza si no la cumple; `stillValid` la vuelve a verificar al leer, así que un registro escrito
  a mano en el almacén tampoco basta.
- Un bloque del proyecto no tiene con qué escribir un registro `@…`. La prueba lo intenta desde un
  bloque módulo que busca el método en su contexto, y con una entrada `@clean-update` inyectada en
  el almacén sin forma válida en git: en ambos casos la revisión caduca.

**Reanudación con el mismo SHA:** una entrada `passed` con `judged.sha` **y** `judged.snapshot`
iguales a los actuales se conserva con cualquier vigencia, así que no se repite ni la revisión ni
ningún efecto. Mismo `sha` con otra `snapshot` (cambios sin guardar) no es «el mismo SHA» para
ninguna vigencia salvo `forever` y `same-fingerprint` con huella idéntica.

**Comprobación final.** Antes de dejar una pieza en `done`, el motor vuelve a calcular `sha` y
`snapshot` y los compara con los hechos de la corrida; si difieren, la pieza queda
`blocked:technical` («el árbol cambió durante la corrida») en vez de `done`. Se implementa como
opción nueva del motor `confirmFacts?: (change) => Promise<string | undefined>` (motivo si ya no
valen), que `compileRecipe` entrega junto a la configuración.

## 7. Casos y pruebas

Cada caso: motivo, estado resultante y ausencia de efectos, con su control positivo.

| Caso | Prueba |
|---|---|
| RC-03 | Bloque comando real (script de Node) que sale con 1, imprime JSON inválido, basura alrededor del JSON, omite `ok`, añade una clave, excede el tiempo, supera 1 MB o no existe → `blocked:technical` con motivo. `{ok:false, reason}` → `blocked:rejected`. Positivo: `{ "ok": true }` avanza. |
| RC-07 | Tabla literal (esperados escritos a mano, sin llamar a `compileRecipe` ni a las reglas para calcularlos): un proceso escrito como `PipelineConfig` a mano (estilo v0.3.0) y el mismo en YAML, corridos por el motor sobre los nueve tipos, las elevaciones y las seis transiciones (actualización limpia con registro, sin registro, conflicto resuelto, commit nuevo, force push con huella idéntica, reanudación con el mismo SHA) en un repositorio git real temporal. Coinciden etapa por etapa en aplicabilidad, motivo de `skipped`, evidencia conservada o caducada, estado terminal y efectos pedidos. Esperados escritos a mano desde §3.3. |
| RC-08 y §1.3 | Un negativo con línea y columna y un positivo por **cada** regla de §1.3 (1–8): cero y dos `merge`; `pre-merge` tras la `merge` y `post-merge` antes; `local-only` en `pre-merge` obligatoria (positivo en `post-merge` y con `required: false`); `run:` y bloque comando del proyecto con `attest` y con `execution-record`; naturaleza fuera del manifiesto; vigencia fuera del manifiesto (`red-test` sin `forever`); `with:` con clave desconocida, tipo equivocado, obligatoria ausente y fuera de rango; bloque del motor inexistente y versión mayor inexistente; `block.yml` inválido y con `main` fuera de su carpeta. R15: tipo o carril fuera del vocabulario en cada lugar, tipo sin carril y tipo en dos carriles. R16: etiqueta de un nombre no declarado. R14: etapa sin `valid-while` se lee `same-sha`. §1.4: cada carácter prohibido y `{tests}` dentro de un argumento. |
| RC-09 | Dos variantes del mismo recorrido. **Local (en la CI):** bloque módulo cuyo efecto crea una rama en un repositorio git remoto real (carpeta *bare* local) por `runEffect`, con `reconcile` que la busca allí. **GitHub (en esta rebanada, contra `socialabs-margin/ai-workflows-pruebas`):** el efecto abre un PR real con `gh` y `reconcile` lo busca por su rama. En ambas: el motor muere tras el efecto y antes de registrarlo; al reanudar concilia y no crea un segundo (se cuentan ramas o PRs); sin `reconcile` → `blocked:technical` nombrando el efecto; positivo sin interrupción: exactamente uno. La variante GitHub necesita credenciales, así que no corre en la CI de un repositorio público: es un archivo de prueba aparte que solo corre con `AI_WORKFLOWS_GITHUB_TEST_REPO` definido y **falla** (no se salta) si se pide sin credenciales; el orquestador la corre antes de fusionar, cierra el PR y borra la rama que crea, y pega la salida en el PR como evidencia. |
| RC-10 | Bloque comando que lanza un hijo que lanza un nieto y muere **de inmediato** (nieto huérfano en milisegundos, sin ventana para observarlo), y el nieto escribe un archivo cada 50 ms; se cancela la pieza; tras volver `run`, el archivo deja de crecer. También: un bloque que termina bien pero deja un nieto vivo → el nieto muere al cerrar la etapa. Negativos: (a) con un terminador inyectado que no logra vaciar el grupo, la pieza queda `blocked:technical` en cuarentena; **después de vencer el arrendamiento**, otro controlador intenta `run` y recibe `blocked:technical` sin que corra ninguna etapa; vaciado el grupo, la siguiente corrida sigue. (b) Se pierde el resultado del lanzador (se borra su archivo) **con un nieto todavía activo**: cuarentena sin confirmar; la comprobación independiente encuentra el grupo con procesos y la mantiene. (c) Igual **sin** nieto activo: la comprobación independiente confirma el vacío y la corrida sigue. (d) Cuarentena de otra máquina: sigue bloqueada. En Linux y Windows (la CI corre ambos). |
| CN-01 | `benchmark-sources` sin archivo, con un solo proveedor, con categoría corta; positivo con fuentes suficientes; `waiver` con motivo → `skipped`. |
| CN-02 | `sandboxed-review` con un revisor falso cuya sesión observada es la del constructor declarado, con otra etiqueta de modelo en esa sesión, y de la misma familia; un revisor que **escribe** en su texto que es otra sesión no engaña (se usa la observada); sin constructor declarado → rechazo. Positivo: otra familia. |
| CN-03 | Revisión aprobada en A; nuevo commit B; la etapa vuelve a correr y la evidencia de A no cuenta. Revisor que modifica un archivo → rechazo aunque diga `VERDICT:APPROVED`. Árbol con cambios sin guardar → rechazo. Positivo tras revisar B. |
| CN-04 | `command` con `reader: vitest` y una salida roja que sale con 0; positivo en verde. |
| CN-09 | `command` que corre un chequeo de fronteras del proyecto de prueba que falla; positivo sin violaciones. |
| CN-10 | La pieza crece hacia `security`: el tipo y el carril suben, `scope-reconcile` registra la subida y una etapa con `lane-any` antes omitida corre. Positivo: sin crecer, nada cambia. |
| CN-11 | `build-verify` con la prueba editada (motivo con el archivo), y con un commit que la modificó y otro que la restauró (motivo con el commit); retirada con implementación **sin guardar** y archivo **nuevo**: se retira desde la instantánea y reproduce la roja; positivo sin tocar la prueba. El límite del árbol sin commit queda declarado en la suite. |
| Instantánea | Etapa `same-sha` aprobada; se cambia un archivo sin guardar con el mismo `HEAD` → caduca, también al reanudar. Un bloque que modifica el árbol mientras corre → `blocked:technical`. Todas las etapas resueltas por evidencia y el árbol cambia antes del final → `blocked:technical`, nunca `done`. `same-fingerprint` con un cambio sin guardar → caduca. `same-fingerprint` con la misma sustitución trasladada a otro lugar de un archivo con contexto repetido → caduca. |
| Actualización limpia | Positivo: la pieza y la base editan líneas distintas del **mismo archivo**, fusión sin conflicto registrada → la revisión se conserva. Negativos: fusión con conflicto resuelto a mano, fusión limpia con un cambio extra colado en el commit de fusión, fusión sin registro, registro sin forma válida, `from` que no es el primer padre (force push). |
| `@clean-update` | Bloque módulo que busca `recordCleanUpdate` en su contexto no lo encuentra; entrada `@clean-update` inyectada sin forma válida en git no conserva la revisión; `recordCleanUpdate` con una fusión que resolvió un conflicto a mano se rechaza. |

`NOT_YET_EXECUTABLE` de `tests/negative-cases.test.ts` pierde CN-09.

## 8. Orden de construcción

Una prueba roja por cambio, el constructor la pone verde, el orquestador verifica y commitea:

1. Receta: vocabulario, etiquetas, vigencia por omisión, reglas de §1.3 sin manifiestos, comandos
   sin consola (§1.4), `explain` con etiquetas y vigencia.
2. Manifiestos, registro, validación de `with:` y bloques del proyecto (`block.yml`).
3. Hechos del cambio desde git y tipo efectivo.
4. Vigencias y `compileRecipe` (con un bloque de prueba), RC-07.
5. Bloque comando (RC-03, RC-10) y bloque módulo (RC-09).
6. `command`, `spec-structure`, `benchmark-sources` (CN-01, CN-04, CN-09).
7. `red-test`, `build-verify` (CN-11).
8. `sandboxed-review` (CN-02, CN-03) y `scope-reconcile` (CN-10).
9. Plantilla de `init` actualizada (vocabulario, `red-test` con `forever`), documentación del motor
   en inglés para bloques, §12 del plan al día.

## 9. Decisiones del orquestador en esta rebanada

- `red-test` exige `valid-while: forever` en su manifiesto: con la vigencia por omisión (R14) la
  prueba roja se volvería a correr después de construir y ya no podría fallar.
- «Sin commits del constructor» se implementa como «ningún commit toca las pruebas después de la
  roja» (§3.5), que es lo que protege; quién hizo cada commit no es verificable de forma genérica.
- El registro de actualización limpia va en el diario como entrada reservada `@…`, escrita solo por
  el motor.
- `required: false`, `retry` y el cableado del binario pasan a la rebanada 4 y `compileRecipe`
  los rechaza explícitamente mientras tanto.
- El orden de fases (§1.3 regla 2) entra ahora: una receta con `post-merge` antes de la fusión no
  tiene lectura posible.
- El carril sale del tipo efectivo por `lanes:` y no se declara (§1.1), para que no pueda quedarse
  atrás cuando el riesgo sube.
- La identidad del constructor es declarada (nivel A); la del revisor, observada por el motor.

## 10. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura (sesión `01a0cc4b-e375-7110-bb3b-f7b660a60a4f`):**
REVISE, 9 bloqueantes, todos aceptados:
1. El carril no subía con el riesgo → sale del tipo efectivo por `lanes:` (§1.1, §4.2, CN-10).
2. Evidencia sellada con `HEAD` aunque se juzgaran cambios sin guardar → `snapshot` sellada y
   comprobada antes y después de cada etapa; `same-sha` la compara (§2.3, §4.1, §6).
3. La huella ignoraba lo no guardado → `patch-id` sobre `mergeBase..snapshot` (§4.1).
4. La retirada partía de `HEAD` → commit temporal desde la instantánea (§3.5).
5. Veredictos recibidos, no observados → el bloque corre al revisor y observa identidad, árbol y
   veredicto (§3.3).
6. Reserva liberada con procesos vivos → confirmación de salida; si falla, `blocked:technical` y
   la reserva sigue tomada (§2.2).
7. `recordCleanUpdate` al alcance de cualquier bloque → solo dependencia privilegiada de bloques
   del motor, con verificación en git al escribir y al leer (§6).
8. RC-03 y RC-09 sin recorrido → ejecutor estructurado y `reconcile` del bloque módulo, probado
   contra un remoto git real (§2.2, §5, §7).
9. Manifiesto y pruebas de `validate` incompletos → tipo `object` y un negativo y un positivo por
   regla (§2.1, §7).

No bloqueantes aplicados: argumentos con espacios (§1.4), motivos distintos en `red-test` (§3.4),
esperados literales en RC-07 (§7).

**Ronda 2 — misma sesión (versión 2):** REVISE, 5 bloqueantes, todos aceptados:
1. La reanudación conservaba evidencia con el mismo SHA aunque cambiara lo no guardado → exige
   también la instantánea, y comprobación final antes de `done` (§6).
2. La reserva se libera siempre en el motor y el arrendamiento vence → cuarentena guardada con los
   sobrevivientes, comprobada en cada `run`; seguimiento de descendientes en Windows (§2.2, RC-10).
3. `git patch-id` ignora la posición de los cambios → sha256 de los bytes del diff (§4.1).
4. La comprobación por archivo caducaba fusiones limpias en el mismo archivo → fusión de tres vías
   recalculada con `git merge-tree` (§6, casos nuevos en §7).
5. RC-09 sin almacén ni GitHub real → `store` en las dependencias de `compileRecipe` y variante
   contra el repositorio de pruebas en esta rebanada (§5, §7).

No bloqueantes aplicados: argumentos con espacios por bloque módulo (§1.4); ejemplo de §3.3 del
plan con `kinds.names` y `lanes:`.

**Ronda 3 — misma sesión (versión 3):** REVISE, 1 bloqueante, aceptado: en Windows, el sondeo de
la tabla de procesos dejaba una ventana para un nieto huérfano, y el motor trataba la excepción
tras cancelar como cancelación → objeto de trabajo del sistema, sin sondeo ni salida posible, y
`ProcessTreeSurvived` siempre registra `failed` con cuarentena (§2.2, RC-10). No bloqueantes
aplicados: la excepción de la actualización limpia nombrada en §3.3; el ejemplo de §3.3 del plan
aclara que es parcial.

**Ronda 4 — misma sesión (versión 4):** REVISE, 2 bloqueantes, aceptados: (1) quedaba la vía vieja
de enumeración y `taskkill` junto al objeto de trabajo → retirada; el objeto de trabajo con nombre
es el único mecanismo en Windows. (2) La cuarentena podía levantarse con una lista vacía de
sobrevivientes sin confirmación → la cuarentena guarda cómo volver a preguntar (nombre del trabajo o
grupo, y máquina) y solo se levanta con una respuesta afirmativa de vacío; RC-10 prueba la pérdida
del resultado del lanzador con y sin nieto activo (§2.2, §7).

**Ronda 5 — misma sesión (versión 5):** **APPROVED**, sin bloqueantes. Aprobación del diseño; la
implementación y sus pruebas se verifican aparte (puerta del orquestador y parvada).

## 11. Desviaciones durante la construcción

Decididas por el orquestador al verificar cada parte; ninguna cambia lo que decidió el dueño.

- **`check-reachable` (§3.2):** una fuente que no responde es un **rechazo** que la nombra, no un
  bloqueo técnico, y si la página exacta no responde se intenta la raíz de su dominio (un
  proveedor real puede mover sus páginas). La prueba usa dominios `.invalid`, que nunca
  resuelven, para no depender de internet.
- **Cierre del grupo de procesos (§2.2):** si `terminate()` no confirma el vacío, el bloque
  comando vuelve a preguntar al sistema (`checkQuarantine`) antes de declarar la cuarentena; una
  respuesta afirmativa de vacío es la confirmación que §2.2 exige. En Windows la comprobación
  solo consulta el objeto de trabajo: el sistema no permite terminar el de otro proceso, y un
  trabajo que ya no existe se da por vacío porque `KILL_ON_JOB_CLOSE` solo lo deja desaparecer
  tras terminar todos sus procesos.
- **Bloque módulo (§2.2):** recibe un tercer argumento `project = { root }` (también
  `reconcile`). Corre dentro del proceso del motor y, sin la carpeta del proyecto, sus órdenes
  actuaban sobre la carpeta del motor: así la primera prueba contra GitHub subió por error dos
  ramas al repositorio del motor (borradas el mismo día; solo contenían el código de esta rama y
  no dispararon trabajos ni solicitudes de cambio).
- **`reader: vitest` de `command@1` (§3.6):** el rechazo lleva, además de los fallos, las
  últimas 20 líneas de la salida, porque `parseTestRun` recorta la ruta del archivo en los
  nombres de los fallos.
- **Pruebas:** las que manejan git y procesos reales tienen tope de 30 s y el borrado de
  carpetas temporales reintenta en Windows; RC-09 contra GitHub vive en `tests/github/` y corre
  con `pnpm test:github` (evidencia en el PR).
