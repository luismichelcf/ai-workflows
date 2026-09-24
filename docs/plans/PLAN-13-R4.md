# PLAN-13 · Rebanada 4 — Etapas finales

Diseño de construcción de la rebanada 4 de [PLAN-13](PLAN-13.md) (issue #13). El plan decide
*qué*; este documento fija *cómo*. Autor: Claude Opus 5.5 (orquestador). Revisor: GPT-6 Sol `high`
(R12). Versión 10 · 24-sep-2026 · **Aprobado** por GPT-6 Sol `high` en 10 rondas (§13). Constructor: DeepSeek V4.1 Flash `high` (R17).

## En tres líneas

**Qué pasa hoy:** la receta se valida, sus primeras etapas corren junto al agente y el juez las
vuelve a comprobar en GitHub, pero las etapas del final (revisión independiente, visto bueno, vista
previa, QA, fusión, después de fusionar y limpieza) solo existen como nombre, y el agente todavía no
puede correr la receta desde su terminal.
**Qué cambia:** esas etapas existen como bloques genéricos, `run`/`status`/`stop` leen la receta,
los agentes publican con una identidad propia de GitHub y el dueño aprueba con el botón «Approve»
(R21), con mensajes por plantilla.
**Por qué importa:** es lo que falta para que una pieza recorra el proceso completo de punta a punta
con el motor, que es lo que ensayan las rebanadas 5 y 6.

## 0. Alcance

Dentro: los bloques `independent-review`, `approval-review` (nuevo, R21), `approval-comment` (parte
local), `preview-deployment`, `browser-qa`, `github-merge`, `post-merge` y `cleanup` (§3); la
identidad de los agentes (R21, §1); los eventos publicados de constructor y veredicto (§2); el
binario conectado a la receta (§4); `required: false` y `retry` (§5); los mensajes al dueño por
plantilla (§6); lo que cambia en el juez (§7: atestaciones de revisión y aprobación, R20, notas como
aviso); `sync` para la actualización limpia registrada (§8); casos CN-06, CN-12 y CN-13 sobre estos
caminos reales (§10), con recorrido real en `ai-workflows-pruebas`.

Fuera (y dónde va): CN-07 (instalar los ganchos del editor en un proyecto y conectarlos a la
receta) pasa a la rebanada 5, que completa la suite negativa; `init` que escriba los workflows y el
sellado del SHA del motor (rebanada 6); Socialabs (R01): su receta y su cambio a la identidad de
los agentes se deciden al integrar.

## 1. La identidad de los agentes (R21)

### 1.1 Qué es

Una **aplicación de GitHub** del dueño (gratis, sin asiento), instalada en sus repositorios. Todo
lo que el motor hace en GitHub junto al agente —subir la rama, abrir el PR, publicar eventos,
comentar mensajes, armar la fusión, escribir `refs/ai-workflows/*`— sale con esa identidad
(`<slug>[bot]`). Así el PR no es del dueño y el dueño puede pulsar «Approve» (GitHub no deja
aprobar lo propio), y un agente que no tiene las llaves del dueño no puede aprobar por él.

Receta, campo nuevo opcional en la raíz:

```yaml
owner: luismichelcf                    # quien aprueba (botón o comentario)
agent-account: "mi-motor[bot]"         # la identidad con que publican los agentes (R21)
```

- `agent-account`: texto `^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$`. `validate` lo exige cuando alguna
  etapa usa `approval-review` o `independent-review`, o `sandboxed-review` con `server:
  attestation` (§2). Sin él, esas etapas no validan; `approval-comment` sigue funcionando con la
  cuenta de `gh` (el camino de hoy en Socialabs).
- `agent-account` nunca coincide con `owner`: el patrón exige el sufijo `[bot]`, que una cuenta de
  persona no puede tener.

### 1.2 Cómo obtiene el motor el permiso

- Variables de entorno del proceso del motor: `AI_WORKFLOWS_APP_ID` (número) y
  `AI_WORKFLOWS_APP_KEY_FILE` (ruta absoluta a la llave privada `.pem`, **fuera** del repositorio:
  `run` y `doctor` rechazan una ruta dentro de la raíz del proyecto).
- El motor firma un JWT RS256 con `node:crypto` (sin dependencias nuevas; `iat` = ahora − 60 s,
  `exp` = ahora + 9 min, `iss` = id), pide `GET repos/<repo>/installation` y
  `POST app/installations/<id>/access_tokens`, y usa el token de instalación (vence en 1 h) mientras
  le queden más de 5 minutos; si no, pide otro. El token llega a `gh` por `GH_TOKEN` en el entorno
  de esa sola llamada y a `git push` por la configuración en el entorno de ese subproceso
  (`GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=http.extraheader`, `GIT_CONFIG_VALUE_0=AUTHORIZATION:
  basic <base64>`): nunca en los argumentos, la URL ni el registro. Un mensaje de error nunca contiene el token ni la llave.
- La cuenta que resulta se comprueba una vez por corrida (`GET app` → `slug`); si `<slug>[bot]` no
  es `agent-account`, técnico «la llave no es de la identidad declarada».
- Con `agent-account` en la receta y sin las dos variables → `run` se niega antes de tocar nada.
  Sin `agent-account`, el motor usa la cuenta con que `gh` está autenticado (compatibilidad).
- Permisos que la aplicación necesita (se documentan y `doctor` los lee de la instalación):
  `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`, `statuses: read`,
  `deployments: read`, `actions: read`, `metadata: read`.

### 1.3 Límites que se declaran

- La llave de la aplicación vive en la PC del agente: un agente que la lea puede publicar como la
  aplicación (un veredicto falso, nivel A, igual que hoy con la cuenta del dueño). Lo que R21 cierra
  es **la aprobación del dueño**, que solo vale de la cuenta `owner` pulsando el botón (o su
  comentario).
- Eso se cumple solo si **la sesión de GitHub del dueño no está disponible para los agentes** en esa
  PC. Es un paso de instalación del dueño; `doctor` avisa si `gh auth status` muestra la cuenta
  `owner` en la máquina donde corre el motor («la cuenta que aprueba está abierta aquí: un agente
  podría aprobar por ti»). Aviso, no bloqueo: el motor no puede impedirlo (nivel A).

## 2. Eventos publicados: constructor y veredicto

Se conserva el formato probado en Socialabs (`publicar-evidencia`): un comentario **en el issue de
la pieza** (con `pieces:` la pieza es un número de issue; sin `pieces:` las etapas de este §
no validan) cuyo cuerpo es una línea legible más

```
<!-- ai-workflows:event {"version":1,"type":"builder"|"verdict", ...} -->
```

Campos JSON (exactamente estos; otro campo → el evento no vale):
`version` (1), `type`, `op` (identificador de la publicación, §2.1), `piece`, `sha` (40 hex),
`identity` `{provider, model, effort, session}` observada con `parseRun`; solo en los de constructor:
`result` (id del árbol de trabajo completo al terminar, calculado como la `snapshot` de §4.1 de la
rebanada 2); solo en veredictos:
`stage` (id de la etapa, en los de `sandboxed-review`), `angle`, `approved` (booleano), `workspace`
`{before, after}`. Además `source` (`"provider-cli"`).

**Un evento vale** si: el autor es `agent-account` (tipo `Bot`, `performed_via_github_app.slug`
igual al del nombre), nunca editado (`created_at == updated_at`), JSON exacto, `piece` igual a la
pieza, y en un veredicto `workspace.before == workspace.after`. Qué versión cubre cada evento lo
decide §2.2, no esta regla.

**Quién publica:**
- `ai-workflows build <pieza> --provider P --model M [--effort E] --prompt <archivo>`: exige árbol
  limpio, corre al constructor en la carpeta de la pieza (`mode: build`, dentro de su grupo de
  procesos como los revisores), observa su identidad con `parseRun` (sesión y modelo confirmados; si
  no, no publica y lo dice) y publica el evento `builder` con `sha` = la cabeza **al empezar** y
  `result` = el árbol que dejó (lo guardado y lo sin guardar). Si `result` es el árbol de `sha`, el
  constructor no cambió nada: se publica igual (es evidencia) pero no cuenta como construcción
  (§2.2). Lo que deja sin guardar lo guarda después el orquestador. Límite declarado (nivel A, como
  CN-02 en la rebanada 2): lo que se escriba fuera de esta orden no queda registrado, así que una
  sesión que escribió código sin `build` no queda excluida de revisar; sin ningún evento de
  constructor que haya cambiado algo, la revisión independiente se rechaza («no se sabe quién
  construyó»).
- `ai-workflows review <pieza> --angle A --provider P --model M [--effort E] --prompt <archivo>`:
  exige árbol limpio, corre al revisor en solo lectura con la huella del árbol antes y después y una
  línea `VERDICT:` exacta, y publica el evento `verdict` con `sha` = la cabeza revisada (también
  `REVISE`: un rechazo también es evidencia).
- El bloque `sandboxed-review` publica su propio veredicto aprobado como evento `verdict` con
  `stage`, dentro de `runEffect`, antes de devolver `ok`. Así su `server: attestation` tiene qué leer.

### 2.1 Publicar sin repetir

- Dentro del motor (bloque `sandboxed-review`, mensajes de §6), el `op` es determinista
  (`verdict:<stage>:<sha>`, `owner-message:…`) y es el mismo identificador del `runEffect`; la
  conciliación busca en el issue un comentario de `agent-account` con ese `op`: uno o más →
  confirmado (con el primero); ninguno → no ocurrió; lectura fallida → la etapa queda técnica.
- Fuera del motor (`build`, `review`), no hay almacén de efectos: el `op` es un UUID nuevo por
  corrida y un reintento a mano puede publicar dos veces. Es inofensivo por la regla de §2.2 (el
  más reciente de cada ángulo decide; los de constructor se suman).

### 2.2 Qué versión cubre cada evento (una sola regla, motor y juez)

- **Constructor:** **todos** los eventos `builder` válidos publicados en el issue de la pieza
  cuentan para excluir, sea cual sea su `sha` (el issue ya es la procedencia: una actualización con
  la base no los saca de la cuenta). El revisor debe ser otra ejecución que **cada uno** y, con
  `forbid-same-family`, de otra familia que cada uno: excluir de más es el lado seguro. Para que
  haya «constructor conocido» basta con que al menos uno tenga `result` distinto del árbol de su
  `sha` (cambió algo).
- **Veredicto:** cuenta para la cabeza `H` si su `sha` `S` cumple la vigencia de la etapa:
  `same-sha` → `S == H`; `same-fingerprint` → la huella de `S` contra **su propia** base de fusión
  con la principal y la de `H` contra la suya (la misma definición de §4.1 de la rebanada 2 y de
  `stillValidFor`, calculada desde commits como §2 de la rebanada 3) son iguales y no vacías; `same-fingerprint-or-clean-update` → junto al agente, `S == H` o la cadena de
  `@clean-update` de §6 de la rebanada 2 de `S` a `H` (la misma función `stillValidFor`, con `S`
  como lo juzgado); en el juez, solo `S == H` (no lee el registro). De los que cuentan, por ángulo
  decide el **más reciente** (por `created_at`): un `REVISE` posterior a un `APPROVED` rechaza.
- `requireFreshVerdicts` se llama con los veredictos que cuentan, ya presentados como de `H` (la
  relación con `H` la acaba de probar la regla anterior); su igualdad exacta de SHA sigue valiendo
  para quien la llame directo.

**El tipo declarado y el constructor en los hechos.** El CLI arma `declared(piece)` así: tipo por
`readDeclaredKind` sobre el disco (`diskProjectFiles`, §1.1 de la rebanada 3); constructores = los
eventos `builder` de la pieza según §2.2 (`ChangeFacts.builder` pasa a `builders`, una lista; la
de un elemento sigue sirviendo a `sandboxed-review`, que exige distinto de todos). La lectura del
issue falla → la corrida queda `blocked:technical` con motivo, nunca sin constructor en silencio.

## 3. Los bloques

Todos: motivos en es/en según `locale`; nada propio de un proyecto (rutas, nombres de ambientes,
comandos y criterios llegan por `with:`); todo efecto por `runEffect`; toda llamada a GitHub con la
identidad de §1 y tope de 120 s; en `dry-run` no publican ni cambian nada (lo dicen).

### 3.0 El PR de la pieza

Función compartida `pullRequestOf(piece, sha, { create })`:
1. Rama = la rama actual del árbol de la pieza (`git symbolic-ref --short HEAD`; cabeza suelta →
   técnico). Debe dar esta pieza por R19; si no, técnico.
2. Lee la lista **completa** de PRs de esa rama en todos los estados (se conserva entera). La
   **procedencia** (autor `agent-account` cuando está declarado, cabeza del mismo repositorio, base =
   la principal) se usa solo para **elegir** un PR fusionado o reutilizable, nunca para ocultar uno.
   Si de los `MERGED` con `headRefOid == sha` exactamente uno tiene procedencia, lo devuelve sin
   subir nada (reanudar tras una fusión que ocurrió con el motor caído); más de uno → técnico.
3. Sube el `sha` juzgado a esa rama sin forzar (`git push origin <sha>:refs/heads/<rama>`) en
   `runEffect('push:<rama>:<sha>')`. Si la rama remota tiene commits que no están en `sha` → rechazo
   «la rama en GitHub tiene cambios que no están aquí» (se resuelve con `sync`, §8).
4. De los PRs **abiertos** de la lista completa: más de uno → técnico. Uno que no pasa la
   procedencia → rechazo «este PR lo abrió <cuenta> (o apunta a otra base u otro repositorio);
   ciérralo para que el motor abra uno propio (el dueño no puede aprobar lo suyo)», **sin** intentar
   crear otro. Uno que pasa → se usa. Un PR de `agent-account` en esa rama, **abierto o cerrado**,
   sin la marca de ninguna operación (alguien la borró del cuerpo) → técnico «no se sabe si este PR
   es del motor (PR #N)», nunca se abre otro. Salida documentada (README): continuar la pieza en una
   rama nueva que siga dando la misma pieza por R19 (p. ej. `feat/13-algo-2`), sin tocar el PR
   viejo; el motor nunca trata la falta de marca como prueba de que no lo creó. Ninguno y
   `create` → `runEffect('open-pr:<rama>:<sha>')` lo crea en borrador (título = el del issue de la
   pieza; cuerpo = `Refs #<pieza>` más la marca `<!-- ai-workflows:op open-pr:<rama>:<sha> -->`).
5. Exige `head == sha` y estado `OPEN`; si no, técnico «el PR no apunta a esta versión».

La crea el primer bloque que la necesita (`approval-review`, `approval-comment`, `browser-qa` o
`github-merge`); las demás la encuentran.

### 3.0.1 Cada efecto externo y cómo se concilia

Los bloques del motor ganan en `BlockDefinition` un `reconcile(operationId, context)` opcional con
la misma semántica que el de un bloque módulo (§5 de la rebanada 2): el envoltorio lo llama al
recibir `EffectNeedsReconciliation` y, con respuesta, llama a `store.reconcileEffect` y vuelve a
correr el bloque una sola vez. Los mensajes de §6, que se publican fuera de un gate, usan el mismo
conciliador desde `run`.

| Efecto (`operationId`) | Marca externa | Confirmado si… | No ocurrió si… |
|---|---|---|---|
| `push:<rama>:<sha>` | actividad del repositorio (`GET repos/<repo>/activity?ref=refs/heads/<rama>`: tipo, actor, `before`, `after`) | hay una actividad de `agent-account` en esa rama con `after == sha` (aunque después alguien la haya borrado o movido: no se vuelve a subir, y el bloque rechaza «la rama cambió en GitHub») | no hay ninguna actividad de `agent-account` con `after == sha` **y** la punta actual es ancestro de `sha` o la rama no existe |
| `open-pr:<rama>:<sha>` | PR de esa rama, de `agent-account`, con la marca de **esa** operación en el cuerpo | hay exactamente uno (cualquier estado; si está cerrado, el paso 5 de §3.0 lo dice) | no hay ninguno con esa marca **y** ningún PR de `agent-account` en esa rama carece de marca (uno sin marca, abierto o cerrado, → técnico) |
| `ready:<pr>:<sha>` | historia del PR (`ReadyForReviewEvent`) | hay uno hecho por `agent-account` después del último cambio de cabeza (aunque ahora vuelva a estar en borrador: alguien lo devolvió, y el bloque lo rechaza «el PR volvió a borrador» en vez de marcarlo otra vez) | no hay ninguno y está en borrador |
| `merge:<pr>:<sha>` | historia del PR (`timelineItems`: `AutoMergeEnabledEvent`, `AddedToMergeQueueEvent`, `MergedEvent`) | hay un evento de armado o de entrada a la cola hecho por `agent-account` **después** del último cambio de cabeza, o está `MERGED` (aunque ahora esté desarmado: alguien lo desarmó, y la observación lo rechaza en vez de volver a armar) | no hay ninguno de esos eventos y está abierto |
| `verdict:<stage>:<sha>` | comentario con ese `op` | hay uno o más | no hay |
| `owner-message:<tipo>:<clave>` | comentario con ese `op` | hay uno o más | no hay |
| `delete-branch:<rama>:<sha>` | actividad del repositorio (`branch_deletion` en esa rama) | hay un borrado de `agent-account` con `before == sha` (aunque alguien la haya recreado: no se vuelve a borrar, y la evidencia lo dice) | no hay ese borrado **y** la punta actual es `sha` |

Regla general: cada acto se busca en la historia **anclado a este intento** (el `sha` exacto en
`push` y `delete-branch`; después del último cambio de cabeza en `ready` y `merge`, que solo esas
operaciones hacen), así un acto viejo nunca confirma uno nuevo. Historia incompleta → técnico. «No ocurrió» exige **dos**
cosas, la ausencia en la historia anclada de un acto de `agent-account` y un estado actual
compatible con que nunca pasó; si la historia muestra el acto,
es «confirmado» aunque el estado actual lo contradiga (alguien lo deshizo a mano, y se respeta).
Cualquier otra lectura (varios PRs, una punta distinta sin historia, historia no confirmable,
lectura fallida) → la etapa queda técnica nombrando el efecto, nunca se repite a ciegas. **Se concilia solo con la
reserva de la pieza en la mano** (dentro de un gate ya la tiene; fuera, §6): un efecto `pending`
de una sesión que sigue viva nunca se concilia, porque su reserva lo impide. Cada fila tiene su prueba de caída **antes** y
**después** de la llamada externa (§10).

### 3.1 `independent-review@1` — execution-record + attest (§1.1 del plan)

Entradas: `angles` (lista, obligatoria, al menos una), `forbid-same-family` (por omisión `true`).
Lee los eventos del issue (§2) y exige, como `compuertaParvada` de Socialabs: árbol limpio; al menos
un evento de constructor de la pieza (§2.2); por cada ángulo, el veredicto que decide (§2.2) de otra
ejecución que **cada** constructor (`requireDifferentBuilder`, R18: proveedor + sesión), de otra
familia que cada uno si se pide, con `workspace` igual antes y después; y `requireFreshVerdicts`
sobre esos veredictos con `{ angles }` (todos terminados, ninguno con bloqueantes, cada ángulo
cubierto). Un `REVISE` que decide rechaza con su texto. Vigencias permitidas: `same-sha`,
`same-fingerprint`, `same-fingerprint-or-clean-update`, con la regla única de §2.2.
Evidencia: `{ builders, verdicts: [{angle, provider, model, session, sha}] }`.

**Servidor (`attestation`):** la misma función de decisión (compartida, sin `providers` ni
almacén), sobre los comentarios del issue de la pieza, con la cabeza del PR como `H` y las huellas
calculadas desde commits contra el commit confiable; `same-fingerprint-or-clean-update` solo acepta
`S == H` (§2.2).

### 3.2 `approval-review@1` — attest (R21, nuevo)

Manifiesto: naturalezas `attest`; vigencias `same-sha`, `same-fingerprint`,
`same-fingerprint-or-clean-update`; `server: [attestation, require-check]`; sin entradas.
`validate` exige `owner` y `agent-account`.

Una sola función de decisión para el motor y el juez, sobre `reviews(pr)` del puerto (se añade a
`JudgeGitHub`): `{ author, authorType, state, commitId, submittedAt }` en orden de envío, paginado.
- Se toma la **última** revisión de `owner` (cuenta `User`) con estado `APPROVED`,
  `CHANGES_REQUESTED` o `DISMISSED` (los `COMMENTED` no cuentan). Si es `APPROVED` y su `commitId`
  nombra una versión que la vigencia acepta (mismas reglas que §3.6 de la rebanada 3: `same-sha` la
  cabeza; `same-fingerprint` la cabeza o un candidato con la misma huella no vacía, incluidas las
  cabezas reemplazadas por force push; `…-or-clean-update` solo la cabeza) → pasa.
- Si no → `waiting` con `needs-human` (`rejected` sin él). El motivo dice «Aprueba el cambio en
  GitHub con el botón “Approve”: <enlace del PR>» y, si hubo una aprobación de otra versión, lo dice.
- Una lectura fallida → técnico, nunca rechazo.
- Junto al agente: `pullRequestOf(create: true)`, la decisión, y al quedar esperando el mensaje
  `approval` (§6). Evidencia: `{ pr, reviewedCommit, submittedAt }`.
- Recomendado (documentado, no exigido por el juez): protección con 1 aprobación, «descartar
  aprobaciones viejas» y «aprobar el último push». El juez decide por su cuenta con `commitId`.

### 3.3 `approval-comment@1` — parte local

La misma decisión que su parte del servidor (`approvalCommentAttestation`), llamada junto al agente
con un puerto sobre `gh` y el commit confiable = `origin/<principal>` después de `git fetch`. PR por
`pullRequestOf(create: true)`. Esperando → mensaje `approval` con la orden exacta.

### 3.4 `preview-deployment@1` — recompute

Entradas: `environment` (texto, obligatorio, p. ej. `Preview`), `creator` (texto opcional, p. ej.
`vercel[bot]`), `url-pattern` (texto opcional: glob sobre el host, p. ej. `*.vercel.app`).
`GET deployments?sha=<sha>&environment=<environment>` (paginado); de los que tienen `sha` exacto (y
`creator` si se pide), el de id mayor; su estado más reciente (`deployments/<id>/statuses`, el
primero) debe ser `success` con `environment_url` (o `target_url`) `https://` que case con
`url-pattern`. Sin despliegue o no listo → rechazo «la vista previa de esta versión aún no está
lista» (con `retry` la receta decide cuánto esperar, §5); `failure`/`error` → rechazo que lo nombra.
Evidencia `{ deployment, url, sha }`. Vigencia: `same-sha`. La comprobación de salud propia de un
proyecto (Socialabs `/api/health`) es un bloque del proyecto.

### 3.5 `browser-qa@1` — recompute

Entradas: `command` (obligatoria, reglas de §1.4 de la rebanada 2), `preview-stage` (id de una
etapa anterior que usa `preview-deployment`; `validate` lo exige), `criteria` (objeto obligatorio
`{file, section, id-prefix}`, como `spec-structure`), `pass-env` (lista de nombres de variables
del entorno del motor que el comando necesita, p. ej. contraseñas de cuentas de prueba; ninguna otra
pasa), `timeout-minutes` (1…120, por omisión 30).
1. PR por `pullRequestOf(create: true)`; criterios = identificadores `<prefix>\d{2}` de la sección.
   Ninguno → rechazo.
2. URL = evidencia de la última entrada `passed` de `preview-stage` en el diario, que debe ser del
   mismo `sha`; si no, rechazo.
3. Corre `command` en su grupo de procesos con un entorno **nuevo**: `PATH` y lo mínimo del sistema,
   `pass-env`, y `AI_WORKFLOWS_PREVIEW_URL`, `AI_WORKFLOWS_PIECE`, `AI_WORKFLOWS_SHA`,
   `AI_WORKFLOWS_CRITERIA` (JSON), `AI_WORKFLOWS_REPORT_DIR`: una carpeta **nueva y vacía fuera del
   árbol de la pieza** (`mkdtemp` en la carpeta temporal del sistema), creada por el motor, que el
   motor borra al terminar (también si falla). El motor nunca vacía una carpeta que no creó. Si el
   comando escribe dentro del árbol, el sellado lo detecta y la etapa queda técnica (§2.3 de la
   rebanada 2).
4. Lee esa carpeta: exactamente un `<ID>.json` por criterio (sobra o falta uno → rechazo que los
   nombra), cada uno `{ "status": "passed" | "failed", "assertions": <entero>, "evidence"?: {...} }`
   con `passed` y `assertions >= 1`. Salida distinta de 0 → rechazo con la cola de su salida.
5. Vuelve a leer el PR: abierto y con la misma cabeza.
Evidencia `{ pr, url, criteria: {ID: sha256 del reporte} }`. Vigencia: `same-sha` (ya en el
manifiesto). Capturas, accesibilidad y cuentas son cosa del proyecto (van en su `evidence`).

### 3.6 `github-merge@1` — recompute, fase `merge`

Entradas: `method` (`merge` · `squash` · `rebase`, por omisión `merge`), `timeout-minutes` (1…1440,
por omisión 360), `poll-seconds` (10…300, por omisión 30).
1. PR por `pullRequestOf(create: true)`: si ya está `MERGED` con `headRefOid == sha`, pasa (§3.0
   paso 2, antes de cualquier subida). Si está en borrador, `gh pr ready` en
   `runEffect('ready:<pr>:<sha>')`.
2. En `runEffect('merge:<pr>:<sha>')`: `gh pr merge <n> --auto --<method> --match-head-commit <sha>`
   (con la cola nativa, GitHub lo forma en la cola). Se relee: debe tener `autoMergeRequest` o una
   entrada en la cola (`mergeQueueEntry` por GraphQL).
3. Observa cada `poll-seconds` hasta `timeout-minutes`, cancelable, leyendo estado, cabeza,
   `autoMergeRequest` y `mergeQueueEntry`: `MERGED` → pasa; la cabeza cambió o se cerró → rechazo
   que lo dice; abierto **sin** fusión automática **y sin** entrada en la cola en dos lecturas
   seguidas (salió de la cola o alguien desarmó la fusión) → rechazo que lo dice; tope → rechazo «la
   fusión no terminó en N minutos» (la cola sigue su curso; la siguiente corrida vuelve a observar
   sin armar de nuevo, porque el efecto está confirmado).
Evidencia `{ pr, headSha, mergeSha: mergeCommit.oid, mergedAt }`. Vigencia `same-sha`.
Un error de lectura durante la observación se reintenta en la siguiente vuelta (hasta 3 seguidos;
el cuarto es técnico).

### 3.7 `post-merge@1` — recompute, fase `post-merge`

Entradas: `merge-stage` (id de la etapa `github-merge`; `validate` lo exige), `checks` (lista de
nombres de check o estado que deben quedar en verde sobre el commit de la fusión), `deployment`
(objeto opcional `{environment, creator?}`).
Lee `mergeSha` de la última entrada `passed` de `merge-stage`. Por cada nombre de `checks`: la
misma regla de §3.4 de la rebanada 3 (decide el más reciente; sin terminar → rechazo «todavía
corre»; terminado distinto de `success` → rechazo que lo nombra). `deployment`: la regla de §3.4 de
aquí sobre `mergeSha`. Condiciones por rutas (p. ej. migraciones) se expresan con otra etapa
`post-merge` y `applies-if`. Evidencia `{ mergeSha, checks, deployment? }`. Con `retry` se espera.

### 3.8 `cleanup@1` — recompute, fase `post-merge`

Entradas: `merge-stage` (obligatoria), `delete-branch` (por omisión `true`), `remove-folder` (por
omisión `true`). Cerrar el issue de la pieza **no** es parte del bloque (§4.1 del plan pide carpeta,
rama, procesos hijos y reservas): el proyecto que lo quiera lo hace con un bloque propio (Socialabs,
en la rebanada 6).
En el gate: exige la fusión registrada; borra la rama remota solo si su punta es la cabeza fusionada
(`git push origin --delete` con `--force-with-lease=<rama>:<headSha>`, en `runEffect`); libera las
zonas que la pieza tenga reservadas.
Recurso ya ausente → se salta (se puede repetir). Evidencia (el único esquema que lee `finish`):
`{ branch, headSha, mergeSha, folder, removeFolder }`.
**La carpeta y la rama local no las borra el gate** (el motor corre dentro de la carpeta y la
vuelve a leer para sellar). Lo hace `ai-workflows finish <pieza>`, que `run` llama solo al terminar
en `done` y que también se puede correr a mano **desde la copia principal** (así una caída a mitad
se retoma aunque la carpeta ya no exista):
1. Reserva la pieza (como `run`; si otra sesión la tiene → no toca nada y lo dice), mantiene el
   latido durante todo `finish` y la suelta al final. Lee del almacén que la pieza está `done` y la
   evidencia de `cleanup` (esquema de arriba); sin ellas, no toca nada. `done` cierra la pieza: una
   etapa opcional que falló queda como está en el diario y en `status` («falló, no bloquea») y **no**
   se vuelve a intentar después de `finish` (sin carpeta no hay dónde); `run` sobre una pieza cuya
   carpeta ya se retiró se niega y lo dice.
2. Carpeta: si existe, debe ser un *worktree* enlazado de este repositorio (nunca la copia
   principal), sin cambios sin guardar y con `HEAD == headSha`; entonces `git worktree remove` sin
   forzar, ejecutado con `cwd` en la copia principal. Si ya no existe, se repara **solo** su registro: se busca en `git worktree list
   --porcelain` la entrada con esa ruta; si su archivo `gitdir` en `.git/worktrees/<nombre>/` apunta
   exactamente a `<carpeta>/.git`, se borra esa carpeta de administración y nada más. Nunca `git
   worktree prune` (limpiaría los registros de otras piezas cuya carpeta esté en una unidad
   desconectada).
3. Rama local: si existe y su punta es `headSha` (la cabeza que GitHub fusionó, sea cual sea el
   método), `git branch -D`; si su punta es otra, no se toca y se dice. Si ya no existe, nada.
4. Cada paso ya hecho se salta, así que repetir `finish` termina lo que faltaba. Cuando `run` lo
   llama desde la carpeta que va a retirar, el proceso primero se muda a la copia principal
   (`process.chdir`) y no deja nada abierto dentro de ella: en Windows una carpeta con algo abierto
   no se borra. Un fallo no cambia
   `done`, pero la orden sale con error y dice qué quedó y cómo terminarlo.

## 4. El binario conectado a la receta

- `ai-workflows run|status|stop|pause|resume|doctor|build|review|sync|finish` en `bin.ts`, además
  de los que ya existen. `run`, `build`, `review` y `sync` leen `.ai-workflows/pipeline.yml` de la
  raíz (git `--show-toplevel`) con `checkRecipe`; receta inválida → se niegan con
  archivo:línea:columna, sin tocar el almacén.
- **Las órdenes de control nunca dependen de la receta:** `stop`, `pause`, `resume`, `status` y
  `finish` solo necesitan el almacén (el repositorio de `origin`) y la identidad (§1.2, si están las
  variables; si no, la cuenta de `gh`). Si la receta se lee, toman de ella `locale`; si no se lee o
  es inválida, hablan en inglés y lo avisan en una línea, pero **paran igual**. Así una receta rota
  a mitad de una corrida nunca impide frenarla.
- `run <pieza>`: la pieza debe ser la de la rama actual (R19; sin `pieces:`, cualquiera). Almacén =
  `createGitStore` sobre `createGitHubStatePort` del repositorio de `origin`, con la identidad de §1,
  arrendamiento de 15 min. `baseRef` = `origin/<principal>` después de `git fetch origin
  <principal>` (principal de la API). `compileRecipe` + `createEngine` con todo lo que devuelve
  (`describeChange`, `confirmFacts`, `confirmQuarantine`) y `runCommand`. Tras el resultado, los
  mensajes (§6) y el borrado de carpeta (§3.8).
- `status`, `stop`, `pause`, `resume`: lo mismo sin compilar bloques que no hacen falta; toda salida
  pasa por `safeTerminalText` (pendiente de §12 del plan), también los motivos y los nombres de pieza.
- `doctor`: versión de git (≥ 2.38), `gh` autenticado, receta válida, identidad de §1 (llave fuera
  del repo, cuenta que resulta, permisos de la instalación) y el aviso de §1.3.
- `CommandOptions` gana `hooks` opcional para lo que pasa después de `run` (mensajes y carpeta), de
  modo que las pruebas del CLI existentes no cambian.

## 5. `required: false` y `retry` en el motor

- `StageConfig` gana `required?: boolean` (verdadero por omisión) y `retry?: { attempts,
  waitMs }`; `compileRecipe` deja de rechazarlos y los pasa.
- **`retry`:** cuando el gate rechaza (`ok: false`) o lanza un error ordinario, se vuelve a correr
  hasta `attempts` veces en total, esperando `waitMs` entre intentos con la señal de cancelación
  (parar durante la espera termina como parada, no como fallo) y el latido del arrendamiento vivo.
  No se reintentan: `ok: 'skipped'`, `needs-human` esperando, `ProcessTreeSurvived`,
  `EffectNeedsReconciliation`, `EffectRefusedBecauseParked`, `LeaseLost` ni fallos del almacén. Solo
  el último intento se registra en el diario, con «tras N intentos» en el motivo.
- **`required: false`:** si la etapa termina rechazada (`ok: false`) o su gate lanza un error
  ordinario, se registra así (`rejected`/`failed` con su motivo) y la pieza **sigue** con la
  siguiente etapa; `status` la muestra como «falló, no bloquea». Una etapa opcional fallida **no**
  queda resuelta: se vuelve a intentar en cada corrida **hasta `finish`** (el motor sigue
  reutilizando solo `passed` y `skipped` vigentes; después de `finish` la pieza está cerrada, §3.8),
  y nunca bloquea. **Siguen bloqueando aunque la etapa sea opcional:**
  `ProcessTreeSurvived` (cuarentena), `EffectNeedsReconciliation` (efecto en duda), un fallo del
  almacén y la pérdida del arrendamiento. `validate` rechaza `required: false` con `needs-human:
  true` (esperar a una persona y no bloquear se contradicen) y en la etapa `phase: merge`.
- `explain` ya describe ambos.

## 6. Mensajes al dueño por plantilla (D53, D54 de PLAN-997)

Sección nueva y opcional de la receta:

```yaml
messages:
  summary: { file: "docs/plans/PLAN-{piece}.md", section: "En tres líneas" }
  max-length: 700                      # por omisión 700
  banned-words: ["pipeline", "sha"]    # se suman a DEFAULT_BANNED_TERMS
```

- Plantillas fijas del motor, en es/en: `start` (primera corrida de la pieza), `approval` (espera la
  aprobación: enlace y qué pulsar o escribir), `question` (espera una decisión: el motivo), `blocked`
  (rechazo o fallo: qué pasó en palabras llanas; el detalle técnico no va), `close` (fusionada).
- Cada mensaje empieza con las tres líneas del resumen de la pieza (las tres primeras líneas no
  vacías de la sección, sin adornos de Markdown); si no existen, sin ellas y con una nota al final.
- El texto final se comprueba con `findBannedTerms` y el largo; si falla, se envía la versión mínima
  de la plantilla (sin el motivo libre), y si aun así falla, no se envía y `run` lo dice. Lo que viene
  del proceso (motivos, títulos) pasa por `safeTerminalText` y escape de Markdown.
- Entrega: comentario en el issue de la pieza con la identidad de §1 y la marca
  `<!-- ai-workflows:message {"op":"…"} -->`, en `runEffect(op)` con
  `op = owner-message:<tipo>:<clave>`: clave = etapa + sha para `approval` y `question`; etapa + sha
  + los 12 primeros hex del sha256 del motivo para `blocked` (dos fallos distintos, dos avisos; el
  mismo fallo repetido, uno); la pieza para `start` y `close`. Se concilia por la marca (§3.0.1). El
  detalle técnico queda en el resultado del efecto, no en el comentario.
- **Con la reserva en la mano:** los mensajes que dependen del resultado (`approval`, `question`,
  `blocked`, `close`) se envían después de que el motor devuelve, así que `run` vuelve a reservar la
  pieza con su mismo `runId` antes de enviar (y concilia un mensaje `pending` solo entonces). Si otra
  sesión la tomó en ese instante, no envía nada y lo dice: la otra sesión enviará los suyos. Con la
  reserva en la mano **vuelve a leer** estado, etapa y última entrada del diario de esa etapa, y los
  hechos (`sha`); envía solo si siguen siendo exactamente los que motivaron el mensaje (misma etapa,
  mismo estado, misma entrada por `at` y `runId`, mismo `sha`). Si otra corrida avanzó mientras
  tanto, no envía nada: el aviso ya no corresponde. `start` se envía dentro de la corrida, antes de la
  primera etapa.
- Sin `messages:` no se envía nada (compatibilidad); `run` imprime lo mismo en la terminal siempre.

## 7. Cambios en el juez

- **Atestaciones que faltaban:** `independent-review` (§3.1) y `sandboxed-review` (su evento con
  `stage`, mismas reglas de §2 y de independencia) ganan `server.attestation`; `approval-review`
  (§3.2) también. El motivo «llega en la rebanada 4» desaparece.
- El puerto gana `reviews(pr)` e `issueComments(n)` (con `author`, `authorType`, `viaApp`,
  `createdAt`, `updatedAt`, paginados; lectura no confirmable → lanza).
- **R20:** `/approve-judge-change` exige al menos 16 caracteres (prefijo de la cabeza). El motivo
  muestra los 16.
- **Notas del rastro** como `::warning::` (no `::error::`) cuando la corrida publica verde o espera.
- Permiso nuevo del juez en la plantilla: ninguno (`issues: read` y `pull-requests` ya están).

## 8. `sync`: la actualización limpia registrada

`ai-workflows sync <pieza>`, en este orden:
1. La rama actual debe dar esta pieza (R19), como en `run`; si no, se niega sin tocar nada.
   Reserva la pieza en el almacén con su propio `runId` (la misma reserva que `run`; si otro la
   tiene → «otra sesión la tiene», sin tocar nada), mantiene el latido mientras trabaja y la suelta
   al final, también si falla. **Antes de cada escritura** (cada registro del paso 4) y antes del
   paso 5 renueva la reserva; si la renovación falla o la tiene otro, se detiene sin seguir.
2. Árbol con cambios sin guardar → se niega. `git fetch` de la rama remota y de la principal.
3. Si la punta remota ya es la cabeza local → nada. Si no, verifica **toda** la cadena antes de
   mover nada: cada commit nuevo, de la cabeza local a la punta remota, es una fusión limpia con la
   base en la forma exacta de §6 de la rebanada 2 (primer padre = el paso anterior, segundo padre en
   la principal, árbol = la fusión recalculada con `git merge-tree`). Un solo paso que no cumple →
   no toca nada y lo dice («en GitHub hay cambios que no son una actualización limpia»).
4. Escribe todos los registros con `recordCleanUpdate` (el privilegio que solo tiene el código del
   motor) **antes** de mover la cabeza; `recordCleanUpdate` se vuelve idempotente (un registro igual
   ya presente no se duplica).
5. `git merge --ff-only <punta remota>`.
Una caída entre 4 y 5 deja registros de una cadena válida y la cabeza sin mover: inofensivo, y
repetir `sync` termina. Una caída a mitad de 4 deja parte de los registros: repetir `sync` completa
los que faltan. Así `same-fingerprint-or-clean-update` conserva la revisión cuando GitHub actualiza
la rama con la base (botón «Update branch»).

## 9. Interfaces que fijan las pruebas

```ts
// src/agent/identity.ts (R21)
interface AgentCredentials { appId: number; keyFile: string }
createAppTokenSource(o: { credentials; repository; fetch?: typeof fetch; now?: () => number })
  : { token(): Promise<string>; account(): Promise<string> };          // `<slug>[bot]`
agentCredentialsFromEnv(env, projectRoot): AgentCredentials | { missing: string } | { refused: string };

// src/agent/events.ts (§2)
type PieceEvent = BuilderEvent | VerdictEvent;
parseEventComment(c: IssueComment, rules: { agentAccount: string }): PieceEvent | { invalid: string } | undefined;
renderEventComment(e: PieceEvent, locale: string): string;
readPieceEvents(github: Pick<AgentGitHub, 'issueComments'>, piece: number, rules): Promise<PieceEvent[]>;

// src/agent/github.ts — el borde con GitHub junto al agente, sobre createGhRunner
interface AgentPullRequest {
  number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean;
  headSha: string; headRef: string; headRepo: string; baseRef: string; author: string; body: string;
  mergeCommit: string | null; autoMerge: boolean; inMergeQueue: boolean;
}
type PullRequestHistoryItem =
  | { type: 'ready' | 'auto-merge-enabled' | 'added-to-queue' | 'merged' | 'head-changed'; actor: string | null; at: string };
interface AgentGitHub extends Pick<JudgeGitHub, 'defaultBranch' | 'reviews' | 'issueComments' | 'comments' | 'checkRuns' | 'statuses' | 'forcePushedHeads'> {
  pullRequestsOfBranch(branch: string): Promise<AgentPullRequest[]>;        // todos los estados, paginado; lanza si no es confirmable
  pullRequestDetail(n: number): Promise<AgentPullRequest>;
  pullRequestHistory(n: number): Promise<PullRequestHistoryItem[]>;          // timelineItems paginado completo; lanza si no es confirmable
  branchActivity(branch: string): Promise<{ type: string; actor: string | null; before: string; after: string; at: string }[]>; // GET activity, paginado; lanza si no es confirmable
  createDraftPullRequest(o: { branch; base; title; body }): Promise<number>;
  issueTitle(n: number): Promise<string>;
  markReady(pr: number): Promise<void>;
  enableAutoMerge(pr: number, o: { method; headSha }): Promise<void>;
  deployments(sha: string, environment: string): Promise<{ id: number; sha: string; creator: string }[]>;
  deploymentState(id: number): Promise<{ state: string; url: string | null } | undefined>;
  commentOnIssue(n: number, body: string): Promise<number>;
}

// src/approval/review.ts (§3.2), usada por el bloque y por el juez
decideReviewApproval(o: { reviews; owner; head; validWhile; needsHuman; locale; prUrl;
  sameFingerprint(commit: string): Promise<boolean> }): Promise<ServerResult>;

// src/blocks/pull-request.ts (§3.0)
pullRequestOf(piece: string, sha: string, o: { create: boolean; context: GateContext; deps: FinalBlockDeps }): Promise<{ number: number; url: string }>;

// src/messages.ts (§6)
renderOwnerMessage(kind: 'start' | 'approval' | 'question' | 'blocked' | 'close',
  o: { locale; summary?: readonly string[]; detail?: string; link?: string; maxLength; banned }): { text: string } | { refused: string };

// src/engine.ts — StageConfig
required?: boolean;  retry?: { attempts: number; waitMs: number };

// src/blocks/definition.ts — BlockDefinition (§3.0.1)
reconcile?(operationId: string, context: GateContext): Promise<{ confirmed: JsonValue } | { didNotHappen: true } | undefined>;

// src/recipe/facts.ts — ChangeFacts: `builder?` pasa a `builders: readonly ChangeBuilder[]` (§2.2)

// src/agent/finish.ts (§3.8)
finishPiece(o: { mainRoot: string; piece: string; store: Store; locale: string }): Promise<{ ok: boolean; text: string }>;

// src/agent/events.ts (§2.2), usada por el bloque y por el juez
selectVerdicts(o: { events: PieceEvent[]; head: string; validWhile: ValidWhile; angles: readonly string[];
  accepts(sha: string): Promise<boolean> }): Promise<{ builders: ExecutionIdentity[]; deciding: VerdictEvent[] }>;
```

`FinalBlockDeps` = `EngineBlockDeps` + `github: AgentGitHub` + `git` (push con cabecera) + `sleep`
inyectable. Las pruebas de los bloques usan un `AgentGitHub` falso (borde externo), git real y el
almacén en memoria. El puerto real (`createAgentGitHub` sobre `createGhRunner`) se prueba **con la
misma implementación** de dos formas: sobre un `gh` falso que devuelve respuestas grabadas de GitHub
(paginación incompleta, página extra, campos ausentes → lanza) y contra `ai-workflows-pruebas`. Los nombres de módulos pueden
cambiar si el constructor lo necesita; las firmas son las que usan las pruebas.

## 10. Casos y pruebas

Cada caso: motivo, estado resultante y ausencia de efectos, con su control positivo.

| Caso | Prueba local (en la CI) | Recorrido real en `ai-workflows-pruebas` |
|---|---|---|
| CN-13 | `github-merge` abre el PR; el motor muere tras crearlo y antes de registrarlo; al reanudar concilia por la rama y no abre otro (se cuentan PRs en el puerto falso); sin conciliación posible (dos PRs) → técnico que nombra el efecto. Igual para `merge:<sha>` y para un mensaje al dueño. Positivo: exactamente uno | sí: el proceso se mata a propósito tras crear el PR; la segunda corrida lo encuentra |
| CN-12 | Dos `ai-workflows run` de la misma pieza a la vez sobre el almacén de GitHub en memoria (`StatePort` falso compartido): uno trabaja, el otro sale con «otra sesión la tiene» y no escribe diario ni efectos. Positivo: uno solo | sí: dos procesos reales contra el almacén del repositorio de pruebas |
| CN-06 | Corte al escribir el diario durante la observación de `github-merge` (el almacén falla una vez): la segunda corrida retoma, no vuelve a armar la fusión (efecto confirmado) y termina. El PR se fusiona mientras el motor está caído: la corrida siguiente lo reconoce `MERGED` antes de subir nada y pasa. Positivo sin corte | — |
| §3.0.1 | Por **cada** fila de la tabla: caída antes de la llamada externa (el conciliador responde «no ocurrió» y se hace una vez) y después (responde «confirmado» y no se repite); lectura ambigua → técnico que nombra el efecto | — |
| §3.0 | PR abierto por el dueño en la rama → rechazo con el motivo y ningún intento de crear otro (el puerto falso lo cuenta); PR desde un fork o hacia otra base → no se usa; dos PRs abiertos → técnico; rama remota con commits ajenos → rechazo que manda a `sync`; PR `MERGED` de la rama hacia otra base, o abierto por otra cuenta → no hace pasar `github-merge` ni alimenta `post-merge`; dos `MERGED` válidos → técnico | — |
| §3.0.1 historia | PR viejo cerrado de la misma rama con la marca de otra operación y caída antes de crear el nuevo → «no ocurrió», se crea uno; PR abierto de la aplicación sin marca → técnico, no se abre otro; el dueño devuelve el PR a borrador entre `ready` y su conciliación → confirmado, rechazo «volvió a borrador», no se marca otra vez; alguien borra o mueve la rama entre `push` y su conciliación → confirmado por la actividad, no se vuelve a subir y el bloque rechaza; alguien recrea la rama en el mismo SHA entre `delete-branch` y su conciliación → confirmado, no se vuelve a borrar; caída tras crear el PR y alguien le quita la marca y lo cierra → técnico, nunca un segundo PR (CN-13); el dueño desarma la fusión entre el efecto y la conciliación → «confirmado» (por la historia) y la observación rechaza «alguien desarmó la fusión», sin volver a armar; historia ilegible → técnico | — |
| Reserva fuera del gate | Dos procesos en la ventana entre el fin de `run` y el envío del mensaje: solo el que tiene la reserva envía o concilia; el otro no envía y lo dice; nunca dos comentarios. Carrera en secuencia: la corrida A termina esperando aprobación, la B toma la pieza, recibe la aprobación y avanza; A vuelve a reservar → no envía «aprueba» | — |
| Puerto real | `createAgentGitHub` sobre un `gh` falso con respuestas grabadas: historia en varias páginas se lee entera; página que falta o `hasNextPage` incoherente → lanza; campos ausentes → lanza | las mismas lecturas contra el repositorio de pruebas |
| §2.2 | Constructor en dos tandas (dos eventos): el revisor de cualquiera de las dos sesiones se rechaza; `build` → commit del orquestador → `review` → pasa (el evento del constructor apunta al commit de partida); `build` que no cambió nada como único evento → «no se sabe quién construyó»; constructor seguido de un `sync` que mueve la base de fusión → sigue excluido; la pieza cambia `foo`, la principal añade `bar` y la pieza lo incorpora limpio: con `same-fingerprint` el veredicto anterior sigue contando en motor y juez (cada huella contra su propia base); veredicto de `S` con la misma huella que `H` cuenta con `same-fingerprint` y no con `same-sha`; con `…-or-clean-update` cuenta junto al agente tras un `sync` registrado y no en el juez; `REVISE` posterior a un `APPROVED` del mismo ángulo rechaza; motor y juez dan lo mismo sobre la misma tabla | — |
| R21 | JWT firmado con una llave de prueba y verificado con su pública; token reutilizado hasta 5 min antes de vencer; llave dentro del repo → rechazo; cuenta distinta de `agent-account` → técnico; el token nunca aparece en un error; `validate` exige `agent-account` y lo distingue de `owner` | la aplicación real sube la rama, abre el PR y comenta; el autor que muestra GitHub es `<slug>[bot]` |
| §2 | Evento válido; editado, de otra cuenta, de la app equivocada, con campo extra, de otra pieza → no vale; veredicto de un SHA que no cumple la vigencia (§2.2) → no cuenta; `build` y `review` publican solo con identidad observada; revisor que escribe el árbol → veredicto `approved: false` publicado y el bloque no pasa | `review` real publica en el issue de prueba |
| `independent-review` | Constructor ausente; revisor de la misma sesión con otro modelo (R18); misma familia; ángulo sin cubrir; veredicto de otro SHA; `REVISE`; positivo con dos ángulos de otra familia. Servidor: lo mismo leído por el juez; `…-or-clean-update` solo la cabeza | el juez aprueba con los eventos reales y rechaza sin ellos |
| `approval-review` | Última revisión del dueño `APPROVED` de la cabeza → pasa; de otra versión → espera; `APPROVED` seguido de `CHANGES_REQUESTED` → espera; de otra cuenta → no cuenta; `COMMENTED` no cuenta; `same-fingerprint` con commit vacío encima y con force push → pasa; lectura fallida → técnico. Motor y juez usan la misma función (prueba que ambos dan lo mismo sobre la misma tabla) | **paso manual del dueño, fuera de la PC de los agentes:** la prueba se detiene con el enlace del PR abierto por la aplicación y espera (hasta 30 min) a que el dueño pulse «Approve» desde su teléfono o navegador; el juez pasa; un commit nuevo lo deja esperando. La prueba nunca usa la cuenta del dueño para aprobar |
| `approval-comment` local | Igual que CN-05 pero junto al agente: espera con la orden exacta; con el comentario del dueño pasa | — |
| `preview-deployment` | Sin despliegue, otro SHA, otro ambiente, otro creador, `pending`, `failure`, URL `http://` o fuera del patrón → rechazo con motivo; positivo `success` | sí: un workflow de prueba crea un despliegue con estado para la cabeza |
| `browser-qa` | Comando falso (script de Node) que escribe reportes: falta uno, sobra uno, `failed`, `assertions: 0`, JSON inválido, salida ≠ 0, PR que cambió de cabeza durante la corrida → rechazo; vista previa de otro SHA → rechazo; el entorno del comando no tiene nada fuera de lo mínimo y `pass-env` (el script lo comprueba); comando que escribe dentro del árbol → técnico por el sellado; positivo: pasa, la instantánea y los archivos del árbol quedan idénticos antes y después, y la carpeta de reportes ya no existe | — |
| `github-merge` | Puerto falso que avanza estados: fusiona → pasa con `mergeSha`; se cierra, cambia de cabeza, sale de la cola → rechazo; tope → rechazo y la siguiente corrida observa sin armar de nuevo; borrador → `ready`; tres errores de lectura seguidos se toleran, el cuarto es técnico | sí: fusión real (con y sin cola nativa, según la protección del repositorio de pruebas) |
| `post-merge` | Check en curso, fallido, ausente; despliegue de producción de otro SHA; positivo | sí: un workflow de `main` de prueba sobre el commit de la fusión |
| `cleanup` y `finish` | `finish` mientras otra sesión tiene la pieza → no toca nada; carpeta ya ausente con otro *worktree* ausente de otra pieza → solo se retira el registro de esta; `run` que termina `done` y llama a `finish` desde la carpeta que retira (Windows y Linux) → la carpeta desaparece; etapa opcional fallida seguida de `done` → `finish` retira la carpeta y `run` posterior se niega diciéndolo; Rama remota con otra punta → no se borra y lo dice; ya borrada → se salta; carpeta principal, con cambios sin guardar o con `HEAD` en otra punta → no se borra; rama local en otra punta → no se borra; caída después de borrar la carpeta y antes de la rama → `finish` desde la copia principal termina; fusiones `merge`, `squash` y `rebase` → la rama local se borra en las tres; positivo: rama y carpeta borradas tras `done` | sí: la rama desaparece y la carpeta temporal se retira |
| §5 | `retry` 3: rechaza dos veces y pasa → `passed`, una sola entrada; rechaza siempre → rechazo «tras 3 intentos»; parar durante la espera → `parked` sin `failed`; no reintenta `skipped`, `needs-human`, `ProcessTreeSurvived` ni `EffectNeedsReconciliation`. `required: false` rechazada y con fallo técnico → la pieza sigue y termina `done` con la entrada; la corrida siguiente la vuelve a intentar; opcional con `ProcessTreeSurvived` o con un efecto en duda → la pieza se bloquea igual; `validate` de las dos combinaciones prohibidas | — |
| §6 | Resumen de tres líneas presente y ausente; palabra prohibida → versión mínima; largo excedido → mínima; mínima que aún falla → no se envía y se dice; no se repite al reanudar; sin `messages:` nada | un mensaje `approval` real en el issue de prueba |
| §7 | `/approve-judge-change` con 15 caracteres → no vale; con 16 → vale; notas como `::warning::` | — |
| §8 | Fusión limpia remota → avanza y registra; conflicto resuelto, commit extra, force push → no toca nada; cadena de dos pasos con el segundo inválido → no toca nada ni registra; cambios sin guardar → se niega; pieza reservada por un `run` → se niega; rama de otra pieza → se niega sin tocar nada; reserva perdida a mitad (renovación fallida) → se detiene antes del siguiente registro o del avance; caída tras registrar y antes de mover → repetir termina sin duplicar registros; caída a mitad de los registros → repetir completa | sí: «Update branch» real y la revisión se conserva |
| §4 | `run` con receta inválida no toca el almacén; pieza que no es la de la rama → se niega; `stop`/`pause`/`resume`/`status` con la receta inválida **paran igual** y lo avisan; salidas saneadas (texto con secuencias de control); `doctor` con la sesión del dueño abierta → aviso | — |

El recorrido real vive en `tests/github/final-stages.github.test.ts`, corre con `pnpm test:github`
y `AI_WORKFLOWS_GITHUB_TEST_REPO` más las variables de §1.2, **falla** (no se salta) sin
credenciales, restaura el repositorio de pruebas al final y el orquestador pega su salida en el PR.
**Requiere que el dueño cree la aplicación de GitHub y la instale en `ai-workflows-pruebas`** (paso a
paso en el README; unos 15 minutos) antes del recorrido real.

## 11. Orden de construcción

Una prueba roja por cambio; el constructor la pone verde; el orquestador verifica y commitea.

1. Receta: `agent-account`, `messages:`, reglas nuevas de `validate` (§1.1, §3, §5, §6).
2. Motor: `required: false` y `retry` (§5).
3. Identidad de la aplicación (§1.2) y `AgentGitHub` sobre `gh` (§9).
4. Eventos (§2) y las órdenes `build` y `review`.
5. `approval-review` y `approval-comment` local (§3.2, §3.3) con la decisión compartida.
6. `independent-review` (§3.1) y la atestación de `sandboxed-review`.
7. PR de la pieza (§3.0), `preview-deployment`, `browser-qa`.
8. `github-merge`, `post-merge`, `cleanup` (§3.6–§3.8); CN-06, CN-13.
9. Mensajes (§6).
10. Binario (§4), `sync` (§8), CN-12; juez (§7).
11. README en inglés (incluido el paso a paso de la aplicación), plantilla de `init` con
    `approval-review`, §2 y §12 del plan al día; recorrido real.

## 12. Decisiones del orquestador en esta rebanada

- Los eventos de constructor y veredicto van al **issue** de la pieza, como en Socialabs: existen
  antes que el PR y el juez los encuentra por el número de pieza.
- La revisión independiente **lee** veredictos publicados (como Socialabs) en vez de correr ella a
  los revisores: la parvada puede correr en sesiones y máquinas distintas, y cada veredicto queda
  observado y publicado por `ai-workflows review`.
- La aprobación con botón es un bloque nuevo (`approval-review`) y el comentario se conserva
  (`approval-comment`) para proyectos sin identidad aparte y para la copia fiel de Socialabs (R10).
- `cleanup` no borra la carpeta desde el gate; lo hace `finish` después de `done` (el motor corre
  dentro de ella).
- El motor no forma el PR en la cola por GraphQL: `gh pr merge --auto --match-head-commit` deja que
  GitHub lo haga, igual que Socialabs hoy; la salida de la cola se detecta cuando el PR sigue
  abierto sin fusión automática y sin entrada en la cola en dos lecturas seguidas (§3.6).
- CN-07 pasa a la rebanada 5 con la instalación de los ganchos.

## 13. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura (sesión `01a0d16e-8cb7-7d62-9b96-1ea84479f6f8`):**
REVISE, 11 bloqueantes, todos aceptados:
1. El evento del constructor quedaba ligado a una versión que el constructor aún no guardó → apunta
   al commit de partida y cuenta todo constructor de la historia propia de la pieza (§2, §2.2).
2. Vigencia de veredictos contradictoria con `requireFreshVerdicts` → una sola regla para motor y
   juez, el más reciente por ángulo decide (§2.2, §3.1).
3. Conciliación de efectos sin definir → tabla de efectos con marca externa y conciliador, `op` en
   eventos y mensajes, `reconcile` en los bloques del motor, pruebas de caída antes y después
   (§2.1, §3.0.1).
4. Se podía reutilizar un PR abierto por el dueño (que él no puede aprobar) → autor, origen y base
   comprobados (§3.0).
5. Tras una fusión con el motor caído se exigía un PR abierto → se reconoce `MERGED` antes de subir
   nada; la salida de la cola se lee de la fusión automática y de la entrada de la cola (§3.0, §3.6).
6. Los reportes de QA dentro del árbol rompían el sellado y se podía vaciar una ruta ajena →
   carpeta temporal nueva fuera del árbol, creada y borrada por el motor (§3.5).
7. La reanudación de una etapa opcional no existía en el motor → se vuelve a intentar en cada
   corrida y nunca bloquea; cuarentena y efectos en duda bloquean igual (§5).
8. `sync` sin transacción recuperable → reserva, verificación de toda la cadena, registros antes de
   mover, idempotencia (§8).
9. La limpieza tras `done` podía quedar a medias y `-d` fallaba con `squash`/`rebase` → `finish`
   repetible desde la copia principal, rama local borrada por su punta (§3.8).
10. Una receta rota impedía frenar → las órdenes de control no dependen de la receta (§4).
11. La prueba real aprobaba con la cuenta del dueño en la PC del agente → paso manual del dueño
    fuera de esa PC (§10).

No bloqueantes aplicados: `push` con la rama en su clave; aviso `blocked` por motivo; QA exige
árbol idéntico antes y después.

**Ronda 2 — misma sesión (versión 2):** REVISE; confirmó cerrados 4, 5, 6, 7, 10 y 11 de la ronda
1 y dejó 7 bloqueantes, todos aceptados:
1. Un constructor sin cambios contaba y uno anterior a una actualización se perdía → todos los
   eventos del issue excluyen; «constructor conocido» exige uno que cambió algo (`result`); lo
   escrito fuera de `build` queda declarado en nivel A (§2, §2.2).
2. `same-fingerprint` comparaba contra una base común → cada huella contra su propia base de
   fusión, como `stillValidFor` (§2.2).
3. El camino del PR ya fusionado no comprobaba procedencia → la misma procedencia para todo PR
   (§3.0).
4. La conciliación leía el estado actual, no la historia → marca única de la operación en el PR;
   la fusión se concilia por la historia del PR y un desarme humano no se vuelve a armar (§3.0.1).
5. Mensajes enviados sin reserva → `run` vuelve a reservar antes de enviar y solo concilia con la
   reserva en la mano (§3.0.1, §6).
6. `sync` sin latido ni comprobación de rama → rama de la pieza, latido y renovación antes de cada
   escritura (§8).
7. `finish` sin reserva y con evidencia inconsistente → un solo esquema, reserva, y qué pasa con
   una opcional fallida tras `done` (§3.8).

No bloqueantes aplicados: credencial de `git` por el entorno del subproceso (§1.2), §12 al día,
redacción de §10.

**Ronda 3 — misma sesión (versión 3):** REVISE; confirmó cerrados 1, 2, 3, 6 y 7 y dejó 5
bloqueantes, aceptados:
1. `ready` y `close-issue` se conciliaban por el estado actual → por la historia del PR y del issue;
   un deshacer humano no se repite (§3.0.1).
2. Un aviso atrasado podía salir tras el avance de otra corrida → con la reserva, se relee y solo se
   envía si sigue vigente (§6).
3. La procedencia del PR abierto tenía dos lecturas → lista completa conservada, procedencia solo
   para elegir (§3.0).
4. El puerto fijado no permitía observar lo que exige la conciliación → `AgentPullRequest` e
   historia paginada explícitos, la misma implementación probada con `gh` falso y real (§9).
5. `git worktree prune` limpiaba registros ajenos → reparación dirigida solo del registro de la
   pieza (§3.8).

No bloqueantes aplicados: PR de la aplicación sin marca → técnico; `finish` se muda de carpeta
antes de retirar; el reintento de una opcional solo hasta `finish`.

**Ronda 4 — misma sesión (versión 4):** REVISE, 3 bloqueantes, aceptados:
1. `push` y `delete-branch` se conciliaban por el estado actual → por la actividad del repositorio
   (actor, antes y después); regla general: «no ocurrió» exige ausencia en la historia **y** estado
   compatible (§3.0.1).
2. Un PR cerrado y sin marca permitía abrir un segundo → todo PR de la aplicación sin marca, abierto
   o cerrado, es técnico (§3.0, §3.0.1).
3. `close-issue` no tenía lectura del estado → `issueState` en el puerto; si el dueño reabre,
   `cleanup` pasa sin volver a cerrar y lo registra (§3.0.1, §3.8, §9).

**Ronda 5 — misma sesión (versión 5):** REVISE, 1 bloqueante, aceptado: la reapertura del issue se
atribuía al dueño sin comprobarlo → `issueState` trae los eventos `closed`/`reopened` con su autor;
solo una reapertura del `owner` deja pasar `cleanup`, cualquier otra la rechaza (§3.8, §9, §10). No
bloqueante aplicado: el motivo del PR sin marca muestra su número y el README documenta la salida
(una rama nueva de la misma pieza).

**Ronda 6 — misma sesión (versión 6):** REVISE, 1 bloqueante, aceptado: un cierre del issue
anterior al intento podía confirmarlo → cada conciliación busca el acto anclado a su intento (para
`close-issue`, después de `mergedAt`), y la reapertura que cuenta es la posterior a ese cierre
(§3.0.1, §3.8, §10).

**Ronda 7 — misma sesión (versión 7):** REVISE, 1 bloqueante, aceptado: `mergedAt` no separaba un
cierre de la aplicación ocurrido tras la fusión y antes de `cleanup` → el ancla es el último evento
del issue leído justo antes de reclamar el cierre y **guardada como efecto**, así toda reanudación
usa la misma (§3.0.1, §10).

**Ronda 8 — misma sesión (versión 8):** REVISE, 2 bloqueantes, aceptados: el ancla guardada se
reutilizaba entre intentos, y el puerto no daba un identificador del evento → el ancla pasa a ser
el propio comentario marcado del cierre, que vive en GitHub con el `op` de la operación; la línea
de tiempo del issue se lee completa y en su orden, cada evento con su `id`, y un issue sin cierres no es error (§3.0.1, §9,
§10).

**Ronda 9 — misma sesión (versión 9):** REVISE, 2 bloqueantes sobre el comentario-ancla del cierre
del issue (contrato doble con el mensaje `close` y un comentario borrado que parecía «nada empezó»).
**Decisión del orquestador:** cerrar el issue sale del bloque `cleanup`. §4.1 del plan no lo pide
(carpeta, rama, procesos y reservas), fue la fuente de los bloqueantes de las rondas 3 a 9 y es
propio de un proyecto: Socialabs lo hará con un bloque suyo en la rebanada 6. Se retiran la
entrada `close-issue`, su efecto, `issueState` del puerto y sus pruebas; el mensaje `close` de §6
sigue siendo solo un aviso.

**Ronda 10 — misma sesión (versión 10):** **APPROVED**, sin bloqueantes. No bloqueante aplicado:
se retira `closeIssue` de `AgentGitHub` (§9). Aprobación del diseño; la implementación se verifica
aparte (puerta del orquestador, parvada y recorrido real).
