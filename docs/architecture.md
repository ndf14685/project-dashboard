# Arquitectura recomendada

## Tesis

El dashboard debe ser una vista ejecutiva confiable, no un sistema que adivina progreso.

## Regla de autoridad

- `registry/projects.yaml` decide qué proyectos existen y dónde mirar
- `PROJECT_STATUS.yaml` define el estado humano-curado
- las señales automáticas enriquecen pero no sobrescriben el estado declarado
- el publisher publica snapshots, no reescribe fuentes operativas
- todo repo nuevo se registra en el dashboard como paso obligatorio del alta;
  ver [`onboarding-new-repo.md`](onboarding-new-repo.md)

## Componentes

### 1. Registry
Inventario canónico:
- identidad
- owner
- repos
- links
- status source
- tags

### 2. Status file por proyecto
Fuente de verdad de gestión:
- stage
- priority
- effort
- progress_pct
- summary
- next_action
- blockers
- last_human_update

### 3. Collector
Lee:
- registry
- status files
- metadata de git
- más adelante PRs/issues/CI

### 4. Snapshot generator
Produce:
- `dist/projects.snapshot.json`
- `dist/index.html`

### 5. Publisher
GitHub Pages o cualquier hosting estático.

## Datos derivados sugeridos

- last_repo_activity_at
- days_since_activity
- days_since_human_update
- freshness
- confidence
- temperature
- stale_risk

## Score

Si existe score, debe ser explicable.
Siempre publicar también:
- reasons
- confidence
- freshness

## Qué evitar en MVP

- sync bidireccional
- edición vía UI
- inferir stage desde commits
- automatización compleja de prioridades
