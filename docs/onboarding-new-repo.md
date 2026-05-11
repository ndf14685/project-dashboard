# Onboarding de un repo nuevo al Project Dashboard

Cada vez que se crea un repositorio (público o privado, infra o producto),
**hay que registrarlo en el dashboard**. Si no está acá, no existe para
efectos de portfolio y queda fuera de los snapshots y reportes.

## Regla obligatoria

Todo repo nuevo debe quedar reflejado en:

1. `registry/projects.yaml` — entrada con `id`, `name`, `owner`, `type`,
   `priority`, `visibility`, `status_source`, `repos`, `links`, `tags`.
2. Un archivo `.project/PROJECT_STATUS.yaml` dentro del propio repo, usando
   `templates/PROJECT_STATUS.yaml` como base.
3. `registry/projects.local.yaml` — mapeo `id → path absoluto local`, para
   que el build local pueda leer el status file.

Esto debe quedar hecho **antes** de:
- empezar a iterar en el repo más allá del scaffold inicial,
- compartir el repo con otra persona,
- conectar el repo a CI/CD o a un topic de Telegram.

## Checklist al crear un repo

- [ ] Crear el repo en GitHub (o equivalente).
- [ ] Clonarlo localmente.
- [ ] Agregar `.project/PROJECT_STATUS.yaml` desde el template.
- [ ] Completar como mínimo: `project_id`, `name`, `stage`, `priority`,
      `summary`, `next_action`, `last_human_update`.
- [ ] Agregar entrada nueva en `registry/projects.yaml`.
- [ ] Agregar mapeo en `registry/projects.local.yaml` con el path local
      absoluto (no commitear paths privados al repo público).
- [ ] Correr `npm run build` y verificar que el proyecto aparece en
      `dist/projects.snapshot.json` sin warnings críticos.
- [ ] Commit + push de la entrada en `registry/projects.yaml`.

## Política de slugs y `id`

- El `id` del registry debe ser estable, en `kebab-case`, y único.
- El `slug` debe coincidir **exactamente** con el nombre del repo en GitHub.
  Si el repo se renombra, hay que actualizar `slug` y `links.repo`.
- Si el `id` del registry difiere del slug del repo (por motivos históricos
  o de identidad), dejar nota explícita en `notes` del status file.

## Mantenimiento

- Cuando se archiva un repo: cambiar `stage` a `done` o `maintenance`
  en su status file, no borrar la entrada del registry.
- Cuando se borra/abandona definitivamente: marcar `stage: paused` o
  `done` con `health: red` y dejar la entrada para mantener historia.

## Recordatorio para agentes (Claude, Codex, etc.)

Si un agente crea un repositorio en nombre del usuario, **debe ejecutar
este checklist en el mismo turno**, no diferirlo. Si no puede completarlo
(por permisos, contexto faltante, etc.), tiene que dejarlo explícito en
la respuesta al usuario, con qué falta y cómo terminar el alta.
