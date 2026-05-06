# Uso

## Build local

```bash
cp registry/projects.local.yaml.example registry/projects.local.yaml # si hace falta
npm install
npm run build
```

## Salidas

- `dist/projects.snapshot.json`
- `dist/index.html`

## Qué calcula hoy

- lectura de `registry/projects.yaml`
- lectura de cada `PROJECT_STATUS.yaml`
- validación básica de vocabulario y rangos
- última actividad git del repo más reciente entre los repos asociados
- freshness
- temperature
- stale_risk
- confidence
- score simple y explicable
- warnings de calidad de datos en snapshot y HTML

## Publicación

Hay workflow en `.github/workflows/pages.yml` para publicar el `dist/` ya prebuildado al hacer push a `master`.

Esto es intencional: el build local puede usar `registry/projects.local.yaml` para resolver paths privados de repos locales, cosa que GitHub Actions no tiene.

## Limitaciones actuales

- la validación todavía es manual, no con JSON Schema/Ajv
- no consulta PRs, issues ni CI todavía
- no publica automáticamente fuera de GitHub Pages todavía

## Siguiente evolución

- schemas formales para registry y status
- collector de PRs/issues/CI
- reglas de atención/recordatorios
- filtros o vistas ejecutivas por score, stale y owner
