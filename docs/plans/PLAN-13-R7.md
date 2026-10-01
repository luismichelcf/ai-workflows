# PLAN-13 · Rebanada 7 — El juez en Socialabs, en modo consulta

Diseño de la rebanada 7 de [PLAN-13](PLAN-13.md) (issue #13), con las decisiones del dueño R24,
R30 y R36–R42. Autor: Claude Opus 5.5 (orquestador). Revisor del diseño: GPT-6 Sol `high`.
Versión 2 · 1-oct-2026 · **Aprobado** por GPT-6 Sol `high` en 2 rondas (§13).

## En tres líneas

**Qué pasa hoy:** el motor v1.0.0 está publicado, pero Socialabs sigue con su proceso escrito en
`CLAUDE.md` y sus ADR, sin nadie que lo vigile en GitHub más allá de `todo-verde`.
**Qué cambia:** un PR en Socialabs instala solo el juez, fijado a v1.0.0, con una receta que copia el
proceso vigente; el juez opina en un estado aparte (`ai-workflows/advisory`) y no bloquea nada; se
observa dos semanas con un resumen cada viernes.
**Por qué importa:** decidir si encender el motor con números reales de Socialabs, no con ensayos.

## 0. Alcance

Dentro (todo en `socialabs-margin/Socialabs`, con su propio issue y la aprobación explícita del
dueño, R01):
- la receta `.ai-workflows/pipeline.yml` (§2);
- el workflow del juez y la señal de revisión, escritos por `init --judge-only` de v1.0.0 (§3);
- una excepción en `tests/ci/disparadores-workflows.test.ts` solo para el workflow del juez (R36);
- un ADR de Socialabs que declara la consulta, la excepción, lo que el juez no impone y R33;
- la variable `AI_WORKFLOWS_MODE=advisory`, puesta justo después de que el juez llegue a `main`;
- la observación de dos semanas (R39) y su informe.

Fuera: la parte junto al agente (llega al encender, R24); el workflow de la prueba roja (R37);
retirar lo dormido de 0.3.0 (R40); la dependencia del motor en `package.json` (sigue en 0.3.0, R04);
cambios a las protecciones (`rulesets` 20211188 y 23950317 no cambian); encender (otra decisión).

## 1. El proceso de Socialabs que copia la receta (R10, R30)

Fuente: `CLAUDE.md` de `origin/staging` y los ADR vigentes (0094, 0110, 0141, 0154, 0170, 0175,
0204, 0230, 0236–0264). Lo que el juez puede comprobar en el servidor se declara como etapa con
`server:`; lo que no, se declara en el ADR como «no impuesto» con su motivo.

| Regla vigente | En la receta |
|---|---|
| Pieza ↔ issue por rama `tipo/NNN-…` | `pieces.branch: ["*/{piece}", "*/{piece}-*"]`; `exclude-branches: ["proto/*"]` |
| El trabajo entra a `staging`; pases `staging → main` y traídas `main → staging` (ADR 0236) | `branches: {into: [staging, main], promotions: [{from: staging, to: main}, {from: main, to: staging}]}` |
| Puerta en verde (`todo-verde`, ADR 0236/0175/0204) | etapa `checks`, `server: {require-check: todo-verde}` |
| Prueba roja primero (ADR 0110), salvo visual, configuración, generado, papeles | etapa `red-test` con `applies-if` por tipo; **informativa** durante la consulta (R37): `required: false`, `server: local-only` |
| Parvada en dinero, permisos, producción, escritorio (ADR 0094/0141/0238) | etapa `independent-review` **informativa** (R38): `required: false`, `server: local-only`; el juez la nombra y no la exige |
| Fusión a staging con auto-merge aplastado (ADR 0236 §6, CLAUDE.md «`--auto --squash`») | etapa `merge` con `github-merge@1` y `with: {method: squash}` (las etapas de fusión son solo locales) |
| Archivos propios y versión del motor | del motor (R26, R32), sin etapa |

**Tipos de cambio:** `comportamiento` por omisión (ADR 0110), y desde las rutas `papeles`,
`configuracion` y `solo-visual` (por rutas que no dejan duda). Sin línea «Tipo de cambio» (Socialabs
no la escribe; no se inventa la regla, §1.4 del reconocimiento): lo visual que no se distingue por
rutas cuenta como `comportamiento` y se anota como aviso falso conocido.

**Clases, con las dos estructuras de carpetas (R42).** v1.0.0 no admite llaves `{a,b}` en los
patrones: cada ruta va por separado (receta completa en el Anexo A).
- dinero: `lib/calc/**`, los nombres de dinero de hoy (nomina, pago, sueldo, compensacion,
  rentabilidad, margen, costo, bolsa, dinero, cierre, cada uno como archivo y como carpeta) y las
  carpetas `domain` de rentabilidad, pagos variables, desempeño y tiempo de la estructura nueva;
- migraciones de base de datos (`sql`): `supabase/migrations/**` y `ramas/supabase/migrations/**`. Es
  una clase **aparte** de permisos: ADR 0094 pide la parvada para el SQL de permisos, no para toda
  migración, y eso no se distingue por la ruta; el informe revisa a mano el contenido de cada
  migración marcada (§4);
- permisos: nombres auth/login/permiso/permission/rls y `src/infrastructure/permisos/**`,
  `src/infrastructure/auth/**`;
- producción: los workflows de producción por nombre, scripts de migrar, `supabase/functions/**`,
  `vercel.json`;
- escritorio: `electron/**` y `electron-builder.yml` (el `CHANGELOG-escritorio.md` es papel, no
  núcleo);
- visible: `app/**`, `components/**`, `public/**`, `src/features/*/components/**`, `src/shared/ui/**`.

v1.0.0 no puede excluir rutas de una clase: un archivo de pruebas o de pantalla con un nombre de
dinero (`historial-margen.test.ts`, `cierre/page.tsx`) cuenta como dinero aunque ADR 0094 exime
pruebas y pantallas. Se anota como aviso falso conocido (candidato a v1.0.1).

Las rutas exactas de la estructura nueva se ajustan al ADR de Omar cuando exista; mientras, la
receta lleva las de su propuesta.

## 2. Lo que el juez no impone y se declara

**Avisos falsos conocidos durante la consulta** (no son reglas nuevas; se cuentan aparte, R41):
papeles sin número de issue (`docs/<tema>`); ramas de arreglo urgente sin número
(`hotfix/<nombre>`, que CLAUDE.md permite); traídas de `main` a `staging` que no salen de `main`;
lo visual que no se distingue por rutas; archivos de pruebas o pantallas con nombres de dinero; `build-desktop-prueba.yml` contado como producción. El
juez los marca «sin pieza» o les pide etapas que no tocan; el informe los separa y van a v1.0.1.


Pase con el visto bueno del dueño y fusión con el botón (ADR 0236 §2/§6, 0258); etiqueta «a
producción» (ya lo hace `marca-a-produccion.yml`); qué ramas pueden entrar a `main` (ya lo hace el
trabajo `promocion` de `todo-verde`); aprobar lo visible en staging (ADR 0236 §3); recorrido en
navegador (ADR 0253); capturas y accesibilidad en el cuerpo del PR; título con número (ADR 0154:
sin candado); especificación en el issue y planes irregulares (ADR 0131/0133/0230); benchmark;
modelo por rol; un escritor por carpeta; tablero; retiro de papeles (ADR 0230). La parvada sobre lo
que incluye un pase (ADR 0238) no se puede expresar en v1.0.0: es candidata a v1.0.1.

## 3. La instalación

1. Issue en Socialabs y rama `chore/<n>-juez-en-consulta` desde `staging` (con el «sí» explícito
   del dueño, R01).
2. Receta (§1) y, desde esa carpeta, `pnpm dlx <v1.0.0>.tgz init --judge-only`: escribe los tres
   workflows fijados a `luismichelcf/ai-workflows@e89bf55…  # v1.0.0` con `branches: "staging,
   main"`. Se borra el de la prueba roja (R37); se conservan el del juez y la señal de revisión.
3. En el workflow del juez, `workflow_run.workflows` nombra `"Validación de pull request"` (el
   `name:` de `pull-request-validation.yml`, único productor de `todo-verde`) y la señal de revisión.
4. Excepción en `tests/ci/disparadores-workflows.test.ts` solo para `ai-workflows.yml`, con su prueba
   roja primero (proceso de Socialabs), y el ADR (número siguiente a 0264, índice regenerado).
5. PR a `staging` según el proceso de Socialabs (toca `.github/workflows/**`: producción → parvada
   antes de armar la fusión, ADR 0141). Luego el pase `staging → main`: se pregunta al dueño antes
   (ADR 0258) y el dueño lo fusiona con el botón.
6. Con el juez en `main`, `gh variable set AI_WORKFLOWS_MODE --body advisory` en Socialabs (cambio de
   configuración aprobado en el issue). Sin la variable, el juez publica «motor apagado».
7. Comprobación real: el siguiente PR hacia `staging` recibe `ai-workflows` en verde «modo
   consulta» y su veredicto en `ai-workflows/advisory`; ningún `ruleset` cambia; `todo-verde`
   sigue siendo lo único exigido.

**Apagado:** `gh variable set AI_WORKFLOWS_MODE --body off`, al instante y sin PR; o borrar los dos
workflows en un PR (archivos propios: con la atestación del dueño).

## 4. Observación (R39) y lo que se cuenta

Dos semanas desde que la variable queda en `advisory`. El orquestador lleva **una tabla por PR**
(no por corrida): número, rama, destino, autor, versión final juzgada (la cabeza al fusionar), el
último veredicto de `ai-workflows/advisory` sobre esa cabeza y su motivo, las clases que tocó
(leídas del diff del PR con las reglas de la receta, porque el juez no publica las clases) y la
**clasificación a mano** contra las reglas vigentes de Socialabs: lo habría dejado pasar con razón,
frenado con razón, frenado por error (y si es un aviso falso conocido de §2), o técnico. Las
corridas repetidas sobre el mismo PR cuentan una sola vez, por su versión final. Las migraciones
marcadas se revisan a mano: si tocan permisos (grants, políticas, RLS), cuentan para la parvada.

Cada viernes, en el issue de la rebanada 7, tres líneas con los conteos de la tabla y los minutos de
Actions del juez (de la API de corridas del workflow); la tabla completa va como archivo en el
issue. Nada se escribe en los PRs de otros. Al final: la lista de arreglos para v1.0.1 y la pregunta
al dueño de si encender.

## 5. Riesgos que se declaran en el ADR de Socialabs

- R33: el juez instala sus dependencias en cada corrida; su token puede leer el código (repositorio
  privado) y publicar estados. Ningún secreto se referencia.
- Los PRs que entran a `staging` durante la consulta llegan a `main` sin juicio por pieza en el pase.
- Minutos: unas 100–300 por día del juez (5–10 % más); la organización consume ya 2 000–3 500
  diarios y el dueño revisa lo incluido en su plan.
- Ventana entre fusionar a `staging` y el pase: el juez aún no está en `main` y no corre.

## 6. Pruebas

- En Socialabs: la prueba roja de la excepción (un workflow con `pull_request_target` que no es el
  juez sigue rechazado; el del juez se acepta) y la puerta completa de Socialabs.
- En ai-workflows, antes del PR de Socialabs: `ai-workflows validate` de la receta con v1.0.0 y un
  ensayo de lectura con `explain`; y la receta probada contra los PRs fusionados de la última
  semana (solo lectura) para anticipar lo que el juez dirá.
- Real: el primer PR tras activar la variable (§3.7).

## 7. Propuestas para después (no en esta rebanada)

- v1.0.1 con lo que la observación confirme (prueba roja que se calla en consulta y no juzga pases;
  papeles sin pieza; parvada en el pase; exclusiones en `classify`).
- DRY/SOLID: las reglas medibles (duplicados, tamaño, fronteras entre funcionalidades) viven en la
  verificación de Socialabs (ADR de Omar) y el juez solo exige `todo-verde`; lo no medible, como
  ángulo «arquitectura» de la parvada con lista concreta, se propone como cambio de receta aparte
  después de la observación (R10).

## 13. Bitácora de revisión

**Ronda 1 — GPT-6 Sol `high`, solo lectura (sesión `01a0f99f-718a-7552-9b6d-4adf95b7f728`):**
REVISE, 5 bloqueantes, aceptados: la receta completa en el Anexo A, validada con v1.0.0
(`validate`: «valid recipe, 4 stages»; requiere `agent-account`, que nombra la aplicación de los
agentes sin imponer nada); la fusión aplastada como dice Socialabs; las ramas `hotfix/<nombre>`
sin número como aviso falso conocido; migraciones como clase aparte con revisión a mano y el
changelog fuera de escritorio; el informe como tabla por PR clasificada a mano.

**Ronda 2 — misma sesión (versión 2):** **APPROVE**, sin bloqueantes; validó la receta por su cuenta
(«valid recipe, 4 stages»). No bloqueantes: `build-desktop-prueba.yml` queda como aviso falso
conocido (§2); los rulesets 20211188 y 23950317 se confirmaron el 1-oct en el reconocimiento (solo
`todo-verde`, sin cola) y se vuelven a comprobar justo antes de instalar.

## Anexo A. La receta de Socialabs (borrador validado con v1.0.0)

Vive en Socialabs (`.ai-workflows/pipeline.yml`), no en el motor (R05). Se copia aquí solo para la revisión del diseño.

```yaml
# yaml-language-server: $schema=https://github.com/luismichelcf/ai-workflows/releases/download/v1.0.0/recipe.schema.json
#
# Receta de Socialabs (rebanada 7 de ai-workflows#13): copia el proceso vigente de CLAUDE.md y sus ADR,
# sin reglas nuevas (R10). Durante la consulta el juez solo opina (AI_WORKFLOWS_MODE=advisory).
# Lo que no impone el juez está en el ADR de la consulta.

version: 1
locale: es
owner: luismichelcf
agent-account: "socialabs-agentes[bot]"   # la aplicación de los agentes (R21); hoy sin uso en Socialabs

classify:
  dinero:
    - "lib/calc/**"
    - "**/*nomina*"
    - "**/*nomina*/**"
    - "**/*pago*"
    - "**/*pago*/**"
    - "**/*sueldo*"
    - "**/*sueldo*/**"
    - "**/*compensacion*"
    - "**/*compensacion*/**"
    - "**/*rentabilidad*"
    - "**/*rentabilidad*/**"
    - "**/*margen*"
    - "**/*margen*/**"
    - "**/*costo*"
    - "**/*costo*/**"
    - "**/*bolsa*"
    - "**/*bolsa*/**"
    - "**/*dinero*"
    - "**/*dinero*/**"
    - "**/*cierre*"
    - "**/*cierre*/**"
    - "src/features/rentabilidad/domain/**"
    - "src/features/pagos-variables/domain/**"
    - "src/features/desempeno/domain/**"
    - "src/features/tiempo/domain/**"
  sql:
    - "supabase/migrations/**"
    - "ramas/supabase/migrations/**"
  permisos:
    - "**/*auth*"
    - "**/*auth*/**"
    - "**/*login*"
    - "**/*login*/**"
    - "**/*permiso*"
    - "**/*permiso*/**"
    - "**/*permission*"
    - "**/*permission*/**"
    - "**/*rls*"
    - "**/*rls*/**"
    - "src/infrastructure/permisos/**"
    - "src/infrastructure/auth/**"
  produccion:
    - ".github/workflows/build-desktop*.yml"
    - ".github/workflows/database-migrations*.yml"
    - ".github/workflows/refrescar-staging.yml"
    - ".github/workflows/tablero.yml"
    - ".github/workflows/vigilar-freno-sesion.yml"
    - "scripts/migrar*"
    - "supabase/functions/**"
    - "vercel.json"
  escritorio:
    - "electron/**"
    - "electron-builder.yml"
  visible:
    - "app/**"
    - "components/**"
    - "public/**"
    - "src/features/*/components/**"
    - "src/shared/ui/**"

kinds:
  names: [comportamiento, solo-visual, configuracion, papeles]
  default: comportamiento
  from-paths:
    papeles: ["docs/**", "**/*.md", "Plans/**"]
    configuracion: [".github/**", "*.config.*", "tsconfig.json", "vercel.json", "components.json", ".prettier*", "tests/setup/test-durations.json"]
    solo-visual: ["styles/**", "**/*.css", "public/**"]

pieces:
  branch: ["*/{piece}", "*/{piece}-*"]
  exclude-branches: ["proto/*"]

branches:
  into: [staging, main]
  promotions:
    - { from: staging, to: main }
    - { from: main, to: staging }

labels:
  dinero: "dinero y cálculo"
  sql: "migraciones de base de datos"
  permisos: "permisos y acceso"
  produccion: "automatizaciones de producción"
  escritorio: "núcleo de escritorio"
  visible: "lo que se ve"
  comportamiento: "comportamiento"
  solo-visual: "solo visual"
  configuracion: "configuración"
  papeles: "papeles"

stages:
  - id: red-test
    summary: "Primero una prueba que falla (ADR 0110); informativa durante la consulta (R37)"
    nature: execution-record
    required: false
    applies-if: { kind-any: [comportamiento] }
    valid-while: forever
    gate:
      uses: ai-workflows/red-test@1
      with: { command: "pnpm vitest run {tests}" }
    server: local-only

  - id: checks
    summary: "La puerta en verde: todo-verde (ADR 0236)"
    after: red-test
    nature: recompute
    gate:
      uses: ai-workflows/command@1
      with: { command: "pnpm check", timeout-minutes: 30 }
    server: { require-check: todo-verde }

  - id: parvada
    summary: "Parvada en dinero, permisos, producción o escritorio (ADR 0094); solo se anota durante la consulta (R38)"
    after: checks
    nature: attest
    required: false
    applies-if: { touches-any: [dinero, sql, permisos, produccion, escritorio] }
    valid-while: same-fingerprint-or-clean-update
    gate:
      uses: ai-workflows/independent-review@1
      with: { forbid-same-family: true, angles: [correctitud, seguridad] }
    server: local-only

  - id: merge
    summary: "Entra a staging con auto-merge aplastado (ADR 0236 §6)"
    after: parvada
    phase: merge
    nature: recompute
    valid-while: same-sha
    gate:
      uses: ai-workflows/github-merge@1
      with: { method: squash }
```
