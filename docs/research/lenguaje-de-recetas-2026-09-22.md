# Lenguaje de recetas para ai-workflows: motor + receta declarativa + bloques reutilizables

Fecha: 2026-09-22 · Base previa: `docs/investigaciones/pipeline-agentes-herramientas-existentes-2026-09-11.md`
(61 fuentes; no se repite). Material local leído: `pipeline.config.ts` (1 848 líneas), motor
`C:\GitHub\ai-workflows\src` (v0.2.1 local; `contract.ts` define `StageConfig` = `name`, `after`,
`nature`, `appliesWhen()`, `stillValid()`, `needsHuman`, `gate()`).
Marcas: **[E]** evidencia de fuente primaria · **[I]** inferencia mía · **[A]** ausencia de evidencia.

## Conclusión (primero)

1. **Formato: YAML 1.2 estricto + JSON Schema publicado por el motor + comando `validate`.** Es lo
   que usan todos los sistemas de la familia «Actions» (GitHub, GitLab, Argo, Tekton, Buildkite,
   Taskfile), el único con editor que autocompleta y valida sin instalar nada propio, y tiene
   parser JS maduro que por omisión ya evita el «problema de Noruega».
2. **Condiciones de compuerta: CEL, solo en dos campos** (`applies-if` y `pass-if`), más un atajo
   estructurado para el caso común «toca estas rutas» (patrón Tekton `input/operator/values` + `cel:`).
   CEL es no Turing-completo, sin efectos, de tiempo lineal y lo usan Kubernetes, Tekton e IAM de
   Google. Riesgo: en JS la implementación de Buf está en **beta**.
3. **Reparto: la receta declara el orden, la aplicabilidad, la vigencia y los umbrales; los hechos y
   las comprobaciones con efectos viven en bloques** (`uses:` bloques del motor versionados, `uses: ./`
   bloques locales con manifiesto, y `run:` como escape con contrato JSON en stdout).
4. **Estimación [I]:** del `pipeline.config.ts` actual, ~20–25 % se vuelve YAML (≈200–280 líneas de
   receta), ~55 % pasa a bloques genéricos del motor (sirven a cualquier empresa) y ~15–20 % queda
   como bloques locales de Socialabs (fila, QA en Vercel, visto bueno, release, limpieza, arquitectura).
   Los ~5 000 líneas de scripts siguen existiendo: pasan a ser el cuerpo de los bloques locales.

## 1. Cómo separan «motor» y «receta» los sistemas declarativos

