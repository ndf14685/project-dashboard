# Project Dashboard

Dashboard vivo de proyectos con fuente de verdad híbrida:
- estado de gestión declarado en archivos por proyecto
- señales automáticas desde repos y otras fuentes
- publicación estática

## Objetivo

Dar una vista ejecutiva y anti-olvido del portfolio sin inventar progreso desde commits.

## Principios

- Manual = verdad de gestión
- Automático = evidencia complementaria
- Pocos campos, alta claridad
- Score explicable o nada
- Freshness y confidence visibles

## Estructura

- `registry/projects.yaml`: inventario central de proyectos
- `schemas/project-status.schema.yaml`: esquema humano de referencia
- `templates/PROJECT_STATUS.yaml`: template por proyecto
- `examples/`: ejemplos
- `docs/`: notas de arquitectura y roadmap

## MVP propuesto

1. Definir `projects.yaml`
2. Crear `PROJECT_STATUS.yaml` por proyecto
3. Implementar collector
4. Generar snapshot JSON
5. Publicar HTML estático en GitHub Pages

## Regla clave

Nunca derivar automáticamente el estado real del proyecto desde commits, PRs o issues. Esas señales solo enriquecen contexto.
