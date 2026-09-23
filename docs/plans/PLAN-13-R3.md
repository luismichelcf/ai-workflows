# PLAN-13 · Rebanada 3 — El juez

Diseño de construcción de la rebanada 3 de [PLAN-13](PLAN-13.md) (issue #13). El plan decide
*qué*; este documento fija *cómo*. Autor: Claude Opus 5.5 (orquestador). Revisor: GPT-6 Sol `high`
(R12). Versión 6 · 23-sep-2026 · **Aprobado** por GPT-6 Sol `high` en 6 rondas (§10). Constructor: DeepSeek V4.1 Flash `high` (R17).

## En tres líneas

**Qué pasa hoy:** el motor guía y frena cada etapa junto al agente, pero en GitHub nada lo repite:
un PR abierto desde la web o fusionado desde otra máquina no pasa por ninguna etapa.
**Qué cambia:** un check en GitHub, «el juez», vuelve a comprobar cada etapa antes de fusionar con
el código y la receta de la rama principal, en el PR y en la cola, con un interruptor de dos llaves.
**Por qué importa:** es la capa obligatoria del nivel B; sin ella, la receta es solo un consejo.

## 0. Alcance

Dentro: §5.2–§5.4 del plan; `server:` en `validate` y en los manifiestos; R19 (pieza y tipo
declarado, §1.1); hechos del cambio desde commits (§2); el juez en `pull_request_target`,
`merge_group`, `issue_comment`, `workflow_run` y `workflow_dispatch` (§3); el interruptor y la
degradación (§4); el job sin privilegios `ai-workflows/red-test` (§5); la acción reutilizable y
las plantillas de workflow (§6); la verificación del servidor de `approval-comment` (CN-05); casos
RC-06, SV-01…SV-09, CN-05, CN-08 (§7), con recorrido real en `ai-workflows-pruebas`.

Fuera (y dónde va): el bloque local de `approval-comment` y la publicación de veredictos de
`sandboxed-review`/`independent-review` como eventos autenticados (rebanada 4; hasta entonces su
comprobación del servidor bloquea con ese motivo, §3.4); `init` que escriba los workflows y el
sellado del SHA del motor en el paquete (rebanada 6, con la primera versión); la suite negativa
completa con informe (rebanada 5); cualquier cambio en Socialabs (R01).

## 1. La receta

### 1.1 Pieza y tipo declarado (R19)

Sección nueva y opcional `pieces:`:

```yaml
pieces:
  branch: ["*/{piece}", "*/{piece}-*"]     # qué ramas declaran pieza
  exclude-branches: ["libre/*"]           # ramas que nunca se fusionan
  declared-kind:                          # dónde declara la pieza su tipo
    file: "docs/plans/PLAN-{piece}.md"
    line: "Tipo de cambio"
```

- `branch`: lista de patrones sobre el nombre completo de la rama. `{piece}` aparece exactamente
  una vez y equivale a uno o más dígitos (la pieza es un número de issue); `*` equivale a cualquier
  texto sin `/`. El primer patrón que casa da la pieza. Caracteres permitidos fuera de `{piece}`:
  `A–Z a–z 0–9 . _ - / *`.
- `exclude-branches`: patrones con la misma sintaxis sin `{piece}`; una rama que casa con uno no
  tiene pieza aunque case con `branch`.
- `declared-kind.file`: ruta relativa con `{piece}` (mismas reglas que las rutas de `with:`).
  `declared-kind.line`: texto no vacío. Se lee la **primera** línea del archivo que, sin acentos ni
  mayúsculas y sin los adornos `*`, `` ` `` y `_`, empieza por esa etiqueta seguida de `:`. Su
  valor se normaliza igual (y los espacios pasan a `-`) y se compara con `kinds.names` y con las
  etiquetas de `labels` de cada tipo normalizadas igual («Tipo de cambio: comportamiento» →
  `behavior`). Archivo o línea ausentes → sin tipo declarado (se usa `kinds.default`, como hoy en
  Socialabs). Valor que no nombra ningún tipo → rechazo que nombra el valor. Archivo de más de
  1 MB → rechazo.
- `declared-kind` sin `kinds:` → `validate` lo rechaza.
- Sin `pieces:`, la pieza de un PR es su número y no hay tipo declarado.

Con `pieces:`, una rama sin pieza nunca se fusiona: el juez la rechaza (CN-08). El tipo declarado sigue siendo
palabra de la pieza (nivel A); `from-paths` y `elevate` lo corrigen desde los archivos (nivel B).
La rebanada 4 hará que el motor local lea lo mismo de su carpeta.

### 1.2 `server:` en `validate`

1. Toda etapa `pre-merge` lleva `server:` (§12 del plan). Si es obligatoria, `recompute`,
   `require-check` o `attestation`; `local-only` sigue permitido solo con `required: false`
   (regla de la rebanada 2).
2. Las etapas `merge` y `post-merge` solo admiten `server: local-only` o nada.
3. El modo debe estar entre los que permite el manifiesto del bloque (campo nuevo
   `server: [...]`, §1.3). Un bloque del proyecto (módulo o comando, y `run:`) solo admite
   `require-check`: el juez nunca ejecuta código del proyecto que no sea de su propia base, y ni
   siquiera ese (§3.1).
4. `require-check`: texto de 1 a 100 caracteres, sin caracteres de control; no puede nombrar el
   estado del propio juez (`ai-workflows` ni `ai-workflows/advisory`).
5. `attestation` de `approval-comment` exige `owner:` en la receta.
6. `server: recompute` en `benchmark-sources` con `check-reachable: true` se rechaza (§1.3).

Las reglas 1, 3 y 6 necesitan los manifiestos y viven en `checkRecipe` (lo que usan `validate`,
`explain` y el juez); las 2, 4 y 5 son de forma y viven en `parseRecipe`. El motor junto al agente
no usa `server:`, así que `compileRecipe` no las exige.

### 1.3 Manifiestos

`BlockManifest` gana `server: readonly ('recompute' | 'require-check' | 'attestation')[]`:

| Bloque | `server` permitido |
|---|---|
| `spec-structure`, `benchmark-sources` | `recompute`, `require-check` |
| `scope-reconcile` | `recompute`, `require-check` |
| `command`, `red-test`, `build-verify`, `browser-qa`, `preview-deployment` | `require-check` |
| `approval-comment`, `independent-review`, `sandboxed-review` | `attestation`, `require-check` |
| `github-merge`, `post-merge`, `cleanup` | ninguno |
| bloques del proyecto | `require-check` |

`BlockDefinition` gana una parte opcional para el servidor:

```ts
interface ServerCapability {
  recompute?(inputs: Record<string, unknown>, context: ServerContext): Promise<ServerResult>;
  attestation?(inputs: Record<string, unknown>, context: ServerAttestContext): Promise<ServerResult>;
}
type ServerResult =
  | { outcome: 'passed'; evidence?: JsonValue }
  | { outcome: 'rejected' | 'waiting'; reason: string }
  | { outcome: 'technical'; reason: string };
```

`ServerContext` = `{ facts, files: ProjectFiles, locale, piece }`, donde `ProjectFiles` lee del
**commit** juzgado (`read(path) → string | undefined`, `list() → string[]`), nunca del disco.
`spec-structure` y `benchmark-sources` se reescriben sobre `ProjectFiles` (el local lo implementa
sobre el disco, sin cambiar su comportamiento). En el servidor, `benchmark-sources` no comprueba
que las fuentes respondan (el job privilegiado no hace pedidos a direcciones que trae el PR);
su evidencia lo dice, y `validate` rechaza `server: recompute` en una etapa `benchmark-sources`
con `check-reachable: true` (esa etapa usa `require-check` de un job sin privilegios del
proyecto): el servidor nunca aprueba una regla que no comprobó. `scope-reconcile` en el servidor pasa siempre con evidencia
`{ declared, effective, raisedBy }`: el juez ya juzga con el tipo efectivo.

### 1.4 `explain`

Cada etapa `pre-merge` añade una línea «En GitHub: …» según su modo: «se vuelve a comprobar», «se
exige el check «X» en verde para esta versión», «se busca la aprobación publicada en el PR» o
«solo se comprueba junto al agente». Para una etapa `execution-record` con `require-check`, añade
que el orden en que se escribió solo lo vigila el motor junto al agente (§5.2 del plan). Si hay
`pieces:`, una línea dice cómo se reconoce la pieza y dónde declara su tipo.

## 2. Hechos del cambio desde commits

`describeChangeFromCommits({ root, base, head, recipe, piece, declaredKind })` devuelve los mismos
`ChangeFacts` de la rebanada 2 calculados solo con objetos de git, sin árbol de trabajo:
`sha = head`, `snapshot = árbol de head`, `mergeBase = git merge-base base head`, `files` de
`git diff --name-only -z --no-renames <mergeBase> <head>`, `fingerprint` con la misma definición
de bytes de §4.1 de la rebanada 2 sobre `<mergeBase> <head>`, `clean: true`, clases, tipo y carril
con `effectiveKind`. Comparte con `describeChangeFromGit` las funciones de huella, clasificación y
entorno de git (sin variables `GIT_*` heredadas, `--no-ext-diff --no-textconv`). `ProjectFiles`
del servidor: `git ls-tree -r -z --full-tree <head>` y `git cat-file blob <head>:<ruta>`, con tope de
1 MB por archivo (más grande → `technical` que lo nombra).

## 3. El juez

### 3.1 Procedencia

- El workflow del juez corre con `pull_request_target`, `merge_group`, `issue_comment`,
  `workflow_run` y `workflow_dispatch`. **Procedencia del YAML, comprobada en cada corrida** con
  `GITHUB_WORKFLOW_REF` (`<repo>/<ruta>@<ref>`) y la rama principal que informa la API
  (`GET repos/<repo>` → `default_branch`, nunca supuesta):
  - `merge_group`: `<ref>` debe ser `refs/heads/gh-readonly-queue/<principal>/…`. Ahí el YAML
    sale de la rama del grupo, que incluye los cambios de sus PRs; por eso la regla de archivos del
    juez (§3.5) rechaza en `pull_request_target` todo PR que los toque sin atestación del dueño
    (§5.2 del plan). Es la única confianza de la que depende este evento, y se declara.
  - Todos los demás eventos: `<ref>` debe ser exactamente `refs/heads/<principal>`. Un
    `workflow_dispatch` lanzado sobre otra rama no juzga ni publica **nada**, tampoco verde:
    termina con error en el registro («procedencia no comprobada: <ref>»).
  - **Rama destino:** un PR cuya rama destino no es la principal no se juzga ni recibe estado. Se
    comprueba con `pull_request.base.ref` del evento y con la `baseRef` viva del PR, al empezar
    y otra vez justo antes de publicar (un PR puede cambiar de destino); la procedencia del YAML no
    lo dice, porque `pull_request_target` corre el workflow de la rama principal sea cual sea el
    destino. Un PR hacia otra rama no necesita estado: la protección vigila la principal.
  - La ruta del workflow (`<ruta>`) es la del juez oficial para §3.5 y §3.7.
  - Esta comprobación la hace también el primer paso de consola (§6), antes de publicar nada.
- La acción se usa fijada por SHA de 40 caracteres. El paso que la corre recibe
  `github.action_ref` por `env` (`AI_WORKFLOWS_ACTION_REF`); si no es un SHA completo, error técnico
  «el juez no está fijado por SHA».
- **Commit confiable:** la punta viva de la rama principal (`GET repos/<repo>/branches/<principal>`
  → `commit.sha`), leída una vez al empezar. La receta, sus `block.yml` y la base de todos los
  diffs salen de ese commit, en todos los eventos. No se usa `merge_group.base_sha` ni
  `pull_request.base.sha` como fuente de la receta: el primero es el padre del grupo y puede
  contener PRs anteriores de la cola. En `merge_group` se exige además que el commit confiable sea
  ancestro del SHA del grupo (`git merge-base --is-ancestor`); si no, técnico.
- Hace checkout **solo** de ese commit (`persist-credentials: false`). El código del PR se trae
  como **objetos** (`git fetch --no-tags origin <sha>`, con el token en una cabecera de esa sola
  orden) y se lee con `git cat-file`/`git diff`; nunca se hace checkout de él ni se ejecuta.
- El juez no ejecuta ningún bloque: solo llama a las partes `server` de los bloques del motor
  (§1.3). No lee `refs/ai-workflows/*` ni usa almacén ni proveedores (SV-08): sus módulos no
  importan `state`, `store-git`, `store-github`, `providers` ni `exec`, y una prueba estática lo
  comprueba.

### 3.2 Qué juzga en cada evento

| Evento | SHA juzgado (donde publica) | PRs que juzga |
|---|---|---|
| `pull_request_target` | `pull_request.head.sha` | ese PR |
| `issue_comment` (en un PR) | cabeza viva del PR (`GET pulls/N`) | ese PR |
| `workflow_dispatch` (`pr`) | cabeza viva del PR | ese PR |
| `workflow_run` de un `pull_request` | `workflow_run.head_sha` | PRs abiertos cuya cabeza es ese SHA (`commits/<sha>/pulls`, filtrados por `state: open` y `head.sha` igual); `workflow_run.pull_requests` no se usa porque viene vacío (observado en el repositorio de pruebas) |
| `merge_group` | `merge_group.head_sha` | los de la lista de la cola hasta la entrada cuya `headCommit` es el SHA del grupo |
| `workflow_run` de un `merge_group` | `workflow_run.head_sha` | igual, desde la lista de la cola |

- La lista de la cola se lee por GraphQL (`mergeQueue(branch).entries`, con variables, nunca texto
  interpolado), igual que `candado-cola` de Socialabs: sin lista confirmable (página extra, posición
  ausente o repetida, SHA del grupo que no aparece) → técnico. Nunca se pregunta a qué PR pertenece
  el commit del grupo (lección de #1091).
- En un grupo, cada PR se juzga con su cabeza (`pullRequest.headRefOid`) contra el commit
  confiable (§3.1), salvo `require-check`, que se lee sobre el **SHA del grupo** (un verde de la cabeza del
  PR no acredita al grupo). El grupo pasa solo si pasan todos sus PRs.
- Correlación incierta → técnico, nunca verde: un `workflow_run` cuyo SHA no es la cabeza de ningún
  PR abierto ni un grupo de la cola no publica nada y lo registra; uno cuya lista de PRs no se puede
  leer publica `error` sobre ese SHA.
- `workflow_run` se dispara al terminar los workflows que la plantilla lista (el de
  `ai-workflows/red-test` y los que produzcan checks exigidos, que el proyecto agrega); así el juez
  vuelve a juzgar cuando un check exigido termina. Límite declarado: un check de una app externa
  (no de Actions) no lo vuelve a disparar; se usa `workflow_dispatch` o el siguiente evento del PR.

### 3.3 Cómo juzga un PR

1. Pieza por R19 desde el nombre de la rama de la cabeza (`head.ref` o `headRefName`). Sin pieza →
   el PR se rechaza (CN-08), sin mirar etapas.
2. Tipo declarado del archivo de `declared-kind` en la cabeza (§1.1); hechos por §2.
3. Por cada etapa `pre-merge` en orden: `appliesIfFor` sobre los hechos; si no aplica,
   `skipped` con su motivo. Si aplica, según `server`:
   - `recompute` → `definition.server.recompute(inputs, context)` con las entradas ya validadas y
     con valores por omisión (la misma función que usa `compileRecipe`).
   - `require-check: X` → §3.4.
   - `attestation` → `definition.server.attestation(...)`; sin ella → técnico «la comprobación
     del servidor de este bloque llega en la rebanada 4».
   - `local-only` (solo en `required: false`) → informativa, no cuenta.
   Una excepción en una etapa la deja `technical` con su motivo y el juez sigue con las demás.
4. Las etapas `merge` y `post-merge` no se juzgan. Una etapa `required: false` que falla se
   informa y no bloquea.
5. Veredicto del PR: `technical` si alguna obligatoria quedó técnica; si no, `rejected` si alguna
   quedó rechazada; si no, `waiting` si alguna espera; si no, `passed`. El informe lista todas.

### 3.4 `require-check`

Se leen, para el SHA de §3.2, los check-runs con ese nombre exacto (`commits/<sha>/check-runs?
check_name=X&filter=latest`, paginado) y el último estado de cada contexto igual a `X`
(`commits/<sha>/statuses`, paginado). Sin ninguno → `waiting` «falta el check X». Alguno sin
terminar (`queued`, `in_progress`, `pending`) → `waiting`. Alguno terminado distinto de `success`
(incluidos `skipped`, `neutral`, `cancelled`, `failure`, `error`, `timed_out`) → `rejected` que lo
nombra con su conclusión. Todos `success` → `passed` (SV-01). El juez nunca corre una suite.
Límite declarado (como `todo-verde` hoy): un workflow deliberado puede publicar un check con ese
nombre (R13).

### 3.5 Archivos del juez y atestación del dueño (SV-04, RC-06)

- Archivos del juez: `.ai-workflows/**`, el archivo del workflow que corre el juez (ruta sacada de
  `GITHUB_WORKFLOW_REF`) y los que nombre la entrada `also-protect` de la acción (la plantilla
  pone el workflow de `ai-workflows/red-test`). La versión fijada de la acción vive dentro del
  workflow, así que queda cubierta.
- Un PR cuyo diff (§2) toca alguno se rechaza, además de lo que digan sus etapas, salvo que el
  dueño (`owner:` de la receta **de la base**) haya comentado `/approve-judge-change <código>`
  donde el código es un prefijo de 7 a 40 caracteres hexadecimales de la **cabeza actual**. Reglas
  del comentario, las mismas del visto bueno de v0.3.0: sola en su línea y fuera de código o
  citas, del dueño, cuenta `User`, no publicado por una app, no editado. Un commit nuevo exige otra
  atestación.
- La receta con que se juzga es siempre la de la base (RC-06): un PR que quita una etapa de
  `pipeline.yml` se juzga con la etapa y, además, se rechaza por tocar archivos del juez.
- Sin receta en el commit confiable o con una receta inválida → `error` para todo PR en `on` (y
  en el consultivo en `advisory`). Nunca verde: el único verde sin decidir es el de la variable
  `off` explícita (§4), que es el remedio a mano del dueño.

### 3.6 `approval-comment` en el servidor (CN-05)

`server.attestation` con entradas `command` (por omisión `/approve`) y `code-length` (por omisión
7). Lee todos los comentarios del PR (paginados). Un comentario vale si cumple las reglas de §3.5
con `command` en lugar de `/approve-judge-change`, su código tiene al menos `code-length`
caracteres y nombra un commit `C` que la vigencia de la etapa acepta:

- `same-sha`: `C` es la cabeza.
- `same-fingerprint`: `C` es la cabeza, o un commit **candidato** cuya huella contra su propia
  base de fusión con el commit confiable es igual, byte a byte y no vacía, a la de la cabeza.
  Candidatos: los commits alcanzables desde la cabeza **o desde cualquier cabeza anterior
  reemplazada por un force push**, y no desde el commit confiable. Las cabezas anteriores salen de
  la línea de tiempo del PR (GraphQL `timelineItems(itemTypes: HEAD_REF_FORCE_PUSHED_EVENT)` →
  `beforeCommit.oid`, paginada; sin lista confirmable → técnico) y se traen como objetos. Así la
  aprobación sobrevive a rehacer el commit con los mismos cambios (tabla de §3.3 del plan). Si
  GitHub ya no entrega una cabeza anterior, ese candidato no existe y se pide otra aprobación
  (del lado seguro; se declara). Un código que casa con dos candidatos distintos no vale (ambiguo).
- `same-fingerprint-or-clean-update`: `C` es la cabeza, y nada más. La tabla de §3.3 del plan
  solo conserva esta vigencia ante una actualización **registrada** por el motor o el vigilante de
  la fila, y el juez no lee el almacén donde vive ese registro (§3.1): en el servidor, una
  actualización con la base caduca la aprobación y hay que pedirla otra vez (del lado seguro; se
  declara en `explain`). Un commit rehecho con la misma huella tampoco la conserva (la tabla dice
  que un force push con huella idéntica caduca).

Sin comentario válido → `waiting` si la etapa es `needs-human`, `rejected` si no; el motivo dice
qué escribir (`<command>` y los primeros `code-length` caracteres de la cabeza) y por qué no valió cada comentario que
traía la orden. Se generaliza `evaluateSignOff` de `locks/signoff.ts` con la orden como parámetro
(la actual `/visto-bueno` queda como caso de uso y sus pruebas no cambian).

### 3.7 Rastro de estados imitados (SV-04, R13)

En cada corrida el juez lista, sobre el SHA juzgado, los **estados** y los **check-runs** con los
nombres de sus contextos (`ai-workflows` y `ai-workflows/advisory`). El juez nunca crea
check-runs con esos nombres (su job se llama distinto), así que todo check-run con ese nombre es no
oficial y se reporta con la app que lo creó y su enlace; GitHub exige que pasen ambos si un check y
un estado comparten nombre, pero el rastro los lista igual. Uno es oficial si su `target_url` es
`https://github.com/<repo>/actions/runs/<id>` (con o sin `/job/<n>`), esa corrida existe
(`actions/runs/<id>`), su `path` es el workflow del juez y su evento está en la lista de §3.2. Los
demás se reportan como «estado de origen no oficial» en el resumen de la corrida y en un comentario
del PR que el juez mantiene (uno por PR, actualizado). Límite declarado: quien copie el enlace de
una corrida real del juez no se detecta (R13).

### 3.8 Publicación

- Contexto principal `ai-workflows` (entrada `context` de la acción) y consultivo
  `ai-workflows/advisory`. El job se llama «Juez de ai-workflows», nunca como un estado.
- Estados: `passed` → `success`; `rejected` → `failure`; `waiting` → `pending`; `technical` →
  `error`. Descripción de hasta 140 caracteres en el idioma de la receta, empezando por la etapa
  que manda («Falta el visto bueno del dueño: /approve 1a2b3c4», «Rechazado en red-test: …»);
  `target_url` es la corrida. El detalle por PR y por etapa va al resumen de la corrida
  (`GITHUB_STEP_SUMMARY`), con todo texto que venga del PR saneado (`safeTerminalText` y escape de
  Markdown).
- Antes de juzgar, un paso de consola retira el verde anterior: publica `pending` sobre el SHA de
  §3.2 (en `on` en el principal; en `advisory` en el consultivo), con `target_url` = esta
  corrida. Si la corrida falla o se cancela después, queda ese `pending` o el `error` del paso
  final: nunca un verde.
- **Corridas que se cruzan.** Justo antes de publicar su veredicto, la corrida (a) vuelve a leer la
  cabeza viva del PR y, si ya no es el SHA juzgado, no publica veredicto sobre ninguno (la corrida
  de la cabeza nueva lo hará) y lo registra; (b) vuelve a leer la punta de la principal y, si cambió,
  juzga de nuevo con el commit nuevo (una vez; si vuelve a cambiar, `error` «la rama principal
  cambió mientras se juzgaba»); (c) lista los estados de su contexto sobre el SHA y, si el más
  reciente no es su propio `pending` (otra corrida oficial empezó después), no publica. Queda una
  ventana de milisegundos entre (c) y la publicación; se declara. `concurrency` por PR con
  `cancel-in-progress: true` reduce los cruces.
- **Un verde viejo sobre el mismo SHA** solo sobrevive si ninguna corrida posterior llega a su primer
  paso: GitHub cancela una corrida en espera solo al llegar otra más nueva, que sí corre. Si Actions
  no arranca ninguna (caída), queda el último estado publicado; es el límite de §5.3 del plan.

## 4. El interruptor y la degradación (§5.3 del plan)

- `AI_WORKFLOWS_MODE` (variable del repositorio) llega como entrada `mode`. Sin valor → `off`.
  `off`, `advisory`, `on` (sin espacios alrededor, sin distinguir mayúsculas). Otro valor → `error`
  en el principal «AI_WORKFLOWS_MODE inválido: use off, advisory u on».
- `off`: el primer paso de la acción publica `success` «motor apagado» en el principal y termina;
  no instala ni compila nada, así que funciona aunque el motor esté roto.
- `advisory`: el primer paso publica `success` «modo consulta» en el principal; el veredicto real
  va al consultivo. Si la corrida falla, el principal ya está en verde. Es deliberado: `advisory`
  es una llave explícita del dueño que por definición no bloquea (§5.3 y SV-02 del plan, aprobados).
- `on`: el veredicto real va al principal.
- Las dos llaves, combinadas (SV-02):

  | Variable | Protección exige el estado | Resultado |
  |---|---|---|
  | `off` o sin valor | no | verde «motor apagado»; nada bloquea |
  | `off` o sin valor | sí | igual: la variable basta para desatascar |
  | `advisory` | no / sí | principal verde; veredicto en el consultivo; nada bloquea |
  | `on` | no | veredicto real en el principal; no bloquea porque nadie lo exige |
  | `on` | sí | veredicto real; bloquea sin evidencia vigente |
  | inválida | no / sí | `error` en el principal; bloquea solo si se exige |
- Cada PR se juzga aparte (§3.3): un PR de papeles o uno cuyas etapas aplicables no dependen de lo
  caído se juzga normalmente aunque otro quede técnico (SV-03). El juez no depende del almacén ni de
  los proveedores, así que su caída no lo afecta. Un error interno en un PR deja técnico solo ese PR;
  en un grupo, el grupo.
- Límite declarado: con la API de estados o Actions caídas no se publica nada, tampoco el verde de
  `off`; el remedio es quitar el estado de la protección.

## 5. El job sin privilegios `ai-workflows/red-test` (§5.2 del plan, SV-09)

Workflow aparte (`ai-workflows-red-test.yml`) con `pull_request` y `merge_group`, job llamado
`ai-workflows/red-test` (ese es el nombre del check), `permissions: contents: read,
pull-requests: read`, sin ninguna referencia a `secrets.`, checkout con `persist-credentials:
false` y `fetch-depth: 0`, seguido de los pasos del proyecto para instalar dependencias (la
plantilla trae `pnpm install --frozen-lockfile` como ejemplo) y de la acción con `task: red-test`.

`ai-workflows red-test-check`:
1. Receta del **mismo commit confiable que usa el juez** (§3.1: punta viva de la principal, que
   en `merge_group` debe ser ancestro del grupo), leída de git. Las pruebas corren contra otros
   commits, fijados aparte: la base de ejecución es `pull_request.base.sha` en `pull_request`; en `merge_group` es, para
   cada PR, el `baseCommit` de **su propia entrada** de la cola (el commit anterior a que ese PR
   entrara: la punta de la principal para el primero, la entrada anterior para los siguientes), así
   un PR anterior del mismo grupo o de un grupo encadenado nunca hace pasar contra la base las
   pruebas de otro. La cabeza de ejecución es la del PR o el SHA del grupo. PRs: el del evento, o los del grupo desde la lista de la cola. El token solo se usa
   en ese paso; los procesos de prueba se lanzan con un entorno sin ninguna variable cuyo nombre
   contenga `TOKEN`, `SECRET`, `PASSWORD` o `KEY`, ni `ACTIONS_*` ni `GH_*`.
2. Por cada PR: pieza y tipo por R19, hechos por §2 (cabeza del PR contra la base). Por cada etapa
   que usa `ai-workflows/red-test@1` y aplica: pruebas = archivos del cambio que casan con su
   `tests` y existen en la cabeza. Sin pruebas → falla «la pieza no trae pruebas».
3. **Contra la base:** carpeta temporal (`git worktree add --detach <base>`) con los archivos de
   prueba copiados desde la cabeza del PR (en un grupo, desde el SHA del grupo) y `node_modules`
   enlazado como en `build-verify`; corre `command` con `{tests}`; debe dar `isRedEvidence`.
4. **Contra la cabeza** (la cabeza del PR, o el SHA del grupo): la misma corrida debe dar
   `isGreenRun`.
5. Sale con 0 solo si todo PR y etapa cumple; si ninguna etapa aplica, sale con 0 y lo dice. El
   detalle va al resumen. Retirada de carpetas temporales como en `build-verify`.

Dependencias: la corrida contra la base usa las dependencias instaladas desde la cabeza, a
propósito y como el motor local (que corre la prueba roja en la carpeta de la pieza con sus
dependencias): una prueba nueva que importa una dependencia que el PR agrega debe fallar contra la
base por su aserción, no por importación. Una prueba de esto va en §7.

Esta corrida ejecuta código del PR y su workflow sale del PR: merece la confianza de `todo-verde`
(nivel B frente a atajos, no frente a un PR malicioso, §5.2 del plan). Lo que garantiza SV-09 son
los permisos: su token no puede publicar estados.

## 6. La acción y las plantillas

- `action.yml` en la raíz del repositorio (acción compuesta), entradas `task` (`judge` o
  `red-test`), `mode`, `token`, `context` (por omisión `ai-workflows`), `also-protect` (rutas). Las
  acciones que usa por dentro (`actions/checkout`, `actions/setup-node`, `pnpm/action-setup`) van
  fijadas por SHA.
- Pasos de `judge`: (1) calcular el SHA y los PRs de §3.2 y, según el modo, publicar el verde de
  `off`/`advisory` o el `pending` de `on`, solo con `gh api` y variables de entorno (nunca
  `${{ }}` dentro del comando); con `off`, termina aquí. (2) Instalar y compilar el motor en
  `$GITHUB_ACTION_PATH` (`pnpm install --frozen-lockfile`, que compila). (3) Checkout de la rama principal
  (`fetch-depth: 0`, `persist-credentials: false`); el juez comprueba que el commit obtenido es el
  commit confiable de §3.1 y, si la principal ya avanzó, trae y usa el nuevo. (4) `node dist/bin.js judge`. (5) `if: failure()`: `error` «el juez no pudo terminar».
- Pasos de `red-test`: (2) y `node dist/bin.js red-test-check`.
- Plantillas `templates/ai-workflows.yml` (juez) y `templates/ai-workflows-red-test.yml`, con la
  acción como `luismichelcf/ai-workflows@<ENGINE_SHA>` para sustituir. Permisos del juez: `contents:
  read`, `pull-requests: write` (comentario de rastro), `issues: read`, `checks: read`,
  `actions: read`, `statuses: write`. `concurrency` por PR (o por SHA del grupo) con
  `cancel-in-progress: true`. `pull_request_target` con `types: [opened, synchronize, reopened,
  edited]`: `edited` hace que cambiar la rama destino (o volver a la principal con el mismo SHA)
  dispare otra corrida. En `issue_comment` solo corre si es de un PR y el comentario
  contiene `/`, o fue editado o borrado.
- El binario gana `judge` y `red-test-check`; leen `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`,
  `GITHUB_REPOSITORY`, `GITHUB_WORKFLOW_REF`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL`,
  `GITHUB_STEP_SUMMARY` y las entradas de la acción.
- Borde con GitHub: un puerto `JudgeGitHub` (leer PR, lista de la cola, comentarios, check-runs,
  estados, corridas; publicar estado; crear o actualizar el comentario de rastro) implementado
  sobre `createGhRunner`, sin consola. Las pruebas del juez usan un puerto falso (borde externo) y
  git real; el puerto real se prueba contra `ai-workflows-pruebas`.

### 6.1 Interfaces que fijan las pruebas

```ts
// src/recipe/facts.ts
describeChangeFromCommits(o: { root; base; head; recipe; piece; declaredKind?: string }): Promise<ChangeFacts>;
interface ProjectFiles { read(path: string): Promise<string | undefined>; list(): Promise<string[]> }
gitProjectFiles(root: string, sha: string): ProjectFiles;   diskProjectFiles(root: string): ProjectFiles;

// src/judge/pieces.ts (R19)
pieceOfBranch(recipe, branch: string, prNumber: number): { piece: string } | { none: string };
readDeclaredKind(recipe, piece: string, files: ProjectFiles): Promise<{ kind?: string } | { rejected: string }>;

// src/judge/port.ts — el borde con GitHub
interface JudgeGitHub {
  defaultBranch(): Promise<string>;
  branchHead(branch: string): Promise<string>;
  pullRequest(n: number): Promise<{ number; state; headSha; headRef; baseRef; headRepo: string }>;
  openPullRequestsWithHead(sha: string): Promise<number[]>;
  mergeQueue(branch: string): Promise<{ position: number; headSha: string; baseSha: string; prNumber: number }[]>; // lanza si no es confirmable
  comments(n: number): Promise<PullRequestComment[]>;
  checkRuns(sha: string, name: string): Promise<{ status: string; conclusion: string | null; app: string; url: string | null }[]>;
  statuses(sha: string): Promise<{ context; state; targetUrl: string | null; createdAt: string }[]>; // más reciente primero
  workflowRun(id: number): Promise<{ path: string; event: string } | undefined>;
  forcePushedHeads(n: number): Promise<string[]>;                      // lanza si no es confirmable
  publishStatus(sha: string, s: { context; state; description; targetUrl }): Promise<void>;
  upsertTraceComment(n: number, body: string): Promise<void>;
}

// src/judge/judge.ts
interface JudgeInput {
  eventName: string; event: unknown;            // la carga de GITHUB_EVENT_PATH
  mode: string; context: string; repository: string;
  workflowRef: string; actionRef: string; runId: number; serverUrl: string;
  alsoProtect: readonly string[]; root: string; // checkout del commit confiable
}
interface JudgeReport {
  published: { sha; context; state; description }[];
  pieces: { pr: number; piece?: string; verdict: 'passed' | 'rejected' | 'waiting' | 'technical';
            stages: { id; outcome: 'passed' | 'skipped' | 'rejected' | 'waiting' | 'technical' | 'informative'; reason?: string }[] }[];
  unofficial: { sha; context; kind: 'status' | 'check-run'; url: string | null; app?: string }[];
  summary: string;                              // Markdown para GITHUB_STEP_SUMMARY
  notes: string[];                              // lo que no se publicó y por qué
}
runJudge(input: JudgeInput, deps: { github: JudgeGitHub; fetchObjects(shas: string[]): Promise<void>;
         now?: () => Date }): Promise<JudgeReport>;

// src/judge/red-test-check.ts
runRedTestCheck(input: { eventName; event; root; repository }, deps: { github: Pick<JudgeGitHub, 'defaultBranch' | 'branchHead' | 'mergeQueue' | 'pullRequest'>; fetchObjects })
  : Promise<{ ok: boolean; summary: string }>;
```

`PullRequestComment` es el tipo existente de `locks/signoff.ts`. Los nombres de módulos pueden
cambiar si el constructor lo necesita; las firmas de arriba son las que usan las pruebas.

## 7. Casos y pruebas

Cada caso: motivo, estado publicado y ausencia de efectos, con su control positivo.

| Caso | Prueba local (en la CI) | Recorrido real en `ai-workflows-pruebas` |
|---|---|---|
| RC-06 | PR que quita una etapa de la receta: se juzga con la de la base (la etapa aparece en el informe) y se rechaza por archivos del juez | sí |
| SV-01 | `command@1` con `require-check: todo-verde`: ningún proceso lanzado (el puerto y git son lo único que se toca); verde en ese SHA pasa, verde en otro SHA no; pendiente espera; `skipped` rechaza | sí (check real) |
| SV-02 | `off`, `advisory`, `on` y valor inválido: qué se publica y dónde, incluso si el juez falla | encender y apagar en ambos órdenes y a medias, con la protección real |
| SV-03 | Fallo interno inyectado en una etapa de un PR: otro PR (papeles) y otro que no depende de ella pasan; solo el afectado queda técnico. Con `off`/`advisory` ninguno bloquea | — |
| SV-04 | Estado con `target_url` ajeno → reportado; oficial → no; check-run llamado `ai-workflows` → reportado con su app. PR que toca `.ai-workflows/`, el workflow del juez o `also-protect` → rechazado; con `/approve-judge-change` del dueño para la cabeza → pasa; de otra cuenta, editado, de otra versión → no | sí, con un workflow imitador que publica un estado y otro job llamado `ai-workflows` (check-run) |
| SV-05 | Cada variante con estado publicado, efectos y control positivo: (a) la cabeza cambia antes de publicar → ningún veredicto publicado, registro que lo dice; positivo: cabeza igual → publica. (b) la principal avanza durante el juicio → se juzga otra vez con la nueva; si vuelve a avanzar → `error`. (c) otra corrida oficial publicó después de nuestro `pending` → esta no publica. (d) corrida que falla tras el `pending` → queda `pending` o `error`, nunca verde. (e) permiso insuficiente para leer comentarios o checks → etapa técnica y `error`; sin permiso para publicar → la corrida falla con el motivo y no queda verde nuevo | cancelada antes del primer paso mientras corre otra (el veredicto de la otra queda); cancelada tras el `pending` (queda `pending`); permisos (`statuses` quitado) |
| SV-06 | Pieza válida salvo una etapa cuyo check del servidor falla: rechazo que nombra la etapa; positivo en verde | sí (pruebas que no fallan contra la base) |
| SV-07 | `merge_group`: PRs desde la lista de la cola, `require-check` sobre el SHA del grupo, verde solo de la cabeza no autoriza; lista truncada o incompleta → técnico; commit confiable que no es ancestro del grupo → técnico; `GITHUB_WORKFLOW_REF` fuera de `gh-readonly-queue/<principal>/` → nada publicado | sí, en la cola real, con un grupo de **dos** PRs y con grupos encadenados (dos PRs encolados uno tras otro en grupos distintos); se registra de qué ref salió el YAML en cada corrida |
| SV-08 | Almacén en memoria con la etapa `red-test` marcada `passed` a mano y puerto falso que falla si se pide cualquier `refs/ai-workflows`: el juez rechaza por su propia comprobación (falta el check) y no hace esa lectura; positivo: con el check en verde pasa. Prueba estática de importaciones (§3.1) | un ref `refs/ai-workflows/pieces/<n>` escrito a mano no cambia el veredicto |
| SV-09 | Plantillas: permisos exactos, sin `secrets.`, `persist-credentials: false`, el job privilegiado no hace checkout más que de la base; entorno de las pruebas sin tokens | PR cuyas pruebas buscan tokens y tratan de publicar un estado: no pueden; el registro muestra el checkout de la base; el check existe sobre el SHA del grupo y el juez lo exige |
| CN-05 | Etapa visible sin visto bueno → `pending`; con `<command> <código>` del dueño → pasa; editado, de otra cuenta, por app, de otra versión con otra huella → no; misma huella en un commit vacío encima → pasa; misma huella en un commit rehecho con force push (cabeza anterior en la línea de tiempo) → pasa; cabeza anterior que GitHub ya no entrega → `pending`; línea de tiempo ilegible → técnico | sí, con un force push real |
| CN-08 | Rama `libre/x` o sin patrón → rechazo; rama con pieza → sigue | sí |
| Procedencia | `workflow_dispatch` desde otra rama, PR hacia otra rama (por el evento y por su `baseRef` viva, también si cambia de destino durante el juicio) → nada publicado, error en el registro; receta ausente o inválida en la principal → `error` en `on`, verde solo con `off`; `action_ref` que no es SHA → `error` | `workflow_dispatch` real desde una rama de prueba; PR real hacia otra rama: ningún estado nuevo, con un PR hacia la principal como positivo; PR que va de `main` a otra rama y vuelve a `main` con el mismo SHA y un verde previo: la vuelta dispara otra corrida que juzga de nuevo |
| `workflow_run` | SHA sin PR abierto → nada publicado; dos PRs con la misma cabeza → se juzgan ambos; lectura fallida → `error`; de un `merge_group`: PRs desde la lista de la cola, entrada que ya no está → técnico | la corrida del juez que dispara el fin de `ai-workflows/red-test` publica sobre la cabeza del PR correcto; `filter=latest` devuelve la corrida en curso como `in_progress` (se observa y se registra); al terminar `ai-workflows/red-test` **del grupo**, la corrida `workflow_run` del juez publica sobre el SHA del grupo con los PRs de la cola (se registran SHA y PRs); si el grupo ya salió de la cola, publica `error` o nada según §3.2, nunca verde |
| Fork | Carga de evento de un PR de un fork (`head.repo` distinto): se juzga igual, trae sus objetos por `refs/pull/N/head` | — (no hay una segunda cuenta; límite declarado) |
| R19 | Ramas y exclusiones; tipo por etiqueta en inglés y por su nombre en español; valor desconocido → rechazo; sin archivo → `default`; `validate` de cada forma inválida con línea y columna | — |
| §1.2 | Un negativo con línea y columna y un positivo por cada regla | — |
| red-test-check | Receta leída del commit confiable aunque `merge_group.base_sha` traiga otra (un PR anterior del grupo que quita la etapa no la apaga); en un grupo de dos PRs cuyas pruebas son las mismas, cada uno se prueba contra el `baseCommit` de su entrada (el segundo no se rechaza porque el primero ya hace pasar la prueba); repositorio git real temporal con un proyecto Vitest mínimo: prueba que falla en la base y pasa en la cabeza → 0; que pasa en la base → falla; que falla por importación en la base → falla; sin pruebas → falla; etapa que no aplica → 0; grupo con dos PRs; prueba que importa un módulo que agrega el PR → roja por aserción contra la base (dependencias de la cabeza, §5); entorno del proceso de prueba sin variables de token | sí |

El recorrido real vive en `tests/github/judge.github.test.ts`, corre con `pnpm test:github` y
`AI_WORKFLOWS_GITHUB_TEST_REPO`, **falla** (no se salta) sin credenciales, y el orquestador lo corre
antes de fusionar y pega la salida en el PR. Instala receta y workflows en la rama principal del
repositorio de pruebas fijados al commit del motor bajo prueba, toma la configuración de la
protección, la usa durante la corrida y la restaura al final; cierra los PRs y borra las ramas que
crea. `NOT_YET_EXECUTABLE` de `tests/negative-cases.test.ts` pierde CN-05 y CN-08.

## 8. Orden de construcción

Una prueba roja por cambio; el constructor la pone verde; el orquestador verifica y commitea.

1. Receta: `pieces:` (R19), reglas de §1.2, `server` en manifiestos, `explain`.
2. Hechos desde commits (§2), `ProjectFiles` y lectura del tipo declarado.
3. `spec-structure`, `benchmark-sources` y `scope-reconcile` sobre `ProjectFiles`, con su parte
   del servidor.
4. Núcleo del juez con puerto falso: eventos, PRs, etapas, `require-check`, archivos del juez,
   veredicto, publicación, modos (§3, §4).
5. `approval-comment` del servidor y la orden generalizada del visto bueno (§3.6).
6. Rastro de estados (§3.7).
7. `red-test-check` (§5).
8. Puerto real sobre `gh`, binario, `action.yml` y plantillas (§6), pruebas estáticas de plantillas.
9. Recorrido real en `ai-workflows-pruebas`; README en inglés; §2 y §12 del plan al día.

## 9. Decisiones del orquestador en esta rebanada

- El juez es una acción compuesta que compila el motor desde el SHA fijado: no hay paquete
  publicado antes de la rebanada 6 y no se agrega un empaquetador (sin dependencias nuevas). Cuesta
  cerca de un minuto de Actions por corrida; `off` no compila nada.
- El job `ai-workflows/red-test` va en su propio workflow para que el juez pueda escucharlo con
  `workflow_run` sin escucharse a sí mismo.
- En el servidor `benchmark-sources` no comprueba que las fuentes respondan (§1.3).
- Una variable `AI_WORKFLOWS_MODE` con un valor desconocido bloquea (error honesto) en vez de
  adivinar; sin valor es `off`, que es como se integra.
- `waiting` se publica como `pending` y `technical` como `error`, para que el dueño distinga «falta
  tu visto bueno» de «algo está mal».
- La atestación de cambios al juez es la orden fija `/approve-judge-change <código>` sobre la
  cabeza exacta (vigencia `same-sha`).

## 10. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura (sesión `01a0cfab-0168-7041-ad1c-459b93f94c73`):**
REVISE, 8 bloqueantes; 7 aceptados, 1 respondido:
1. `merge_group.base_sha` es el padre del grupo, no la principal → receta, manifiestos y base de
   los diffs salen siempre de la punta viva de la principal, que debe ser ancestro del grupo (§3.1).
2. `workflow_dispatch` y PRs hacia otra rama traen YAML de otra rama → procedencia comprobada por
   evento con `GITHUB_WORKFLOW_REF`; sin ella no se publica nada, tampoco verde (§3.1).
3. «La salida es `off`» sonaba a verde sin receta → `error`; solo la variable `off` da verde (§3.5).
4. `advisory` publica verde aunque el juez falle → **se mantiene**: es la semántica aprobada por el
   dueño en §5.3 y SV-02 del plan (una llave explícita que no bloquea); se añade la tabla de las dos
   llaves (§4).
5. Un verde viejo podía sobrevivir a corridas cruzadas → relectura de cabeza y principal antes de
   publicar y abstención si otra corrida oficial publicó después; límites declarados (§3.8).
6. La aprobación con `same-fingerprint-or-clean-update` sobrevivía sin el registro que exige el
   plan → en el servidor solo vale para la cabeza; una actualización pide otra aprobación (§3.6).
7. `benchmark-sources` en el servidor aprobaba sin comprobar las fuentes → `validate` rechaza
   `recompute` con `check-reachable: true` (§1.2, §1.3).
8. Pruebas incompletas → SV-05 y SV-08 por variante con estado, efectos y positivo; recorridos reales
   de `workflow_run`, `filter=latest`, grupo de dos PRs y cancelación; dependencias de la cabeza
   en la corrida contra la base, justificadas y probadas; forks declarados (§5, §7).

No bloqueante aplicado: `github.action_ref` llega por `env` (§3.1). Se añaden las interfaces que
fijan las pruebas (§6.1).

**Ronda 2 — misma sesión (versión 2):** REVISE, 3 bloqueantes, aceptados; retira el de `advisory`:
1. `red-test-check` leía la receta de `merge_group.base_sha` → la lee del mismo commit confiable
   que el juez; los commits donde corren las pruebas se fijan aparte (§5).
2. El rastro R13 no veía check-runs con el nombre del estado → se listan y reportan con su app
   (§3.7, §6.1, §7).
3. Faltaba el recorrido real de `workflow_run` de un grupo → añadido (§7).

No bloqueante aplicado: «una rama sin pieza nunca se fusiona» presupone `pieces:` (§1.1).
Ajuste propio: las reglas 1, 3 y 6 de §1.2 viven en `checkRecipe` (validate, explain y el juez),
no en `parseRecipe`: el motor local no usa `server:`.

**Ronda 3 — misma sesión (versión 3):** REVISE, 2 bloqueantes, aceptados:
1. En la cola, `merge_group.base_sha` puede contener PRs anteriores del grupo → cada PR se prueba
   contra el `baseCommit` de su entrada; recorrido real con grupos encadenados (§5, §7).
2. La firma de `red-test-check` no permitía leer la principal → el puerto incluye `defaultBranch`
   y `branchHead` (§6.1).

No bloqueante anotado para la rebanada 4: `run` llamará a `checkRecipe` antes de ejecutar.

**Ronda 4 — misma sesión (versión 4):** REVISE, 1 bloqueante, aceptado: `pull_request_target`
corre el workflow de la principal sea cual sea el destino, así que un PR hacia otra rama se reconoce
por `base.ref` (del evento y viva, al empezar y antes de publicar), no por la procedencia (§3.1,
§7). Ajuste propio: la aprobación de un commit anterior con la misma huella solo se resuelve dentro
de la historia actual del PR (§3.6).

**Ronda 5 — misma sesión (versión 5):** REVISE, 2 bloqueantes, aceptados:
1. La aprobación de un commit rehecho con la misma huella caducaba → los candidatos incluyen las
   cabezas reemplazadas por force push, leídas de la línea de tiempo del PR (§3.6, §6.1, §7).
2. Cambiar la rama destino no garantizaba otra corrida → `pull_request_target` escucha `edited`;
   recorrido real de ida y vuelta a `main` con el mismo SHA (§6, §7).

**Ronda 6 — misma sesión (versión 6):** **APPROVED**, sin bloqueantes. No bloqueante aplicado: el
motivo de §3.6 usa la longitud `code-length`, no «los 7 primeros». Aprobación del diseño; la
implementación se verifica aparte (puerta del orquestador, parvada y recorrido real).
