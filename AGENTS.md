# ai-workflows — instrucciones para agentes

Motor genérico de etapas para agentes de código: cada proyecto declara su proceso y el motor lo
impone con compuertas verificadas por código. **Esta es la tarjeta esencial.** El plan vigente
está en [`docs/plans/PLAN-13.md`](docs/plans/PLAN-13.md) (issue #13); léelo antes de trabajo
sustantivo. Muchas reglas vienen de Socialabs, el primer proyecto que usa el motor, adaptadas a
este repositorio.

## Cómo hablarle al dueño y cuándo consultarlo

- El dueño no es programador. Háblale en español llano: primero la conclusión, lo más corta
  posible, sin jerga ni nombres de archivos o comandos, salvo que tenga que hacer algo con ellos.
  En opciones, primero la recomendación y luego la consecuencia práctica de cada una, con una
  comparación cotidiana si ayuda.
- **Antes de preguntar, lee lo ya decidido:** §2 del plan (R01–R13) y su bitácora de revisión. Si
  una decisión vigente resuelve la duda, aplícala citándola. Si no hay prioridad clara entre
  reglas, consulta al dueño; no elijas por tu cuenta.
- **Aprobado, continuar hasta terminar**, sin volver a pedir permiso para avanzar. Una duda nueva
  no detiene lo independiente: se hace y la decisión pendiente queda en el reporte.
- **Solo frenan una corrida aprobada:** tocar Socialabs (ver abajo), destrucción irreversible fuera
  del plan, gasto nuevo de dinero o descubrir otro alcance.
- No agregues funciones, campos ni decisiones de diseño que el dueño no pidió: proponlos primero.
- Toda decisión nueva del dueño se agrega a §2 del plan **en el mismo PR** que la aplica.

## Separación de Socialabs (R01): regla dura

- **Ningún commit, rama, PR, issue ni cambio de configuración** en `socialabs-margin/Socialabs`
  por esta pieza hasta la rebanada 7, que abre su propio issue allá con aprobación del dueño.
  Leer su código para entenderlo está permitido.
- Se prueba en `socialabs-margin/ai-workflows-pruebas` (intentos de trampa) y, en la rebanada 6,
  en una copia privada de Socialabs **sin ninguna llave ni destino de producción** (R07, EG-01).
- Socialabs sigue fijado a la versión 0.3.0 del motor. No publiques 1.0.0 antes de la rebanada 6.

## Repositorio público

Este repositorio es público. Nunca subas llaves, tokens, datos de personas, direcciones de
producción ni rutas de la PC del dueño. Nada propio de un proyecto vive en el motor (R05): lo de
Socialabs va en su receta y sus bloques, nunca aquí.

## Stack

TypeScript estricto, Node 20 o más, **pnpm 10**, Vitest. Código, comandos y configuración en
inglés; lo que lee el dueño, en el idioma del proyecto (`locale`). No cambies el stack ni añadas
dependencias sin avisar al dueño; cada dependencia nueva se justifica en el PR.

## Primero la prueba que falla

**Todo cambio de comportamiento y todo bug empieza con una prueba roja**, luego el código mínimo
que la pone verde: una prueba → su implementación → la siguiente. El orquestador escribe la prueba
y el constructor la pone verde sin editarla. Antes de commitear, retira solo la implementación,
comprueba que la prueba vuelve a fallar por la razón esperada, restáurala y reporta la evidencia.
Esperados desde una regla o un literal conocido, nunca recalculando la fórmula del código. Mocks
solo en los bordes externos; lo que toca GitHub se prueba además contra un repositorio real.
Fuera: documentación y configuración sin comportamiento.

## Construcción y revisión (R12)

- **Constructor desde la rebanada 2: DeepSeek V4.1 Flash `high`** por OpenCode (R17). Relevo por
  cuota, autenticación o dos intentos fallidos: **GPT-6 Sol `high`**. **Revisión del código: parvada de revisores Claude
  en sesiones frescas**, cada uno desde un ángulo (correctitud, seguridad, contrato del motor,
  pruebas). La elección vale para toda la pieza; no se vuelve a preguntar.
- El orquestador escribe pruebas, encargos y documentación; el constructor escribe el código. El
  orquestador revisa el diff, corre la puerta él mismo y commitea. **Ningún «todo verde» de un
  constructor cuenta**, ni un exit 0.
- **Parvada en cada rebanada**, sobre el cambio final y antes de fusionar; sus bloqueantes se
  resuelven y un cambio posterior se revisa por su delta. Ningún constructor se aprueba a sí mismo
  ni delega.
- El encargo al constructor lleva objetivo, sección del plan, carpeta absoluta, archivos
  autorizados, exclusiones, pruebas y estado del diff, y termina con: «Eres el constructor
  delegado; el orquestador conserva el control. No delegues este encargo ni actúes como
  orquestador. No modifiques las pruebas entregadas. Do not commit. No push, PR, merge ni release.»
- **Una orden de shell simple por llamada** en los encargos (sin `;`, `&&`, `|` ni redirecciones):
  las compuestas pueden quedarse esperando una aprobación que nunca llega.

### Cómo lanzar a los modelos en esta PC (Windows)

- **Sol 6:** el CLI de npm (0.153) lo rechaza con una cuenta de ChatGPT. Usa el binario de la app
  de escritorio, `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`:
  `codex.exe exec -m gpt-6-sol -c 'model_reasoning_effort="high"' --json - < encargo.md > salida.jsonl`.
  Para construir, `--sandbox workspace-write`; para revisar, `--sandbox read-only`. Para continuar
  la misma conversación: `exec resume <thread_id>`, con el sandbox por
  `-c 'sandbox_mode="…"'` (resume no acepta `--sandbox`). El sandbox de Windows a veces falla sin
  avisar: juzga por `git diff`, no por el código de salida.
- **DeepSeek:** `opencode.exe run -m deepseek/deepseek-flash --variant high --auto --format json
  --dir <carpeta> "<encargo>"`, con el ejecutable directo (no el `.cmd`). Comprueba el modelo con
  `opencode export <sessionID>`. Si solo aparece `step_start` durante minutos, está saturado: pasa
  al relevo.
- Lanza las rondas largas en segundo plano y guarda la salida en un archivo; no cortes la tubería.

## Carpetas y sesiones

Una carpeta por rebanada y un solo escritor por carpeta. Nunca dos sesiones escribiendo en
`C:\GitHub\ai-workflows` a la vez: si hace falta paralelo, usa un worktree por rebanada.

## Puerta y PRs

- **`pnpm check` en 0 antes de commitear** (tipos + todas las pruebas). La CI la repite en Linux y
  Windows; un check que no corre no está en verde, y una prueba inestable se relanza, no se salta.
- Todo por PR, un PR por rebanada. Título `tipo(13): descripción (parte N)`; cuerpo en español con
  «Parte de #13», y el último con `Closes #13` en línea suelta. Antes de fusionar, un resumen en
  llano en el issue y la casilla de la rebanada marcada.
- Se fusiona solo con la CI en verde **y** la parvada terminada sin bloqueantes.
- **Merge no es versión.** Publicar una versión del motor es crear su GitHub Release con el paquete
  compilado; una versión publicada no cambia.

## Fallos

Nunca disfraces un fallo: error honesto, motivo y rastro. Sin `catch` que se trague errores. Un
comando obligatorio que no pudo correr queda bloqueado, nunca aprobado (§1.1 del plan). Lo que
corre en GitHub se prueba una vez donde realmente corre antes de darlo por bueno.
