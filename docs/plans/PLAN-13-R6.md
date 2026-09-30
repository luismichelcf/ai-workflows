# PLAN-13 · Rebanada 6 — Motor completo y versión 1.0.0

Diseño de construcción de la rebanada 6 de [PLAN-13](PLAN-13.md) (issue #13), tal como quedó tras
las decisiones del dueño del 29-sep (R24–R30). El plan decide *qué*; este documento fija *cómo*.
Autor: Claude Opus 5.5 (orquestador). Revisor del diseño: GPT-6 Sol `high` (R12). Constructor:
DeepSeek V4.1 Flash `high` (R17). Versión 5 · 29-sep-2026 · **Aprobado** por GPT-6 Sol `high` en 5 rondas (§13).

Tipo de cambio: behavior

## En tres líneas

**Qué pasa hoy:** el motor pasó la suite negativa, pero solo juzga PRs hacia la rama principal
(Socialabs ahora trabaja sobre `staging`, ADR 0236). Ningún gancho acompaña a Codex ni a OpenCode.
Un PR puede quitar el gancho del editor o cambiar la versión del motor sin tu autorización. Quedan
cuatro huecos pequeños del juez y de los ganchos, y no existe todavía una versión instalable.
**Qué cambia:** el juez revisa pieza por pieza los PRs hacia las ramas de trabajo que declara la
receta. En los pases de una rama a otra solo mira los archivos propios. Los ganchos cubren Claude
Code, Codex y OpenCode con una sola lógica, y los archivos que los instalan quedan protegidos.
`init` deja un proyecto listo con una orden, y se publica la versión 1.0.0 sellada.
**Por qué importa:** es lo que falta para instalar el juez en Socialabs en modo consulta
(rebanada 7) y para que cualquier proyecto propio lo use sin armarlo a mano.

## 0. Alcance

Dentro (cada sección con sus pruebas rojas):
- §1 Ramas de trabajo y pases (R27).
- §2 Archivos propios: configuración de los ganchos y versión del motor (R26).
- §3 Ganchos para Codex y OpenCode (R26).
- §4 El gancho del editor contesta antes de su tiempo aunque git se cuelgue (R26).
- §5 Las corridas del juez de un mismo grupo de la cola se ponen en fila en vez de cancelarse (R26).
- §6 El juicio desde el issue ya no deja un verde viejo (R26).
- §7 Un check exigido con nombre prestado ya no cuenta (hallazgo del reconocimiento).
- §8 Los comentarios de robots en un PR ya no despiertan al juez (hallazgo del reconocimiento).
- §9 `init` completo, versión sellada y publicación de v1.0.0 (R28).
- §10 La revisión adversarial de la frontera de seguridad (ADR 0219, condición 3).
- §11 La evidencia real que se repite antes de publicar (R29).

Fuera (y dónde va):
- La receta de Socialabs, sus bloques y la tabla de reglas (antes EG-06): rebanada 7 (R30).
- Instalar algo en Socialabs: rebanada 7, con su propio issue (R01).
- La parte junto al agente en Socialabs: al encender, que es otra decisión del dueño (R24).
- npm: después de v1 (R28).
- La cola nativa en una rama que no es la principal: límite declarado (§1.6).
- Los pendientes menores de las rebanadas 2 y 4 (§12 del plan) siguen abiertos, salvo que una
  prueba real encuentre uno como fallo.

## 1. Ramas de trabajo y pases (R27)

### 1.1 Lo que añade la receta

```yaml
branches:
  into: [staging, main]                 # ramas que reciben piezas; la primera es a donde el motor abre el PR
  promotions:                           # pases de una rama a otra: no son piezas
    - { from: staging, to: main }
```

- `into`: lista no vacía de nombres de rama simples (las reglas de `src/locks/refname.ts`, sin
  comodines ni `refs/`), sin repetir. Por omisión: solo la rama principal del repositorio.
- `promotions`: lista de pares `from`/`to`, ambos nombres simples. **Los dos deben estar en
  `into`**: un pase solo tiene sentido desde una rama cuyas piezas se juzgaron al entrar. `from` no
  puede ser igual a `to`. Por omisión: vacía.
- `validate` rechaza lo anterior con archivo:línea:columna. `explain` lo dice en llano: «Las
  piezas entran a staging o a main. Un paso de staging a main no es una pieza: solo se revisa que no
  toque los archivos del motor».
- El bloque `pull-request` abre el PR hacia `into[0]` y el bloque `github-merge` fusiona hacia la
  base de ese PR. Hoy los dos usan la rama principal.

### 1.2 Qué rama y qué receta mandan en el servidor

- **El YAML del juez sale siempre de la rama principal.** Eso no cambia: `pull_request_target`
  corre el YAML de la principal sea cual sea el destino. La comprobación de procedencia (§3.1 de
  R3) sigue exigiendo `refs/heads/<principal>`.
- **La lista `branches` se lee de la receta de la rama principal.** Nunca de la receta de la rama
  destino: si no, una rama podría declararse juzgada a sí misma.
- **Para juzgar un PR hacia una rama de `into`, la base de confianza es la punta de esa rama.** De
  ahí salen la receta que decide las etapas y el punto de comparación (la base de mezcla). Es lo
  que valdrá después de fusionar. Si la receta de esa rama falta o no valida, el veredicto es
  técnico con el motivo; nunca se cae a la de la principal.
- **La acción necesita saber las ramas antes de compilar el motor.** El paso de decisión (bash)
  hoy corta todo PR cuya base no es la principal, y publica «juzgando» antes del juez. Ese paso
  recibe la lista en una entrada nueva, `branches`, que `init` escribe en el workflow a partir de
  la receta. Como el workflow es archivo propio, cambiarla exige la atestación del dueño. **El juez
  compara esa entrada con la receta de la principal:** si no coinciden, publica error técnico con
  el motivo «el workflow del juez y la receta no declaran las mismas ramas». Un PR hacia una rama
  que no está en la entrada sigue sin estado (SV-DESTINO).
- **Relectura de la base antes de publicar, para cada rama.** Hoy el juez relee la punta de la
  principal justo antes de publicar y, si avanzó, vuelve a juzgar una vez o publica error. Eso se
  extiende a **la rama destino de cada PR juzgado**: si la punta de `staging` cambió durante el
  juicio (por ejemplo, entró una receta nueva), se rejuzga una vez con la punta nueva; si vuelve a
  cambiar, se publica error con el motivo. Nunca se publica un veredicto calculado con una punta
  que ya no es la actual.
- **Un veredicto por SHA, el peor de todos sus PRs.** El estado se publica sobre el SHA, no sobre
  el PR. Si dos PRs abiertos comparten cabeza (uno hacia `staging` y otro hacia `main`, o un pase y
  una pieza), cada corrida juzga **todos** los PRs abiertos con esa cabeza hacia ramas de `into`,
  cada uno con su base de confianza, y publica el peor veredicto (`failure` > `error` > `pending` >
  `success`), con la descripción del peor. Así ningún juicio más permisivo tapa a otro. Un PR con
  esa cabeza hacia una rama fuera de `into` no cuenta.
- **Cuando un PR deja de contar, se rejuzgan los que comparten su cabeza.** Un PR deja de contar
  al cerrarse (`closed`, que el workflow del juez escucha ahora) o al cambiar su destino a una rama
  fuera de `into` (`edited`). En los dos casos, si quedan otros PRs abiertos con la misma cabeza
  hacia ramas de `into`, se juzgan y se publica el peor de ellos; **solo si no queda ninguno** no se
  publica nada (el SHA ya no es cabeza de ningún PR juzgado). Así, el PR que fallaba no deja al otro con un
  `failure` que ya no le corresponde.
- **El paso de decisión no publica «juzgando» en esos eventos.** Hoy publica `pending` antes de
  juzgar. Para `closed` y para `edited` hacia fuera de `into`, no lo hace: deja que el juez decida
  si quedan PRs, para cumplir «no se publica nada» cuando no queda ninguno.
- **Cambio de destino fuera de `into`, sin otros PRs con esa cabeza:** no se publica nada, como
  hoy (si quedan otros, se rejuzgan, arriba). El estado que quede en ese SHA no protege nada: la rama nueva no exige el juez (si lo exigiera, `verifyProtections` lo
  señala como configuración inconsistente). Si el PR vuelve a una rama de `into`, `edited` lo
  juzga de nuevo.

### 1.3 Pases de una rama a otra

Un PR es un **pase** si su cabeza es la rama `from` de un par de `promotions`, su base es la `to`
de ese mismo par y viene del mismo repositorio. Un pase:
- no se atribuye a ninguna pieza (hoy daría «la rama no nombra ninguna pieza»);
- se juzga **solo por los archivos propios** (§2): con la atestación del dueño para esta cabeza, o
  sin tocarlos, es `success`; si los toca sin atestación, `failure`, con el mismo mensaje de hoy;
- toma como base de confianza la punta de `to`, como cualquier PR hacia `to`.

Las piezas ya se juzgaron al entrar a `from`. Un cambio que entró a `from` con el juez apagado o en
consulta llega a `to` sin juicio por pieza; se declara (§12.1).

### 1.4 La cola y los disparadores indirectos

- `merge_group` se juzga solo si su rama base es la principal, como hoy (§1.6).
- En el disparo por `workflow_run` y por el issue, la búsqueda de PRs abiertos deja de filtrar
  «hacia la principal» y pasa a filtrar «hacia una rama de `into`». Cada PR se juzga con la base de
  confianza de su propia rama.
- `verifyProtections` revisa las protecciones de **cada** rama de `into`, no solo de la principal.

### 1.5 Pruebas rojas

1. Un PR hacia `staging`, con `staging` en la entrada y en la receta, recibe veredicto. Su base de
   confianza es la punta de `staging`: una etapa que existe solo en la receta de `staging` se exige.
2. Un PR hacia una rama que no está en la entrada no recibe estado.
3. Entrada y receta que no coinciden → error técnico con el motivo exacto.
4. Un pase `staging → main` sin archivos propios → `success`, sin buscar pieza. Con
   `.ai-workflows/pipeline.yml` tocado → `failure` con la orden de 16 caracteres. Con la
   atestación del dueño para esa cabeza → `success`.
5. Un PR con cabeza `staging` hacia `main`, pero **desde un fork** o sin el par declarado, no es
   pase: se juzga como pieza (y falla por no nombrar ninguna).
6. Un PR hacia `main` desde `hotfix/7-x`, con `main` en `into`, se juzga como la pieza 7.
7. El juicio desde el issue encuentra y juzga un PR abierto hacia `staging`.
8. `validate` rechaza: `into` vacío, un nombre con comodín, un `to` o un `from` que no está en
   `into` (la receta `into: [main]` con `promotions: [{from: staging, to: main}]` es inválida) y un
   `from` igual a `to`.
12. Dos PRs con la misma cabeza, uno hacia `staging` que pasa y otro hacia `main` que falla → el
    estado del SHA es `failure`, publicado por la corrida de cualquiera de los dos. Al revés
    (el de `main` pasa, el de `staging` falla) → `failure` también.
13. Un PR en verde hacia `staging` se cambia de destino a una rama fuera de `into` → no se publica
    nada; al volver a `staging` se juzga de nuevo.
14. Durante el juicio de un PR hacia `staging`, la punta de `staging` avanza con una receta que
    exige una etapa más → se rejuzga con la punta nueva y el veredicto la exige; si avanza otra vez,
    `error` con el motivo.
15. Dos PRs con la misma cabeza; el que fallaba se cierra (`closed`) → el otro se juzga y su
    veredicto queda en el SHA. Lo mismo si el que fallaba cambia su destino a una rama fuera de
    `into`. Se cierra el único PR con esa cabeza → no se publica nada, **tampoco «juzgando»**,
    comprobado a través de la acción completa (paso de decisión incluido).
16. La plantilla del juez escucha `closed` en `pull_request_target`.
9. Sin sección `branches`: todo se comporta como hoy (las pruebas existentes no cambian).
10. `verifyProtections` informa la rama sin la protección esperada cuando son dos.
11. El bloque `pull-request` abre hacia `into[0]`.

### 1.6 Límites que se declaran

- La cola nativa solo se juzga en la rama principal. Un `merge_group` de otra rama corre el YAML
  del commit del grupo (no el de la principal), y su procedencia no se puede fijar igual. Queda sin
  estado. Si un proyecto pone cola en `staging`, se diseña aparte.

## 2. Archivos propios: ganchos y versión del motor (R26)

### 2.1 La lista vive en el motor

La lista es conocimiento del motor, no de un proyecto: son los archivos que escribe su propio
instalador y la línea que dice qué versión del motor se usa. Por eso va fija en el motor (R05) y no
se agrega un campo a la receta. `also-protect` se conserva para los archivos extra de cada
proyecto.

Archivos protegidos por ruta, además de lo que ya se protege (`.ai-workflows/**`, el workflow del
juez y `also-protect`):
- `.claude/settings.json` y `.claude/settings.local.json` (el segundo manda sobre el primero y
  puede apagar todos los ganchos);
- los archivos que escribe el instalador de Codex y de OpenCode (§3.3), y los de configuración que
  pueden apagarlos: `.codex/hooks.json`, `.codex/config.toml`, `opencode.json`, `opencode.jsonc`,
  `.opencode/opencode.json`, `.opencode/opencode.jsonc` y la carpeta de plugins del motor en
  `.opencode/`;
- `.pnpmfile.cjs` (puede reescribir cualquier dependencia al instalar);
- el workflow de la señal de revisión y el de la prueba roja, que hoy dependen de `also-protect` en
  la plantilla. El motor ya conoce sus rutas.

**Una sola constante compartida** entre el instalador y el juez. Una prueba exige que todo archivo
que escribe `hooks install` esté en la lista, para que nunca se separen.

**Sin distinguir mayúsculas.** La comparación pasa a hacerse en minúsculas: en Windows, un PR que
añade `.Claude/settings.json` sobrescribe el real al traer los cambios. Un falso positivo solo
cuesta una atestación.

### 2.2 La versión del motor, campo por campo

`package.json` cambia en muchos PRs ordinarios, así que no se protege entero. Se compara, entre la
**base de mezcla** y la cabeza, solo lo que decide qué motor se instala:
- `package.json`: la clave `ai-workflows` en `dependencies`, `devDependencies`,
  `optionalDependencies` y `peerDependencies`; y toda clave que nombre al motor
  (`/(^|>)ai-workflows(@|$)/`) en `pnpm.overrides`, `overrides`, `resolutions` y
  `pnpm.patchedDependencies`.
- `pnpm-workspace.yaml`: lo mismo en `overrides` y `patchedDependencies`, y la entrada
  `ai-workflows` de `catalog` y de cada `catalogs`.
- `pnpm-lock.yaml`: la entrada del motor en cada importador y las de `packages` y `snapshots` cuya
  clave empieza con `ai-workflows@`, más las `overrides` y `patchedDependencies` que lo nombran.
- `package-lock.json`: `packages['node_modules/ai-workflows']`. `yarn.lock`: los bloques cuyo
  encabezado nombra `ai-workflows@`.

**Qué se protege es la carpeta `node_modules/ai-workflows`**, que es lo que cargan los ganchos.
Esa carpeta la decide la **clave** `ai-workflows`, sea cual sea su valor: un valor
`npm:otro-paquete@…` bajo esa clave instala otro paquete en esa carpeta y se detecta por la clave.
Un alias con otra clave (`"x": "npm:ai-workflows@…"`) instala en `node_modules/x`, que nada carga,
y no cuenta.

Reglas:
- Solo corre si el PR toca alguno de esos archivos; los demás PRs no pagan nada.
- Se compara una proyección con claves ordenadas: reformatear o reordenar no cuenta como cambio.
- Contra la base de mezcla, no contra la punta de la base: un PR viejo no se marca porque la
  principal subió de versión después.
- **Del lado seguro:** un archivo que no se puede leer como JSON o YAML en cualquiera de los dos
  lados, o que se añade o se borra, cuenta como «toca la versión del motor» (rechazo salvo
  atestación, no error técnico: es una propiedad del PR). Un fallo de git al leer sigue siendo
  técnico, como hoy.
- Los archivos de bloqueo reales pasan de 1 MB. Se leen con un tope propio de 50 MB; por encima,
  cuentan como tocados. Nunca un tope convierte algo en «pasa».

### 2.3 Cómo se une al juicio

El juicio de archivos propios (`judgeFilesNote`) reúne rutas y versión en una sola lista de lo
tocado. La atestación no cambia: 16 caracteres, solo para la cabeza, del dueño de la receta de
confianza. **La nota publicada no cambia** (el límite de 140 caracteres conserva la orden). La lista
de lo tocado va solo al registro de la corrida, no al estado. Mostrarla al dueño en el PR sería
salida nueva y se propondría aparte.

### 2.4 Pruebas rojas

1. Cada ruta nueva de §2.1 tocada sin atestación → `failure` con la orden y los 16 caracteres de la
   cabeza; con la atestación → `success`.
2. Borrar `.claude/settings.json` → `failure`.
3. `.Claude/settings.json` y `.AI-Workflows/pipeline.yml` → `failure`.
4. La versión del motor cambiada, movida de `dependencies` a `devDependencies`, con un `override`
   nuevo o con un `patchedDependencies` nuevo → `failure`.
5. Solo `dependencies.react`, solo `scripts.test`, o el mismo pin reordenado → `success`.
6. En `pnpm-lock.yaml`, solo la `integrity` del motor → `failure`; solo la de otro paquete →
   `success`.
7. `pnpm-workspace.yaml` con un `override` del motor → `failure`; con otra carpeta en `packages`
   → `success`.
8. La principal sube el motor después de que el PR se ramificó y el PR no toca `package.json` →
   `success`.
9. `package.json` roto en la cabeza → `failure`, no error.
10. Un `pnpm-lock.yaml` de más de 1 MB con un cambio ajeno → `success`; uno por encima del tope →
    `failure`.
11. `package.json` sin clave `ai-workflows` en ningún lado y un cambio ajeno → `success`.
13. La clave `ai-workflows` cambia a `npm:otro@1.0.0` → `failure`. Se añade `"x":
    "npm:ai-workflows@9.9.9"` sin tocar la clave `ai-workflows` → `success`.
12. El conjunto de archivos que escribe `hooks install --apply` está contenido en la lista
    protegida.

## 3. Ganchos para Codex y OpenCode (R26)

### 3.1 Paso cero: los formatos reales, capturados en esta PC (29-sep)

El orquestador capturó la entrada real que dan `codex` 0.159.0 (el de la app de escritorio) y
`opencode` 1.18.30 a un gancho que solo la guarda. Esas entradas, saneadas, son los datos fijos de
las pruebas. Lo medido:

**Codex 0.159.0, Windows:**
- La entrada es la de Claude en forma: `tool_name`, `tool_input`, `cwd`, `hook_event_name:
  "PreToolUse"`, `session_id`, `turn_id`, `tool_use_id`, `permission_mode`, `model`.
- La consola llega como `tool_name: "Bash"` con `tool_input.command` **como texto** (en Windows,
  una orden de PowerShell).
- La edición con su herramienta llega como `tool_name: "apply_patch"` y `tool_input.command` con el
  parche entero (`*** Begin Patch` … `*** Add File:` / `*** Update File:` … `*** End Patch`), con
  rutas relativas.
- El gancho corre en la carpeta de la sesión, sin ninguna variable que diga la raíz del proyecto.
- **El rechazo que funciona es la respuesta JSON de rechazo en la salida estándar con salida 0.**
  Con salida 2 (con o sin el JSON, como recomienda su documentación) Codex **ignoró el rechazo**
  de `apply_patch` y escribió el archivo (el fallo openai/codex#27833 sigue en 0.159.0). Con JSON y
  salida 0, `apply_patch` quedó bloqueado con «Command blocked by PreToolUse hook».
- Codex escribe muy a menudo por la consola (`Set-Content`, `[IO.File]::WriteAllText`) en vez de
  por `apply_patch`: en la captura, las cuatro escrituras pedidas fueron por consola.

**OpenCode 1.18.30, Windows:**
- El plugin recibe `(input, output)` con `input.tool` (`write`, `edit`, `read`, `bash`, `task`…),
  `input.sessionID` y `output.args`. `write` trae `{filePath, content}`, `edit` trae `{filePath,
  oldString, newString}` y `bash` trae `{command}`. `filePath` llega **absoluto** y con barras
  invertidas.
- Lanzar un error en `tool.execute.before` bloquea la herramienta.
- **Las llamadas de un subagente (`task`) sí pasan por el plugin** (llevan otro `sessionID`) y se
  bloquean igual.
- El modelo de DeepSeek usado no ofreció `apply_patch`. Su forma (`patchText`) se toma del código de
  OpenCode y se prueba con datos fijos.

Queda por medir en §3.5: si Codex `exec` ejecuta el gancho del proyecto **sin** el permiso de saltar
la aprobación, y si el rechazo por JSON también frena la consola.

### 3.2 Una lógica, tres traductores

Las decisiones de hoy (`decideToolUse`, la regla 0, `decideGitFolder`, el recorrido por copia de
trabajo de `runEditor`) no cambian. Se añade una capa de traducción por cliente:
- `parse(entrada) → HookInput | error` y `render(decisión) → {salida, error, código}`.
- **Claude:** lo de hoy.
- **Codex:** `apply_patch` (y sus alias `Edit` y `Write`, que también traen el parche en
  `tool_input.command`, nunca `file_path`) se traduce a `apply_patch`; `Bash` a `Bash`. **Rechazo:
  la respuesta JSON de rechazo en la salida estándar y salida 0** (§3.1: con salida 2, Codex deja
  pasar). Toda falla interna del gancho, incluida la del cargador, también contesta con ese JSON y
  salida 0; nunca con otro código.
- **OpenCode:** `write` y `edit` traen `filePath`; `apply_patch` trae `patchText`; `bash` trae
  `command`. Se traducen a `Write`, `Edit`, `apply_patch` y `Bash`. Rechazo: el plugin lanza un
  error con el motivo.
- **Del lado seguro, en Codex y OpenCode:** una herramienta desconocida cuya entrada trae algo con
  forma de ruta (`path`, `filePath`, `file_path`, `paths`, `patchText`) se rechaza con el motivo.
  Para que esa regla sirva, **el gancho tiene que recibir todas las herramientas**: en Codex el
  patrón instalado es `.*` y el plugin de OpenCode ve todas las llamadas. En Claude se conserva el
  patrón de hoy (lista cerrada de escritura y consola) y la regla 1 de hoy; cambiarla haría correr
  el gancho en cada lectura y no se pidió. Una entrada ilegible se rechaza con el formato de ese
  cliente.
- **La carpeta del proyecto** no sale de `CLAUDE_PROJECT_DIR` (Codex y OpenCode no la dan). Sale de
  la carpeta desde la que corre el gancho y del `cwd` de la entrada, subiendo con `git rev-parse
  --show-toplevel`. Si no se puede resolver, se rechaza.

### 3.3 Lo que escribe `hooks install`

`hooks install` escribe los tres clientes por omisión; `--client claude|codex|opencode` limita a
uno. Todo se muestra primero y se escribe solo con `--apply`, como hoy.
- **Codex:** `.codex/hooks.json`, fusionado con lo que ya haya (`mergeHooksConfig`), con
  `PreToolUse`, el patrón `.*`, `timeout: 30` (el de Codex por omisión es 600 s) y la orden en dos
  formas, `command` y `commandWindows`.
- **OpenCode:** un plugin entero en `.opencode/plugins/ai-workflows.js`, reconocido por un
  encabezado fijo y nunca fusionado. El plugin lanza un proceso `node` con el mismo punto de
  entrada, le pasa la entrada por la entrada estándar y **lanza error** (bloquea) si el proceso
  rechaza, sale con otro código, no arranca o pasa de su propio tiempo. Corre dentro de OpenCode,
  así que tiene que fallar cerrado por su cuenta.
- **Un cargador en archivo,** `.ai-workflows/hook.cjs`, para Codex y OpenCode. Esconder la orden
  en una línea de consola es frágil en cmd, pwsh y sh. Ese archivo ya queda protegido por estar en
  `.ai-workflows/`. Recibe el cliente como argumento y, si el motor no carga o sale de una forma
  inesperada, contesta el rechazo **en el formato de ese cliente** (JSON con salida 0 para Codex;
  salida distinta de 0 para el plugin de OpenCode, que entonces lanza error). La orden de Codex lo
  busca desde la raíz del repositorio (`git rev-parse --show-toplevel`), no desde la carpeta de la
  sesión. *(Corregido en la revisión del encargo B:)* la orden misma falla cerrada: solo deja
  pasar si el cargador terminó con 0 y sin salida, o reenvía su JSON de rechazo; en cualquier otro
  caso (sin repositorio, sin cargador, cargador que falla o muere, salida que no es ese JSON)
  imprime ella el JSON de rechazo y sale con 0, porque Codex deja pasar cualquier otra salida.
- Al terminar, en llano: qué se escribió y qué falta. En Codex interactivo, el dueño aprueba una
  vez el gancho en `/hooks`; Codex `exec` salta los ganchos no aprobados salvo con
  `--dangerously-bypass-hook-trust`.
- `doctor` revisa los tres.

### 3.4 Límites que se declaran (nivel A)

- **Codex**, según su propia documentación, trata los ganchos como «una barrera útil, no una
  frontera completa». Un gancho que falla o se cuelga deja pasar la herramienta; el rechazo con
  salida 2 no se respeta en Windows (§3.1). El modo `exec` de Code Mode ejecuta llamadas anidadas
  sin gancho (#23411). Los ganchos no aprobados se saltan en silencio.
- **Escribir por la consola** (lo que Codex hace a menudo) no pasa por la regla de carpetas en
  ningún cliente: el gancho no interpreta la consola, igual que hoy en Claude (R5 §1.3). Solo la
  regla 0 mira la consola.
- **OpenCode:** el plugin vive dentro de OpenCode; si OpenCode no lo carga, no hay freno.
- En todos: el juez en GitHub sigue siendo el freno real. §3.5 comprueba en esta PC qué sí frena
  cada uno, y el resultado va al README tal cual.

### 3.5 Pruebas

Rojas, unitarias:
1. Tabla por cliente con los datos capturados: «escribir `src/x` sin pieza activa» se rechaza y
   «escribir `docs/x`» pasa, igual que el caso equivalente de Claude.
2. Regla 0 en los tres: una consola con `gh pr review --approve` y un archivo con la línea
   `/approve <sha>` se rechazan.
3. Herramienta desconocida con `filePath` → rechazo en Codex y en OpenCode, **pasando por la
   configuración instalada**: el patrón escrito en `.codex/hooks.json` la deja llegar al gancho (se
   comprueba con el patrón leído del archivo, no con uno de la prueba).
4. Entrada ilegible → rechazo con el formato del cliente.
5. Codex sin `CLAUDE_PROJECT_DIR`, desde una subcarpeta → resuelve la raíz.
6. `hooks install` escribe `.codex/hooks.json` sin tocar los ganchos ajenos y sin repetirse; el
   plugin y el cargador no llevan rutas de la PC.
7. El plugin de OpenCode, con un proceso que se cuelga, sale con 1 o no encuentra el motor → lanza
   error.
8. El cargador en archivo, con el motor ausente o saliendo con 1: para Codex contesta el JSON de
   rechazo con salida 0; para OpenCode sale distinto de 0.
9. El traductor de Codex, con una falla interna, contesta JSON y salida 0, nunca salida 2.

Reales en esta PC (no en GitHub), en una copia desechable del repositorio de ensayo, juzgadas por
`git diff` y no por el código de salida:
- R-CX1: `codex exec` (0.159.0) con el gancho y el permiso de saltar la aprobación, en una rama sin
  pieza, pide escribir `src/x` **con `apply_patch`** → el archivo no existe después **y** el
  registro de Codex trae «blocked by PreToolUse hook» con el motivo del motor (no basta que el
  archivo falte: el agente pudo no intentarlo). Controles: en `feat/<n>-x`, existe; en `docs/x`,
  existe. R-CX2: lo mismo sin el permiso de saltar la aprobación, para medir si `exec` lo corre.
  R-CX3: la regla 0 por consola (`gh pr review --approve`) queda bloqueada con el motivo.
- R-OC1: lo mismo con `opencode run --auto` (1.18.30), con el motivo del motor en el error de la
  herramienta. R-OC2: la misma escritura pedida a través de un subagente (`task`).
- Si R-CX2 no corre el gancho, se anota en el README como límite medido, con versión y fecha. No es
  un fallo de la rebanada: el juez sigue frenando. Si R-CX1, R-CX3, R-OC1 o R-OC2 fallan, es un
  fallo de la rebanada.

## 4. El gancho contesta antes de su tiempo (R26)

Hoy cada llamada a git espera hasta 60 s, y Claude Code corta el gancho a los 30 s y **deja pasar**
la herramienta. Además `execFile` espera a que se cierren las tuberías, no a que el proceso
termine, y `bin.ts` no llama a `process.exit`.

Diseño:
- **Presupuesto con fecha límite.** `runHook` recibe un plazo total (por omisión 20 s). Cada
  llamada a git recibe como tiempo `min(10 s, lo que queda − reserva)`. Si el plazo se acaba, esa
  llamada falla con «git no respondió a tiempo (N s)», y todo fallo de git es rechazo.
- **Git propio del gancho**, sobre `spawn`: termina con el evento de salida del proceso, no con el
  cierre de tuberías. Al vencer mata el árbol de procesos (con los auxiliares de
  `src/process-group*.ts`) y corta las tuberías. Entorno con `GIT_TERMINAL_PROMPT=0` y
  `GIT_OPTIONAL_LOCKS=0`.
- **Vigilante externo.** El hilo principal corre la decisión en un `Worker` y, a los 25 s, escribe
  el rechazo del cliente y sale. Cubre también las lecturas de disco que bloquean el hilo.
  *(Cambiado en la construcción de los arreglos, encargo H:)* la decisión corre en un **proceso**
  hijo, no en un `Worker`: en Linux, un hilo bloqueado en una lectura nativa (un FIFO) impide que
  `process.exit` termine el proceso, y la CI lo midió en 40 s. El vigilante se arma antes de leer la
  entrada y mata al hijo al vencer.
- **Salida explícita** con `process.exit` en `hook editor`, con la respuesta ya escrita.
- **Entrada ligera:** `hook` carga solo lo que usa (importaciones dinámicas en `bin.ts`), para que
  el arranque en frío en Windows no se coma el presupuesto. Medido en esta PC el 29-sep (v0.3.x
  compilado, `hook editor` con una escritura en `docs/`): 2,4 s la primera vez y 0,3 s las
  siguientes; `node` vacío, 0,16 s. Las constantes 20 s (git) y 25 s (vigilante) dejan margen.
- **Fallo abierto corregido:** `workCopyOwningGitPath` convertía un git que falla en «no es un
  repositorio» y dejaba escribir dentro de `.git/hooks` de la copia principal desde otra copia de
  trabajo. Ahora un fallo se propaga y rechaza.
- Los ganchos de git no tienen tiempo límite de git (un git colgado solo detiene el commit). Usan
  el mismo git con plazo, pero de 60 s.

Pruebas rojas (las de proceso real solo en POSIX; en Windows, con git inyectado):
1. Un git falso que duerme 120 s: `Write` en `src/` con plazo de 2 s se rechaza en menos de 3 s,
   nombrando git y el tiempo. Igual con `Bash`.
2. Un git falso que deja un nieto con las tuberías abiertas: el gancho contesta dentro del plazo.
3. De punta a punta, con el cargador tal como queda escrito: el proceso **termina** antes de 30 s
   con la respuesta de rechazo y salida 0.
4. Sesión en otra copia de trabajo en una rama de pieza; escribir `<principal>/.git/hooks/pre-commit`
   con un git que falla solo en la principal → rechazo (hoy pasa).
5. Un ejecutor que nunca contesta, con relojes falsos: rechazo al vencer, sin promesas colgadas.
6. Constantes: plazo de git < vigilante < tiempo del gancho − margen.
7. `doctor` avisa si el tiempo configurado del gancho es menor o igual al del vigilante.
8. El entorno de git del gancho lleva `GIT_TERMINAL_PROMPT=0` y `GIT_OPTIONAL_LOCKS=0`.

## 5. El juez en la cola: corridas en fila (R26)

Hoy las corridas del juez sobre un mismo grupo de la cola comparten la clave de concurrencia y la
nueva cancela la vieja. Tras el encargo V, un grupo solo recibe veredictos, pero el diseño sigue
apoyándose en que una corrida cancelada no publique nada. Eso depende de que el paso «Cerrar con
error» no corra al cancelar, algo que no se ha comprobado en GitHub.

Diseño: en un grupo de la cola, las corridas **se ponen en fila, no se cancelan**:

```yaml
cancel-in-progress: ${{ !(github.event_name == 'merge_group' || (github.event_name == 'workflow_run' && github.event.workflow_run.event == 'merge_group')) }}
```

Por qué basta, según la documentación de GitHub (workflow syntax, `concurrency`, consultada el
29-sep): en un mismo grupo corre **a lo sumo una** corrida a la vez; con la cola por omisión
(`queue: single`) queda a lo sumo **una** en espera, y una nueva **sustituye** a la que esperaba.
La expresión en `cancel-in-progress` está permitida (contextos `github`, `inputs`, `vars`). De ahí:
- las corridas que empiezan lo hacen de una en una y publican en ese orden: nunca hay dos juzgando
  el mismo grupo a la vez;
- la corrida sustituida en espera nunca empezó: no corre ningún paso y no publica nada;
- la última que corre es la que empezó a esperar al final, y relee todo (los checks, la receta, los
  PRs) al empezar. Perder las esperas intermedias no pierde información.

No se usa `queue: max`: GitHub no permite combinarlo con `cancel-in-progress: true` (error de
validación), y aquí la clave es una sola para todos los eventos; tampoco hace falta, por lo
anterior.

La trampa de salida sigue fallando cerrado ante una cancelación a mano. Costo: dos o tres corridas
completas por grupo, una tras otra, cada una de 15 minutos como mucho.

Pruebas:
1. Roja: la plantilla lleva exactamente esa expresión (literal del diseño), sin clave `queue`, y la
   clave del grupo sigue teniendo `merge_group.head_sha` y `workflow_run.head_sha`.
2. Real (A-T3): **tres** checks exigidos que terminan casi juntos, más el `merge_group`: cuatro
   disparos. Ninguna corrida del juez que llegó a empezar termina cancelada; las que se cancelan no
   tienen pasos; nunca hay dos corridas del juez del grupo en curso a la vez (se comprueba con sus
   horas de inicio y fin); el grupo se fusiona. Sonda: cancelar a mano una corrida en «Juzgar» y
   anotar qué estado queda en el grupo (comprueba la suposición sobre «Cerrar con error»; si publica
   error, se anota: es una cancelación a mano y falla cerrado).

## 6. El juicio desde el issue sin verde viejo (R26)

Hoy, si un veredicto se borra del issue y el juicio que eso dispara se cae antes de publicar,
el último verde sigue en la cabeza del PR. Sin cola, esa cabeza se puede fusionar.

Diseño:
- **Retirar el verde antes de juzgar.** En cuanto se conocen los PRs de la pieza, y antes de juzgar
  el primero, se publica `pending` «juzgando» en la cabeza de cada uno, en el estado que toca (el
  consultivo en `advisory`). Así, lo que se caiga después deja «juzgando», nunca el verde viejo.
- **Sin pisar a una corrida más nueva.** Antes de publicar ese `pending`, se leen los estados de la
  cabeza. Si el último del juez es de una corrida oficial más nueva que esta, ese PR se salta (la
  misma regla (c) de R3 §3).
- **Error honesto y aislamiento entre PRs.** La relectura fallida antes de publicar pasa a publicar
  `error` con su motivo, como ya hace la lectura de estados fallida. Cada PR se juzga dentro de su
  propia captura: un error en uno publica `error` en ese y se sigue con el siguiente. Hoy aborta a
  los demás, contra lo que prometía R5 §2.6.
- **Antes de conocer los PRs de la pieza.** Hacen falta la receta (para saber qué ramas son de la
  pieza) y la lista de PRs abiertos. Cada lectura se reintenta tres veces. Si aun así:
  - **la receta no se puede leer, pero sí la lista de PRs:** se publica `pending` con el motivo
    «no pude leer la receta» en la cabeza de **todos** los PRs abiertos hacia las ramas de la
    entrada `branches` (que la acción ya tiene sin receta), con la misma guarda de corrida más
    nueva. Es más amplio que la pieza, pero es del lado seguro (esperar, no fusionar) y el
    siguiente evento de cada PR lo vuelve a juzgar. Una receta ilegible en la base ya deja técnico
    todo juicio de PR, así que no añade un bloqueo nuevo en la práctica;
  - **la lista de PRs no se puede leer:** no hay a quién retirar el verde. La corrida termina en
    error con el motivo en su registro y la garantía de R26 **no se cumple en ese caso**. Se
    declara como límite (§12.1). No hay forma de publicar en una cabeza que no se conoce;
- **Si falla la publicación de uno de los `pending` iniciales:** ese PR no se juzga en esta corrida
  (no se le publica un veredicto que podría ser el verde viejo), la corrida continúa con los demás
  y termina en error nombrando el PR. El verde viejo de ese PR puede seguir; es el mismo límite de
  «GitHub no deja publicar estados» de §5.3 del plan.
- **Cómo salen de la espera los PRs ajenos** tras el `pending` amplio: con el siguiente evento de
  cada PR (un push, un comentario, un check que termina) o, a mano, con la orden de juzgar un PR que
  el workflow ya tiene (`workflow_dispatch` con su número). El README lo dice en la sección de
  fallas.
- En un grupo de la cola nunca se publica nada de esto: el juicio desde el issue solo toca cabezas
  de PRs.

Pruebas rojas:
1. Veredicto borrado, un PR y su segunda lectura falla → primero `pending` «juzgando» en su cabeza,
   ningún `success` y al final `error`.
2. Dos PRs; el segundo `branchHead` falla → `pending` en las dos cabezas antes de cualquier otra
   publicación, `error` en el primero y el segundo juzgado con su propio veredicto.
3. Orden: las primeras N publicaciones son los `pending` de las N cabezas.
4. Una cabeza cuyo último estado es de una corrida oficial más nueva no recibe nada.
5. En `advisory`, el `pending` va solo al estado consultivo.
6. La lista de PRs no se puede leer tras tres intentos → la corrida termina con el motivo y no
   publica nada (límite declarado).
8. La receta de la base no se puede leer tras tres intentos, con dos PRs abiertos hacia ramas de la
   entrada (uno de otra pieza) → `pending` «no pude leer la receta» en las dos cabezas; ningún
   `success`.
9. Falla la publicación del `pending` inicial en el primero de dos PRs → ese PR no recibe ningún
   veredicto, el segundo se juzga, y la corrida termina en error nombrando al primero.
10. Una lectura que falla dos veces y funciona a la tercera → se juzga normalmente.
7. Real (B-T6): PR en verde por un veredicto en su issue; se borra el comentario, aparece
   «juzgando» y se cancela esa corrida → la cabeza queda `pending`, no `success`.

Las pruebas actuales que comparan la lista completa de publicaciones se ajustan en el mismo cambio
(el orquestador las edita; el constructor no).

## 7. Un check exigido con nombre prestado (hallazgo)

`requireCheck` toma el check-run más reciente con el nombre pedido, sin mirar de dónde viene. Un PR
puede añadir un workflow suyo (`on: pull_request`) con un job llamado `ai-workflows/red-test` que
espera un poco y termina en verde. Su check-run sale después y cuenta. Añadir un workflow nuevo no
toca ningún archivo propio.

Diseño: **para la prueba roja del motor** (`ai-workflows/red-test`), el check-run cuenta solo si
**ese check-run concreto** se puede atar a un job del workflow oficial de la prueba roja, corrido
**para este PR y su base actual**. La cadena, toda con el permiso `actions: read` que el juez ya
tiene:
1. El check-run (su `id`) pertenece a la aplicación `github-actions` y trae su `check_suite.id`.
2. Las corridas de Actions con ese `check_suite_id` (`GET …/actions/runs?check_suite_id=`) son
   exactamente una; su `head_sha` es el SHA juzgado.
3. Los jobs de esa corrida (`GET …/actions/runs/{id}/jobs`, con todas sus páginas e intentos)
   incluyen uno cuyo `check_run_url` termina en `/check-runs/<id del check-run>`.
4. **La ruta del workflow se toma del workflow, no de la corrida:** con el `workflow_id` de la
   corrida se lee el workflow (`GET …/actions/workflows/{workflow_id}`) y su `path` (la ruta exacta
   del archivo, sin sufijo de referencia) debe ser **exactamente** la del workflow de la prueba roja,
   y ese archivo debe **existir en la base de confianza** del PR (se comprueba en el árbol ya
   traído). No se recorta nada: la `path` de la corrida puede traer un sufijo `@<ref>` y un PR puede
   nombrar un archivo `…/ai-workflows-red-test.yml@falso.yml`, así que recortarla abriría un hueco.
5. **La corrida es de este PR y de su base actual:** si es de un PR (`pull_request`), su lista
   `pull_requests` incluye este número con `base.ref` igual a la base que se juzga **y** con un
   `base.sha` que es la punta actual de esa base **o un ancestro suyo** (la base solo avanzó, no se
   reescribió); si es de la cola (`merge_group`), su `head_sha` es el SHA del grupo. Por qué se
   acepta un ancestro y no solo la punta exacta: la prueba roja solo corre en eventos del PR, no
   cuando la base avanza; exigir la punta exacta dejaría esperando a todos los PRs abiertos cada vez
   que entra algo a `staging`, hasta un push nuevo. Es la misma regla que hoy rige para la principal
   sin cola (R3 §5: la base de ejecución es `pull_request.base.sha`): la evidencia roja es contra la
   base desde la que el PR se actualizó por última vez. Con cola, el grupo vuelve a correrla contra
   su base. Se declara en §12.1. Una corrida de una base anterior (el PR
   cambió de destino y su prueba nueva sigue corriendo) no cuenta: se espera a la nueva. Un PR
   desde un fork no trae esa lista: su prueba roja espera con el motivo «no se puede atar la prueba
   roja a este PR» (límite declarado; los PRs de este proceso salen del mismo repositorio).

Entre los check-runs con ese nombre se elige el más reciente **de los que pasan la cadena**; los
que no la pasan se ignoran y se anotan en el registro. Si la cadena no se puede leer (una llamada
falla), cuenta como «todavía no» (espera), nunca como verde. Un **estado de commit** con ese nombre
ya no cuenta: no tiene origen comprobable.

**Los checks del proyecto** (`require-check` con otro nombre, como `todo-verde`) siguen la regla de
hoy (R3 §4): el check-run o el estado más reciente con ese nombre, de cualquier aplicación, porque
hay integraciones que no son Actions (Vercel publica estados, otras apps publican check-runs). Queda
declarado junto a R13 y ADR 0214: un PR puede añadir un workflow con un job del mismo nombre. El
registro de la corrida dice de qué aplicación y, si es Actions, de qué workflow vino el que contó.

Lo que queda y se declara (junto a R13 y ADR 0214): un PR que **edita** el workflow de la prueba
roja para cambiar lo que hace su job; eso exige atestación, porque es archivo propio.

Pruebas:
1. Roja: dos check-runs con el nombre `ai-workflows/red-test`: el oficial en `failure` y uno más
   nuevo en `success` cuyo workflow no existe en la base → cuenta el oficial (`failure`). Solo el
   impostor → espera.
2. Roja: un check-run de otra aplicación con el mismo nombre → no cuenta.
3. Roja: el check-run nuevo viene de una corrida del workflow oficial, pero **ningún job** de esa
   corrida apunta a ese check-run → no cuenta.
4. Roja: una de las llamadas de la cadena falla → espera, con el motivo.
5. Roja: un estado de commit `ai-workflows/red-test` en `success` y ningún check-run → espera. Un
   estado `todo-verde` en `success` para un check del proyecto → cuenta, y el registro lo dice.
5b. Roja: la corrida más reciente de la prueba roja es de este PR pero con `base.ref: main` y el PR
   ahora apunta a `staging`; la de `staging` sigue en curso → espera. Termina en `failure` → cuenta
   `failure`.
5d. Roja: `base.sha` de la corrida es un ancestro de la punta actual de `staging` → cuenta. No es
   ancestro (la base se reescribió) → espera, con el motivo.
5e. Roja: la corrida trae `path` con sufijo y el workflow de su `workflow_id` es el oficial →
   cuenta. El workflow de su `workflow_id` es `.github/workflows/ai-workflows-red-test.yml@falso.yml`
   → no cuenta, aunque la `path` de la corrida recortada coincidiría.
5c. Control positivo: un check exigido del proyecto publicado como check-run por otra aplicación
   (no Actions) en `success` → cuenta.
6. Real (CN-14, nuevo en la suite): un PR que trae el workflow impostor y una prueba que no falla en
   la base no pasa, porque el juez espera o rechaza la prueba roja. Control positivo: el mismo PR
   sin el impostor y con una prueba roja de verdad pasa.

## 8. Comentarios de robots en un PR (hallazgo)

Hoy cualquier comentario de un PR que lleve una `/` despierta al juez. Los comentarios de Vercel y
Supabase traen direcciones, así que en Socialabs cada uno sería una corrida del juez que además
cancela un juicio en curso del mismo PR. Cambio: en un comentario **de PR**, no se juzga si el autor
es una cuenta de tipo `Bot`. Las órdenes del dueño vienen de una cuenta `User`, y la atestación ya
exige `User`. En un issue que no es PR no cambia nada: ahí los veredictos los escribe la aplicación
de los agentes.

Prueba roja: la condición del job en la plantilla es exactamente la nueva (literal del diseño). En
real, dentro de §11: un comentario de la aplicación de los agentes con una dirección en un PR no
crea corrida del juez.

## 9. `init` completo y la versión 1.0.0 (R28)

### 9.1 El sello

La versión publicada lleva `engine.json` en la raíz del paquete: `{"version": "1.0.0", "sha":
"<40 hex>"}`. Lo escribe el workflow de publicación con el commit de la etiqueta, y comprueba tres
cosas: que ese commit es el que se revisó, que la etiqueta es `v<versión de package.json>` y que el
commit es ancestro de `main`. Una copia de desarrollo no lleva sello.

### 9.2 Qué escribe `init`

**Cómo se usa en un proyecto nuevo** (lo que dice el README y las notas de la versión):

```
pnpm dlx https://github.com/luismichelcf/ai-workflows/releases/download/v1.0.0/ai-workflows-1.0.0.tgz init
```

`init` corre desde el paquete sellado, sin instalarlo antes. Hace, en este orden:
1. **Instala el motor en el proyecto:** añade la dependencia de desarrollo `ai-workflows` con la
   dirección del paquete de **su propia versión** y corre la instalación con el gestor que detecta
   por el archivo de bloqueo (`pnpm`, `npm` o `yarn`; sin ninguno, `pnpm`). Si la dependencia ya
   existe con otra versión, **no la cambia**: lo dice y sigue sin ganchos (paso 3), porque los
   ganchos cargarían otro motor. Si la instalación falla, se detiene con el motivo.
2. Escribe los archivos que falten (abajo).
3. Instala los ganchos, solo si el paso 1 dejó `node_modules/ai-workflows` en su versión.

`init --package <ruta o dirección>` usa ese paquete en vez de la dirección de la versión para el
paso 1, y comprueba que su `engine.json` es el mismo sello que el del `init` que corre (si no,
se detiene). Sirve para instalar sin red y para ensayar el paquete antes de publicarlo.

Escribe lo que falte, sin sobrescribir nunca, e informa cada archivo como «escrito» o «ya existía»:
- `.ai-workflows/pipeline.yml`: la receta de ejemplo, con la dirección del esquema de **esta**
  versión;
- los tres workflows del juez (juez, prueba roja, señal de revisión), con `uses:
  luismichelcf/ai-workflows@<sha sellado>  # v<versión>` y la entrada `branches` tomada de la
  receta;
- los ganchos de los tres clientes, igual que `hooks install --apply`.

Reglas:
- Los tres workflows son **todo o nada**. Si alguno ya existe, no se escribe ninguno de los tres y
  se nombra el que existe: un juez sin su señal queda a medias.
- Sin sello (copia de desarrollo), `init` no escribe workflows y lo dice con el motivo. Nunca pone un
  marcador ni el `HEAD`.
- `init --judge-only` escribe solo los tres workflows y toma `branches` de la receta que ya existe.
  **No toca `package.json`, el archivo de bloqueo ni los ganchos.** Es lo que usa la rebanada 7:
  Socialabs sigue con su dependencia en 0.3.0 durante la consulta (R24) y corre `init --judge-only`
  de v1.0.0 con `pnpm dlx`, sin instalarlo. El juez en GitHub no usa la dependencia del proyecto:
  usa la acción fijada por SHA.
- Al final, en llano, lo que `init` no puede hacer: ajustar los pasos de instalación de la prueba
  roja a tu proyecto, añadir tus workflows de checks exigidos a `workflow_run`, y la orden exacta
  para poner `AI_WORKFLOWS_MODE` en `off` o `advisory`. Encender (`on` y exigir el estado) queda
  siempre como paso aparte del dueño.

### 9.3 La publicación

- `package.json` pasa a `1.0.0`, sigue privado para npm (R28) y lleva licencia MIT, con su archivo
  `LICENSE` (R31).
- El workflow de publicación:
  - fija sus acciones por SHA;
  - corre la puerta también en Windows;
  - sella el paquete;
  - sube el paquete y `recipe.schema.json` como archivos de la versión (la dirección del esquema en
    las recetas hoy daría 404);
  - trae un modo de ensayo (`workflow_dispatch` con `dry-run`) que arma todo sin publicar.
- La versión publicada no se vuelve a subir: un arreglo es `v1.0.1`. Antes de publicar se activan
  en este repositorio las versiones inmutables de GitHub y una regla que protege las etiquetas `v*`
  (R31); después se comprueba que una versión publicada rechaza cambios.

**Qué commit se etiqueta.** Se etiqueta **el commit de cabeza del PR que revisó la parvada**, no el
de la fusión. Para que ese commit sea ancestro de `main` y su contenido sea el que queda en `main`:
- el PR se fusiona con **commit de fusión** (como todos los de este repositorio), nunca *squash* ni
  *rebase*;
- antes de fusionar, la rama está al día con `main` (sin commits de `main` que falten en la rama),
  así que el árbol del commit de fusión es idéntico al del commit revisado;
- el script de sello comprueba las dos cosas: que el commit etiquetado es ancestro de `main` y que su
  árbol es igual al del primer commit de fusión de `main` que lo contiene. Si no, no sella.

Orden, porque «merge no es versión»:
1. El PR de la rebanada se fusiona con la CI en verde y la parvada terminada, con commit de fusión.
2. Ensayo **de la orden única**, con el paquete que arma el modo `dry-run` del commit revisado:
   en una carpeta vacía con un repositorio nuevo (sin `package.json` previo, sin dependencia del
   motor), `pnpm dlx <paquete> init --package <paquete>`. Se comprueba: `package.json` con la
   dependencia, el archivo de bloqueo con su entrada, `node_modules/ai-workflows` con el mismo sello,
   la receta, los tres workflows con el SHA sellado, los ganchos de los tres clientes, `validate` en
   verde y un gancho del editor que rechaza una escritura sin pieza. Después, en
   `ai-workflows-pruebas`, `init --judge-only` desde el paquete y una pasada del juez con el SHA
   sellado, en `advisory`.
3. Se crea la etiqueta `v1.0.0` sobre el commit revisado y se publica.
4. Después de publicar: la dirección del esquema responde, y el mismo ensayo del paso 2 se repite
   **sin `--package`**, con la orden exacta del README desde la versión publicada. Si falla, el
   arreglo sale como v1.0.1.

### 9.4 Pruebas rojas

1. `init` con un sello inyectado escribe la receta y los tres workflows. Cada `uses` es
   `luismichelcf/ai-workflows@<sha dado>`, sin `<ENGINE_SHA>`. El esquema nombra la versión. La
   entrada `branches` coincide con la receta. Fuera de las sustituciones, cada archivo es igual
   byte a byte a su plantilla.
2. Sin sello → no escribe workflows y da el motivo. Con un sello mal formado → igual.
3. Un workflow ya existe → no escribe ninguno de los tres y lo nombra.
4. `init --judge-only` con receta existente → solo los tres workflows; `package.json`, el archivo
   de bloqueo y `.claude/` quedan idénticos byte a byte.
4b. Falla la escritura del segundo workflow → no queda ninguno de los tres escrito (se escriben a
   archivos temporales y se renombran al final; si un renombre falla, se borran los ya renombrados)
   y el motivo nombra el archivo.
4c. Proyecto sin dependencia del motor, con un ejecutor de instalación falso: se añade la
   dependencia con la dirección exacta de la versión sellada, se llama al gestor detectado y se
   instalan los ganchos. Con la dependencia en otra versión: no se cambia, no hay ganchos y lo dice.
   Con la instalación fallida: se detiene con el motivo y no escribe ganchos.
4d. `init --package <ruta>` con un paquete de otro sello → se detiene sin tocar nada; con el mismo
   sello → la dependencia apunta a esa ruta.
5. El `ai-workflows.yml` escrito pasa las comprobaciones de `tests/judge-templates.test.ts`.
6. El script de sello, sobre un repositorio temporal: escribe el commit de la etiqueta; falla si la
   etiqueta no es `v<versión>`, si el commit no es ancestro de `main`, si `HEAD` no es la etiqueta,
   o si el árbol del commit etiquetado difiere del de la fusión de `main` que lo contiene (rama
   atrasada); con una fusión *squash* (el commit no es ancestro) → falla.
7. El workflow de publicación: toda acción fijada por 40 hex, sube el paquete y el esquema, tiene
   Windows y la comprobación de ancestro.
8. El contenido del paquete (con `pnpm pack`, en su propia configuración de pruebas lentas): la
   lista exacta, con `engine.json` y las cuatro plantillas, y nada de `tests/`.

## 10. Revisión adversarial de la frontera (ADR 0219, condición 3)

La hace la parvada de la rebanada (R25), con dos revisores de seguridad en sesiones frescas, sobre
**el commit exacto que se va a etiquetar**. Lista mínima de lo que deben intentar, cada punto con
veredicto «cerrado», «aceptado y declarado (R13/ADR 0214)» o «hallazgo»:
1. El PR no controla el código que lo autoriza: YAML, acción, receta y bloques salen de la base de
   confianza, también en `staging` (§1.2).
2. El job con privilegios nunca ejecuta código del PR.
3. Imitar un estado del juez o de `todo-verde` desde otro workflow (R13, ADR 0214): se reafirma y
   el rastro lo reporta.
4. Checks exigidos con nombre prestado (§7).
5. La instalación del motor en el job del juez (`pnpm install` en la acción): scripts de
   dependencias con `statuses: write` en el mismo job. Se decide si se acepta y declara para 1.0.0
   o se cierra.
6. Quién puede cambiar `.ai-workflows/` en cada rama de `into`, y con qué protección.
7. Los ganchos locales como nivel A: el permiso de saltar la aprobación en Codex, scripts de
   instalación que reescriben `node_modules/ai-workflows` o `core.hooksPath`, y
   `settings.local.json`.
8. La integridad de la versión: etiqueta, sello, esquema y paquete.
9. El volumen de `issue_comment` y las cancelaciones que provoca (§8).

Los hallazgos se arreglan con su prueba roja. El arreglo, si toca la frontera, lo revisa un revisor
más sobre el delta (R25).

## 11. Evidencia real antes de publicar (R29)

Solo los casos que tocan lo nuevo, en `ai-workflows-pruebas`, con el arnés y el informe de la
rebanada 5. Se añaden al manifiesto:

| Caso | Qué prueba |
|---|---|
| SV-04s+ | Un PR que quita el gancho de `.claude/settings.json` se rechaza; con la atestación pasa. Otro que cambia la versión del motor en `package.json` se rechaza. Otro que sube una dependencia ajena pasa sin atestación. |
| CN-14 | El workflow impostor de la prueba roja no la da por buena (§7), en dos formas: otro nombre de archivo con el mismo nombre de job, y el archivo `ai-workflows-red-test.yml@falso.yml` (se anota si GitHub llega a ejecutarlo). Antes, con un PR abierto, se comprueba que `pull_requests` de su corrida trae el número, `base.ref` y `base.sha` que usa la cadena; si GitHub no los da, la cadena se rediseña antes de seguir. |
| RAMA-1 | Un PR hacia `staging` se juzga pieza por pieza con la receta de `staging`. |
| RAMA-2 | Un pase `staging → main` se juzga solo por archivos propios, sin y con atestación. |
| A-T3 | Grupo de la cola con tres checks casi simultáneos más el `merge_group` (cuatro disparos), sin corridas empezadas canceladas ni dos a la vez, y fusionado; sonda de cancelación a mano (§5). |
| B-T6 | Veredicto borrado y corrida cancelada: la cabeza queda en «juzgando» (§6). |
| BOT-1 | Un comentario de la aplicación con una dirección en un PR no crea corrida (§8). |

Más, en esta PC: R-CX1, R-OC1 y R-OC2 (§3.5), y el ensayo de `init` con el paquete sellado (§9.3).
Se estima una hora y, a lo sumo, un «Approve» del dueño. El orquestador avisa al teléfono antes de
pedirlo y recuerda a los 15 y 25 minutos. El informe dice qué casos son de esta corrida y remite al
de la rebanada 5 para el resto. No dice «completo» sobre casos que no corrió.

## 12. Orden de construcción

Cada encargo con su carpeta aparte (worktree), su prueba roja escrita por el orquestador y la puerta
corrida por el orquestador antes de integrarlo:
1. **Paso cero** (orquestador): capturar los formatos de Codex y OpenCode (§3.1) y medir el
   arranque del gancho en esta PC (§4).
2. **Encargo A:** §4 (plazo, git propio, vigilante, salida, fallo abierto).
3. **Encargo B:** §3 (traductores, cargador en archivo, instalador, `doctor`). Tras A.
4. **Encargo C:** §2 (archivos propios y versión del motor).
5. **Encargo D:** §1 (ramas y pases).
6. **Encargo E:** §5, §6, §7 y §8 (juez).
7. **Encargo F:** §9 (`init`, sello, publicación).
8. Parvada completa (§10 incluido) sobre el cambio entero. Arreglos, y un revisor por el delta si
   toca la frontera.
9. Evidencia real (§11) y el informe.
10. Un solo PR; tras fusionar, el ensayo y la publicación (§9.3).

A, C, D, E y F tocan archivos distintos y pueden ir en paralelo, cada uno en su worktree; B espera a
A. Donde dos toquen el mismo archivo (`judge.ts`: C, D y E), se integran en ese orden.

### 12.1 Límites que se declaran

- Un cambio que entró a una rama de `into` con el juez apagado o en consulta llega en el pase sin
  juicio por pieza (§1.3).
- La cola nativa solo en la principal (§1.6).
- Los ganchos de Codex y OpenCode, nivel A con lo medido en §3.5.
- La instalación del motor en el job del juez, según lo que decida §10.5.
- Si GitHub no deja leer la lista de PRs tras borrar un veredicto (tres intentos), el verde viejo
  puede quedar (§6).
- La prueba roja de un PR sin cola cuenta contra la base desde la que el PR se actualizó por última
  vez, aunque la rama destino haya avanzado después (§7, como hoy en la principal).

## 13. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura (sesión `01a0efa9-f1af-7661-b9e9-26c9ff840d87`):**
REVISE, 9 bloqueantes, todos aceptados:
1. Un verde podía servir a dos juicios con la misma cabeza → un veredicto por SHA, el peor de todos
   sus PRs hacia ramas de `into`; el cambio de destino fuera de `into` se justifica (§1.2).
2. Un pase desde una rama no juzgada → `from` también debe estar en `into` (§1.1).
3. El juicio desde el issue podía dejar el verde viejo antes de conocer los PRs o si fallaba el
   `pending` → reintentos, `pending` amplio con receta ilegible, PR sin `pending` no se juzga, y el
   caso sin lista de PRs se declara como límite (§6, §12.1).
4. La cola en fila → se justifica con la documentación de concurrencia (una corrida a la vez, una
   en espera que se sustituye) y la prueba real usa cuatro disparos (§5).
5. Origen del check ambiguo → cadena check-run → corrida → job → ruta en la base; los estados de
   commit ya no cuentan para la prueba roja del motor y se declaran para el proyecto (§7).
6. El patrón instalado podía no dejar llegar la herramienta desconocida → patrón `.*` en Codex,
   prueba con el patrón leído del archivo, y las pruebas reales exigen el motivo del motor (§3).
7. Alias de dependencia → se protege la clave que decide `node_modules/ai-workflows`, con pruebas
   de los dos alias (§2.2).
8. Qué commit se etiqueta → la cabeza revisada, fusión con commit de fusión y rama al día,
   comprobado por el sello (§9.3).
9. `init` no dejaba instalado el motor local → `init` instala la dependencia de su versión;
   `--judge-only` no toca dependencias (§9.2).

No bloqueantes aplicados: la frase obsoleta de R04; prueba de escritura fallida a mitad de `init`.

**Además, del paso cero** (§3.1): Codex 0.159.0 en Windows ignora el rechazo con salida 2 y respeta
el JSON con salida 0; OpenCode 1.18.30 bloquea también las escrituras de un subagente. El diseño
de §3 se ajustó a lo medido.

**Ronda 2 — misma sesión (versión 2):** REVISE; confirmó cerrados 2, 3, 4, 6, 7 y 8 de la ronda 1
(el 1, el 5 y el 9, parcialmente) y dejó 5 bloqueantes, todos aceptados:
1. La prueba roja de una base anterior podía contar tras un cambio de destino → la cadena exige que
   la corrida sea de este PR y de su base actual; fork declarado (§7).
2. `staging` podía avanzar durante el juicio → relectura de la punta de cada rama destino antes de
   publicar (§1.2).
3. La cadena estricta rompía checks de otras aplicaciones → solo para la prueba roja del motor; los
   checks del proyecto siguen la regla de R3 §4 y se declaran (§7).
4. El peor veredicto no se recalculaba al cerrar un PR → el juez escucha `closed` y rejuzga los que
   comparten cabeza (§1.2).
5. Faltaba probar la orden única de `init` → `--package` para ensayar el paquete antes de publicar,
   ensayo en carpeta vacía y repetición con la versión publicada (§9.2, §9.3).

No bloqueantes aplicados: §11 alineado a cuatro disparos; cómo salen de la espera los PRs ajenos
(§6).

**Ronda 3 — misma sesión (versión 3):** REVISE; confirmó atendidos los cinco de la ronda 2 y dejó 3
bloqueantes, aceptados:
1. La prueba roja ligada al nombre de la base y no a su commit → se exige `base.sha` igual a la
   punta o ancestro suyo, con la razón (la misma regla de la principal sin cola) y el límite
   declarado; se comprueba en real que GitHub da esos campos (§7, §11, §12.1).
2. Un PR que sale de `into` dejaba obsoleto el veredicto compartido → se rejuzgan los demás también
   en `edited` (§1.2).
3. `path` con sufijo de referencia → se separa y se prueban las dos formas (§7).

No bloqueante aplicado: el paso de decisión no publica «juzgando» en `closed` ni al salir de `into`
(§1.2).

**Ronda 4 — misma sesión (versión 4):** REVISE, 1 bloqueante, aceptado: recortar el sufijo de
`path` dejaba pasar un archivo llamado `ai-workflows-red-test.yml@falso.yml` → la ruta se toma
exacta del workflow de la corrida (`workflow_id`), sin recortar, y CN-14 intenta ese nombre (§7,
§11). Confirmó sin otro riesgo la regla del `base.sha` ancestro. No bloqueante aplicado: «solo si
no queda ninguno» (§1.2).

**Ronda 5 — misma sesión (versión 5):** **APPROVE**, sin bloqueantes. No bloqueante aplicado: la
frase del cambio de destino fuera de `into` precisa «sin otros PRs con esa cabeza» (§1.2).

## 14. Decisiones del dueño que aplica esta rebanada

R24–R31 de PLAN-13 §2, anotadas en el mismo PR.

## 15. Arreglos de la parvada (30-sep)

La parvada completa (R25: correctitud, dos de seguridad, contrato, pruebas con 108 mutantes) revisó
el cambio entero. Cada arreglo lleva su prueba roja. Decisiones del dueño que salieron de ella:
R32, R33 y R34.

**Bloqueantes:**
- **P1. El juicio desde el issue no aplicaba «un veredicto por SHA, el peor»** ni la comparación de
  la entrada `branches` con la receta: con dos PRs de la misma cabeza ganaba el último veredicto. Se
  agrupan los PRs por cabeza; por cada cabeza se juzgan **todos** los PRs abiertos con ella hacia
  `into` (de otra pieza y pases incluidos) y se publica el peor una sola vez; si la entrada y la
  receta no coinciden, error con el motivo en cada cabeza (§1.2, §6).
- **P2. La relectura de la punta rompía con dos PRs hacia la misma rama:** al cambiar la punta, se
  actualizan todos los juicios de esa rama a la vez, y «volvió a cambiar» se cuenta por rama (§1.2).
- **P3. Mezclas cruzadas:** con varias bases de mezcla, los archivos propios y la versión del motor
  se miden sobre **lo que de verdad entra**: la unión de los cambios contra todas las bases de mezcla
  y del árbol de mezcla (`git merge-tree`) contra la punta de confianza. Un conflicto cuenta como
  tocado (§2).
- **P4. El sello no funcionaba al empujar la etiqueta** (sin rama `main` local) y una etiqueta
  llamada `main` podía engañarlo: el sello exige una referencia completa (`refs/remotes/origin/…` o
  `refs/heads/…`) y la publicación pasa `refs/remotes/origin/<principal>`. El ensayo acepta el SHA
  revisado como entrada (§9.1, §9.3).
- **P5. La orden de Codex no tenía reloj propio:** git con 3 s y el cargador con lo que queda hasta
  27 s; al vencer, rechazo con salida 0 (§3.3, §4).
- **P6. El gancho leía la entrada antes de armar el vigilante:** el vigilante se arma al arrancar y
  la lectura de la entrada queda dentro de su plazo (§4).

**Menores aplicados:** archivos propios de R32 (y `.opencode/plugin/`, `.opencode/tool/`,
`.opencode/tools/`, y claves del bloqueo con `/` inicial); `closed` y `edited` hacia fuera respetan el
modo apagado; motivo de «no coinciden las ramas» en el idioma de la receta; el plugin de OpenCode
busca el cargador en la raíz del repositorio; herramientas de solo lectura conocidas (`list` de
OpenCode, `view_image` de Codex) pasan; reinstalar reemplaza la entrada vieja de Codex y `doctor`
compara con lo que instala, avisa un tiempo de Codex de 25 s o menos y `disableAllHooks`; el
cargador de OpenCode no rotula un rechazo del motor como falla; `hooks install` nombra lo que
escribió y el límite de Codex `exec`; la publicación con permisos mínimos por trabajo, sin llave
guardada en el checkout, notas con `pnpm dlx … init` y la prueba del contenido del paquete antes
de empaquetar; `init` rechaza correr desde una subcarpeta, instala los ganchos aunque los workflows
ya existan, habla en el idioma de la receta, lanza el instalador sin consola intermedia, dice la
orden exacta de `AI_WORKFLOWS_MODE` y que los archivos se guardan en una rama de pieza, falla si la
plantilla no trae dónde escribir `branches`, cita el valor de `branches` e informa bien un rollback
fallido; `explain` en inglés dice «or»; R34 (la parte local mide contra `into[0]`); pruebas para los
mutantes que sobrevivieron; README, comentarios de las plantillas y §12 del plan al día.

**Declarados (§12.1):** R33; las corridas de la prueba roja listan todos los PRs abiertos con esa
cabeza, así que con dos PRs de la misma cabeza hacia ramas distintas la cadena no distingue cuál la
disparó (se mide en CN-14); la protección de `from` en un pase no la comprueba ninguna orden (el
README pide exigir el juez en las dos ramas); cualquier `User` que comente con `/` despierta al juez
(falla cerrado; cuesta minutos); sin `node` en el PATH, la orden de Codex no puede rechazar.