| Sistema | Receta del proyecto | Bloques reutilizables | Escape a lógica propia | Condición / compuerta |
|---|---|---|---|---|
| GitHub Actions | workflow YAML | acciones JS, Docker y compuestas con `action.yml`; workflows reutilizables (`workflow_call`) | `run:` (shell) | `if:` con expresiones `${{ }}`; checks requeridos; entornos con revisores |
| GitLab CI | `.gitlab-ci.yml` | `include` (local/project/remote/template/**component**), `extends`, componentes con `spec:inputs` versionados y catálogo | `script:` | `rules:if`, `rules:changes`, `rules:exists`, `when: manual` |
| Argo Workflows | Workflow YAML (CRD) | `WorkflowTemplate` + `templateRef`; tipos container/script/resource/**suspend**/http/plugin | plantilla `script` | `when:` (govaluate; o `expr` con `{{= }}`) |
| Tekton | Pipeline YAML | Tasks remotas por *resolvers* (git, bundles, hub, cluster) | Task con `script` | `when:` `input/operator(in, notin)/values` o `cel:` (bandera) |
| Buildkite | YAML **generable por un script** | plugins | cualquier script que emite pasos (`pipeline upload`) | `if:` C-like evaluado **al subir**; `block` step humano con formulario |
| Taskfile | YAML | `includes` con espacio de nombres | `cmds` | `preconditions`, `status`/`sources`, `requires` |
| Dagger | **código** (Go, Python, TS) | módulos/funciones | todo es código | en código |
| Temporal | **código** determinista | activities | activities (efectos fuera del *replay*) | en código |

Evidencia clave:
- **[E] Actions** tiene tres tipos de acción: Docker, JavaScript y compuestas; todas declaran
  `inputs`, `outputs` y `runs` en `action.yml`. Workflows reutilizables: «a maximum of ten levels of
  workflows», sin ciclos. `if:` acepta la expresión sin `${{ }}`; `success()` es el implícito.
  Coerción laxa: `null`→0, cadenas se parsean como número, y con `NaN` toda comparación relacional es
  `false`. Entornos: hasta 6 revisores, «prevent self-review», temporizador y reglas propias por
  GitHub App. Rulesets: «Require status checks to pass», con app esperada como fuente.
- **[E] Inyección**: la guía de endurecimiento pide pasar valores no confiables a una variable de
  entorno intermedia en vez de interpolar `${{ }}` dentro del script.
- **[E] GitLab**: «A CI/CD component is a reusable single pipeline configuration unit»; se incluye con
  `component: …@<version>`; `~latest` desaconsejado. Las anclas YAML **no cruzan archivos incluidos**.
- **[E] Argo**: `suspend` «until it is resumed manually»; `when` usa govaluate y recomienda `expr`
  cuando hay comillas → dos lenguajes de expresión conviviendo.
- **[E] Tekton**: `when` estructurado (`in`/`notin`) y, tras la bandera `enable-cel-in-whenexpression`,
  `cel:`; hay que citar las variables (`'$(params.foo)' == 'foo'`). Si se salta una tarea, las
  dependientes por resultado también se saltan.
- **[E] Buildkite**: «Conditional expressions are evaluated at pipeline upload, not at step runtime»
  → no se puede condicionar a resultados de otro paso; la salida es generar YAML con un script.
- **[E] Temporal**: el código de workflow «must be deterministic to support replay»; las llamadas
  externas van en activities. **[E] Dagger** se vende como «real code» en lugar de scripts artesanales.
- **[E] Earthly** cerró su nube (jul-2025) y ofreció migrar a Dagger; no se evalúa más.

Patrón común **[I]**: (a) la receta es datos: lista de pasos, dependencias, parámetros; (b) el
bloque reutilizable tiene **manifiesto con entradas tipadas y versión fija**; (c) toda lógica real
vive en un bloque o en `run:`; (d) las condiciones son **expresiones pequeñas sobre un contexto de
hechos que el motor calcula**, nunca código que busca los hechos. Los sistemas que se salieron de esto
(Buildkite dinámico, Dagger, Temporal) lo hicieron porque su receta necesitaba lógica; el precio es
que la receta deja de ser legible por un no programador.

## 2. Opciones de lenguaje

| Lenguaje | No programador lee | Agente escribe | Validación/editor | Impl. en JS/TS | Veredicto |
|---|---|---|---|---|---|
| **YAML 1.2** + JSON Schema | Bien (listas y claves) | Muy bien [I: el formato de CI más común] | yaml-language-server: validación, autocompletado, ayuda al pasar el ratón; `# yaml-language-server: $schema=` | `yaml` (eemeli): 1.2 core por omisión, `uniqueKeys`, `maxAliasCount`, errores con línea/columna | **Recomendado** |
| TOML | Bien en plano; mal con listas de objetos anidados (`[[stages]]`, sin null) | Bien | Schema vía extensiones [A: no verificado] | sí | Estructura de etapas + bloques anidados queda incómoda |
| CUE | Difícil (unificación, restricciones) | Regular | Excelente validación propia | [A: no hallé binding JS oficial; Go] | Potente para validar, caro para leer |
| Pkl | Regular | Regular | Tipos y validación fuertes | **[E] no**: Java, Kotlin, Swift, Go | Descartado por el motor en TS |
| Starlark | Es Python: programa | Muy bien | Poca | [E/A] solo impl. comunitaria en Node | Termina siempre (sin recursión ni bucles infinitos), pero sigue siendo programa |
| HCL | Bien (bloques tipo Terraform) | Bien | Buena en Terraform | **[E] Go** | Sin parser JS oficial |
| TypeScript (hoy) | No | Muy bien | Tipos | nativo | Es el problema que se quiere dejar |

Trampas de YAML y cómo cerrarlas:
- **[E] Noruega**: con YAML 1.1 `NO` se lee `false`, `9.3` un número. YAML 1.2 «removed many of the
  problematic implicit typing recommendations»; el parser `yaml` usa 1.2 core por omisión. Cierre
  [I]: parsear en 1.2 core **y** validar tipos con el schema (`version: "9.3"` exige cadena).
- **Anclas/alias**: vuelven ilegible la receta y no cruzan archivos (GitLab). Cierre [I]: prohibir
  alias (`maxAliasCount: 0` o rechazo en validación); la reutilización se hace con `uses:`.
- **Claves duplicadas**: `uniqueKeys` por omisión [E].
- **Expansión del lenguaje de expresiones** [I con base en E]: Actions acumula `${{ }}` en cualquier
  cadena, coerción laxa, funciones de estado implícitas e inyección en `run:`; Argo convive con dos
  lenguajes. Cierre: **un solo lenguaje (CEL), solo en campos declarados como predicado**, nunca
  interpolado dentro de comandos; los valores a bloques pasan como datos JSON, no como texto.

## 3. Compuertas y condiciones: cómo se dice «solo pasa si X»

Dos preguntas distintas que los sistemas separan [I]:
- **¿Aplica esta etapa?** Actions `if:`, GitLab `rules:if/changes`, Argo/Tekton `when`, Buildkite
  `if:`. Todas son **predicados baratos sobre hechos** (rama, rutas tocadas, parámetros, resultados).
- **¿Pasó?** Casi nunca es una expresión: es el **resultado de un paso** (código de salida de
  `run:`, check requerido de una app, revisor que aprueba, `block` desbloqueado). La expresión solo
  decide si se exige. Taskfile es la excepción parcial: `preconditions` son comandos que deben dar 0.

**¿CEL sirve para predicados de compuerta?** Sí, para esa capa:
- [E] «CEL evaluates in linear time, is mutation free, and not Turing-complete»; diseñado para
  ejecutar código de usuario con seguridad; usado en Kubernetes (reglas de CRD,
  ValidatingAdmissionPolicy, con presupuesto de costo), en `when` de Tekton y en IAM de Google.
- [E] Macros `all`, `exists`, `filter`, `map`: permiten, por ejemplo,
  `verdicts.all(v, v.by.family != builder.family)` o `change.files.exists(f, f.startsWith('lib/calc/'))`.
- [E] En JS: `@bufbuild/cel` (cel-es) **«Status: Beta»**, con datos de conformidad de cel-spec;
  alternativas comunitarias (`@marcbachmann/cel-js`, `thesayyn/cel-js`).
- Límites [I]: CEL no puede **obtener** hechos (leer archivos, llamar a git/GitHub, correr pruebas);
  solo evaluar sobre lo que el motor le entrega. Legibilidad para no programador: mediocre con macros.
  Mitigación: funciones con nombre registradas por el motor (`touches('app/**')`, `lane in [...]`)
  y un atajo estructurado para lo común; CEL crudo queda para el caso raro.

## 4. Recomendación concreta

**Tres capas:**
1. **Receta** (`ai-workflows.yml`, YAML 1.2): orden de etapas, naturaleza, `needs-human`,
   aplicabilidad (atajo `touches:`/`lane:` o `cel`), vigencia elegida de un **catálogo cerrado**
   (`same-sha`, `same-fingerprint`, `same-fingerprint-or-clean-update`, `forever`), umbrales
   (`min-sources: 5`) y **tablas de clasificación** (qué rutas son dinero, seguridad, producción,
   visibles; qué carriles existen). Todo lo «propio de Socialabs» queda como dato configurable, que
   además es la regla SaaS de la casa.
2. **Bloques del motor** (`uses: ai-workflows/<bloque>@<versión>`): manifiesto tipo `action.yml`
   (nombre, naturaleza permitida, entradas con JSON Schema, salida `{ok, reason, evidence}`), con sus
   pruebas en el motor. Candidatos genéricos: describir el cambio desde git (SHA, archivos, árbol
   limpio, huella), secciones de spec, contar fuentes, prueba roja, construcción verde + reproducir
   sin implementación, puerta de comandos, revisión independiente y fresca, aprobación humana por
   comentario con código, espera de fila/merge, limpieza.
3. **Bloques locales y escape**: `uses: ./bloques/fila` (mismo manifiesto, código del proyecto) o
   `run: node scripts/x.mjs` con contrato: recibe el contexto en JSON por stdin, devuelve
   `{ok, reason, evidence}` en stdout; exit ≠ 0 o JSON inválido = compuerta roja, nunca aprobada.

Candados [I]: el motor valida la receta contra el schema antes de mover nada (receta inválida =
todo bloqueado con el error en español y la línea); bloques del motor con versión fija; un bloque no
puede declarar una naturaleza más fuerte que la de su manifiesto; cambiar la receta es en sí un
cambio que pasa por sus propias compuertas.

**Qué NO se puede expresar declarativamente** (debe vivir en bloques):
- Obtener hechos con efectos: git (SHA, diffs, huellas, cabezas con actualización limpia), API de
  GitHub (comentarios `/visto-bueno`, checks, fila), Vercel/preview, Playwright, Supabase.
- Ejecutar y **interpretar** pruebas (parsear salida, roja «por la razón esperada», retirar la
  implementación y volver a correr).
- Leer documentos y juzgar su forma (secciones del spec, fuentes distintas del benchmark,
  criterios de aceptación).
- Identidad de ejecución y «familia» de modelo; frescura de veredictos atada a SHA.
- Reglas con excepciones encadenadas (p. ej. `tipoDeCambio`: el tipo declarado se degrada a
  «comportamiento» si toca dinero o permisos). Esto **sí** cabe en CEL + tablas, pero conviene como
  bloque probado si crece.

**Estimación sobre las 1 848 líneas [I, conteo por regiones del archivo]:**

| Región actual | Líneas aprox. | Destino | Queda como |
|---|---|---|---|
| Lista de etapas (1316–1418) | ~100 | receta | ~60 líneas YAML |
| Aplicabilidad y carriles (1132–1300) | ~170 | receta (tablas + `touches`/CEL) | ~60–80 YAML |
| Vigencias (1079–1130) | ~50 | catálogo del motor | 1 línea por etapa |
| Taxonomías de rutas, ángulos, política de mensajes | ~110 | receta | ~50–70 YAML |
| Imports, tipos y utilidades de lectura | ~150 | desaparecen | 0 |
| Compuertas genéricas (spec, roja, construcción, puerta, parvada, visto bueno) y describir cambio/git (≈305–1076, 1500–1848) | ~1 000 | bloques del motor | 0 en la receta |
| Adaptadores a fila, QA, limpieza, release, arquitectura, benchmark | ~270 | bloques locales | ~5 líneas c/u en la receta |

Resultado: receta de **~200–280 líneas YAML**; ~1 000 líneas migran al motor (con pruebas);
~270 más los ~5 000 de scripts quedan como bloques locales. El salto de legibilidad está en que lo
que el dueño decide (qué etapas, cuándo aplican, umbrales, qué rutas son dinero) queda en la receta.

### Ejemplo en el formato recomendado

```yaml
# yaml-language-server: $schema=https://…/ai-workflows/schema/v1/recipe.json
version: 1
locale: es
classify:                       # datos, no código
  money:    ["lib/calc/**", "**/*nomina*", "**/*cierre*"]
  security: ["supabase/migrations/**", "**/*auth*", "**/*permis*", "**/*rls*"]
  visible:  ["app/**", "components/**", "public/**", "electron/**"]
stages:
  - id: benchmark
    nature: structure
    gate:
      uses: ai-workflows/count-sources@1
      with: { documents: "docs/investigaciones/{piece}-*.md" }
      pass-if: result.psa >= 5 && result.non_psa >= 2      # umbral configurable
  - id: flock-review            # «parvada»
    after: boundaries
    nature: attest
    applies-if:
      touches-any: [money, security, production]
    valid-while: same-fingerprint-or-clean-update
    gate:
      uses: ai-workflows/independent-review@1
      with: { angles-from: classify, forbid-same-family: true }
  - id: owner-approval          # «visto bueno»
    after: qa
    nature: attest
    needs-human: true
    applies-if: { touches-any: [visible] }
    valid-while: same-fingerprint
    gate:
      uses: ai-workflows/approval-comment@1
      with: { command: /visto-bueno, code-length: 7 }
  - id: merge-queue             # «fila»
    after: owner-approval
    nature: recompute
    valid-while: same-sha
    gate:
      run: node scripts/pipeline/fila.mjs   # recibe JSON por stdin; imprime {ok, reason, evidence}
```

Decisiones abiertas para el dueño [I]: claves en inglés (como Actions, genérico para SaaS) o en
español; aceptar la dependencia beta de CEL en JS o empezar solo con el atajo estructurado y sumar
CEL después; si el motor publica bloques genéricos para otros proyectos desde la v1.

## Fuentes primarias (26)

GitHub Actions: https://docs.github.com/en/actions/sharing-automations/creating-actions/about-custom-actions ·
https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/evaluate-expressions-in-workflows-and-actions ·
https://docs.github.com/en/actions/sharing-automations/reusing-workflows ·
https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment ·
https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions ·
https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets ·
https://github.github.com/gh-aw/ (Markdown + frontmatter compilado a `.lock.yml`)
GitLab: https://docs.gitlab.com/ci/components/ · https://docs.gitlab.com/ci/yaml/
Argo: https://argo-workflows.readthedocs.io/en/latest/walk-through/conditionals/ · https://argo-workflows.readthedocs.io/en/latest/workflow-concepts/
Tekton: https://tekton.dev/docs/pipelines/pipelines/ · https://tekton.dev/docs/pipelines/resolution-getting-started/
Buildkite: https://buildkite.com/docs/pipelines/configure/dynamic-pipelines · https://buildkite.com/docs/pipelines/configure/conditionals · https://buildkite.com/docs/pipelines/configure/step-types/block-step
Contraste código: https://taskfile.dev/docs/guide · https://docs.dagger.io/ · https://docs.temporal.io/workflow-definition · https://earthly.dev/blog/shutting-down-earthfiles-cloud/
CEL: https://cel.dev/overview/cel-overview · https://github.com/google/cel-spec · https://kubernetes.io/docs/reference/using-api/cel/ · https://github.com/bufbuild/cel-es
Lenguajes: https://yaml.org/spec/1.2.2/ · https://hitchdev.com/strictyaml/why/implicit-typing-removed/ · https://eemeli.org/yaml/ · https://github.com/redhat-developer/yaml-language-server · https://toml.io/en/v1.0.0 · https://cuelang.org/docs/introduction/ · https://pkl-lang.org/main/current/introduction/use-cases.html · https://github.com/bazelbuild/starlark (spec.md: «Execution is finite. The language does not allow recursion or unbounded loops.») · https://github.com/hashicorp/hcl

Ausencias declaradas [A]: no verifiqué binding JS oficial de CUE ni soporte de JSON Schema para
TOML en editores; no medí cuántas líneas exactas ocupa cada compuerta (conteo por rangos del archivo).
