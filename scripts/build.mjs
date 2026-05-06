import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import YAML from 'yaml';

const root = process.cwd();
const registryPath = path.join(root, 'registry', 'projects.yaml');
const localRegistryPath = path.join(root, 'registry', 'projects.local.yaml');
const distDir = path.join(root, 'dist');

const ALLOWED_STAGE = new Set(['idea', 'active', 'paused', 'blocked', 'done', 'maintenance']);
const ALLOWED_PRIORITY = new Set(['low', 'medium', 'high', 'critical']);
const ALLOWED_EFFORT = new Set(['tiny', 'small', 'medium', 'large', 'huge']);
const ALLOWED_HEALTH = new Set(['green', 'yellow', 'red']);

function readYaml(filePath) {
  return YAML.parse(fs.readFileSync(filePath, 'utf8'));
}

function readOptionalYaml(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return readYaml(filePath);
}

function safeStatMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function safeGitLastCommit(repoPath) {
  try {
    const out = execSync('git log -1 --format=%cI', { cwd: repoPath, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

function diffDays(isoDate) {
  if (!isoDate) return null;
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

function computeFreshness(daysSinceHumanUpdate) {
  if (daysSinceHumanUpdate === null) return 'unknown';
  if (daysSinceHumanUpdate <= 2) return 'fresh';
  if (daysSinceHumanUpdate <= 7) return 'warm';
  return 'stale';
}

function computeTemperature(daysSinceRepoActivity) {
  if (daysSinceRepoActivity === null) return 'unknown';
  if (daysSinceRepoActivity <= 2) return 'hot';
  if (daysSinceRepoActivity <= 7) return 'warm';
  return 'cold';
}

function computeStaleRisk({ daysSinceHumanUpdate, daysSinceRepoActivity, blockers, needsDecision }) {
  let risk = 0;
  if (daysSinceHumanUpdate !== null) risk += Math.min(60, daysSinceHumanUpdate * 6);
  if (daysSinceRepoActivity !== null) risk += Math.min(20, daysSinceRepoActivity * 2);
  if ((blockers || []).length) risk += Math.min(15, blockers.length * 5);
  if (needsDecision) risk += 10;
  if (risk >= 60) return 'high';
  if (risk >= 30) return 'medium';
  return 'low';
}

function computeConfidence(status, warnings = []) {
  let score = 0.45;
  if (status?.summary) score += 0.1;
  if (status?.next_action) score += 0.1;
  if (Array.isArray(status?.blockers)) score += 0.1;
  if (status?.last_human_update) score += 0.15;
  if (Array.isArray(status?.current_focus) && status.current_focus.length > 0) score += 0.05;
  score -= Math.min(0.25, warnings.length * 0.05);
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function computeScore({ stage, health, daysSinceHumanUpdate, daysSinceRepoActivity, blockers, needsDecision }) {
  let score = 70;
  if (stage === 'blocked') score -= 30;
  if (stage === 'paused') score -= 20;
  if (health === 'red') score -= 25;
  if (health === 'yellow') score -= 10;
  if ((blockers || []).length > 0) score -= Math.min(20, blockers.length * 7);
  if (needsDecision) score -= 8;
  if (daysSinceHumanUpdate !== null) score -= Math.min(25, daysSinceHumanUpdate * 2);
  if (daysSinceRepoActivity !== null) score -= Math.min(15, daysSinceRepoActivity);
  return Math.max(0, Math.min(100, score));
}

function latestIso(dates) {
  return dates
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || null;
}

function pushIssue(issues, level, projectId, message) {
  issues.push({ level, project_id: projectId || null, message });
}

function validateRegistry(registry, issues) {
  if (!registry || typeof registry !== 'object') {
    throw new Error('registry/projects.yaml no es un objeto YAML válido');
  }

  const projects = registry.projects;
  if (!Array.isArray(projects) || projects.length === 0) {
    throw new Error('registry/projects.yaml debe incluir al menos un proyecto en projects[]');
  }

  const ids = new Set();
  for (const entry of projects) {
    if (!entry?.id) throw new Error('Cada proyecto en registry debe tener id');
    if (ids.has(entry.id)) throw new Error(`Proyecto duplicado en registry: ${entry.id}`);
    ids.add(entry.id);
    if (!entry.name) throw new Error(`Proyecto ${entry.id} sin name`);
    if (entry.priority && !ALLOWED_PRIORITY.has(entry.priority)) {
      pushIssue(issues, 'warning', entry.id, `priority fuera de vocabulario: ${entry.priority}`);
    }
    if (!Array.isArray(entry.repos) || entry.repos.length === 0) {
      pushIssue(issues, 'warning', entry.id, 'no tiene repos asociados');
    }
  }
}

function validateStatus(status, entry, issues) {
  if (!status) {
    pushIssue(issues, 'warning', entry.id, 'status file no encontrado; se usará metadata mínima del registry');
    return;
  }

  if (status.project_id && status.project_id !== entry.id) {
    pushIssue(issues, 'warning', entry.id, `project_id del status (${status.project_id}) no coincide con registry (${entry.id})`);
  }
  if (status.stage && !ALLOWED_STAGE.has(status.stage)) {
    throw new Error(`Proyecto ${entry.id}: stage inválido: ${status.stage}`);
  }
  if (status.priority && !ALLOWED_PRIORITY.has(status.priority)) {
    throw new Error(`Proyecto ${entry.id}: priority inválido: ${status.priority}`);
  }
  if (status.effort && !ALLOWED_EFFORT.has(status.effort)) {
    throw new Error(`Proyecto ${entry.id}: effort inválido: ${status.effort}`);
  }
  if (status.health && !ALLOWED_HEALTH.has(status.health)) {
    throw new Error(`Proyecto ${entry.id}: health inválido: ${status.health}`);
  }
  if (status.progress_pct != null && (status.progress_pct < 0 || status.progress_pct > 100)) {
    throw new Error(`Proyecto ${entry.id}: progress_pct debe estar entre 0 y 100`);
  }
  if (status.last_human_update && Number.isNaN(new Date(status.last_human_update).getTime())) {
    throw new Error(`Proyecto ${entry.id}: last_human_update no es una fecha ISO válida`);
  }
  if (status.blockers && !Array.isArray(status.blockers)) {
    throw new Error(`Proyecto ${entry.id}: blockers debe ser una lista`);
  }
}

function repoDisplayName(repoPath, fallbackSlug) {
  if (repoPath) return path.basename(repoPath);
  return fallbackSlug || null;
}

function resolveRepoPaths(entry, localRegistry) {
  const localPath = localRegistry?.local_paths?.[entry.id];
  if (localPath) return [localPath];
  return Array.isArray(entry.repos) ? entry.repos.map(repo => repo.path).filter(Boolean) : [];
}

function buildProject(entry, issues, localRegistry) {
  const repoPaths = resolveRepoPaths(entry, localRegistry);
  const primaryRepoPath = repoPaths[0] || null;
  const statusPath = primaryRepoPath
    ? path.join(primaryRepoPath, entry.status_source?.location || '.project/PROJECT_STATUS.yaml')
    : null;

  const status = statusPath && fs.existsSync(statusPath) ? readYaml(statusPath) : null;
  validateStatus(status, entry, issues);

  const repoActivityDates = repoPaths.map(safeGitLastCommit).filter(Boolean);
  const lastRepoActivityAt = latestIso(repoActivityDates);
  const statusFileMtime = statusPath ? safeStatMtime(statusPath) : null;
  const humanUpdateAt = status?.last_human_update || statusFileMtime;
  const daysSinceHumanUpdate = diffDays(humanUpdateAt);
  const daysSinceRepoActivity = diffDays(lastRepoActivityAt);
  const freshness = computeFreshness(daysSinceHumanUpdate);
  const temperature = computeTemperature(daysSinceRepoActivity);
  const blockers = Array.isArray(status?.blockers) ? status.blockers : [];
  const projectWarnings = issues.filter(issue => issue.project_id === entry.id && issue.level === 'warning');
  const confidence = computeConfidence(status, projectWarnings);
  const staleRisk = computeStaleRisk({
    daysSinceHumanUpdate,
    daysSinceRepoActivity,
    blockers,
    needsDecision: Boolean(status?.needs_decision),
  });
  const score = computeScore({
    stage: status?.stage,
    health: status?.health,
    daysSinceHumanUpdate,
    daysSinceRepoActivity,
    blockers,
    needsDecision: Boolean(status?.needs_decision),
  });

  const reasons = [];
  if (daysSinceHumanUpdate !== null) reasons.push(`última actualización humana hace ${daysSinceHumanUpdate} día(s)`);
  if (daysSinceRepoActivity !== null) reasons.push(`última actividad de repo hace ${daysSinceRepoActivity} día(s)`);
  if (blockers.length > 0) reasons.push(`${blockers.length} bloqueo(s) declarado(s)`);
  if (status?.needs_decision) reasons.push('requiere decisión');
  if (status?.next_action) reasons.push('tiene próxima acción definida');
  if (projectWarnings.length) reasons.push(`${projectWarnings.length} warning(s) de calidad de datos`);

  return {
    id: entry.id,
    name: entry.name,
    owner: entry.owner,
    type: entry.type,
    priority: status?.priority || entry.priority || null,
    stage: status?.stage || 'unknown',
    effort: status?.effort || null,
    progress_pct: status?.progress_pct ?? null,
    health: status?.health || 'unknown',
    summary: status?.summary || null,
    current_focus: status?.current_focus || [],
    pending: status?.pending || [],
    next_action: status?.next_action || null,
    blockers,
    needs_decision: Boolean(status?.needs_decision),
    can_delegate: Boolean(status?.can_delegate),
    quick_win: status?.quick_win || null,
    links: { ...(entry.links || {}), ...(status?.links || {}) },
    topics: entry.topics || [],
    tags: entry.tags || [],
    repo_count: Array.isArray(entry.repos) ? entry.repos.length : repoPaths.length,
    repos: (Array.isArray(entry.repos) ? entry.repos : []).map((repo, index) => repoDisplayName(repoPaths[index], repo.slug)),
    last_human_update: humanUpdateAt,
    last_repo_activity_at: lastRepoActivityAt,
    days_since_human_update: daysSinceHumanUpdate,
    days_since_repo_activity: daysSinceRepoActivity,
    freshness,
    temperature,
    stale_risk: staleRisk,
    confidence,
    score,
    reasons,
    warnings: projectWarnings.map(issue => issue.message),
    status_source: {
      type: entry.status_source?.type || null,
      location: entry.status_source?.location || null,
      found: Boolean(status),
    },
  };
}

function summarize(projects, issues) {
  return {
    total: projects.length,
    active: projects.filter(p => p.stage === 'active').length,
    paused: projects.filter(p => p.stage === 'paused').length,
    blocked: projects.filter(p => p.stage === 'blocked').length,
    stale: projects.filter(p => p.freshness === 'stale').length,
    needs_decision: projects.filter(p => p.needs_decision).length,
    high_stale_risk: projects.filter(p => p.stale_risk === 'high').length,
    warnings: issues.filter(issue => issue.level === 'warning').length,
    avg_score: projects.length
      ? Number((projects.reduce((sum, p) => sum + p.score, 0) / projects.length).toFixed(1))
      : null,
    total_estimated_load: projects.reduce((sum, p) => {
      const weight = { tiny: 1, small: 2, medium: 3, large: 5, huge: 8 }[p.effort] || 0;
      return sum + weight;
    }, 0),
  };
}

function renderHtml(snapshot) {
  const cards = snapshot.projects.map((p) => `
    <section class="card ${p.health}">
      <div class="row between">
        <h2>${p.name}</h2>
        <span class="pill">${p.stage}</span>
      </div>
      <p>${p.summary || 'Sin resumen'}</p>
      <ul>
        <li><strong>Owner:</strong> ${p.owner || '-'}</li>
        <li><strong>Prioridad:</strong> ${p.priority || '-'}</li>
        <li><strong>Esfuerzo:</strong> ${p.effort || '-'}</li>
        <li><strong>Avance:</strong> ${p.progress_pct ?? '-'}%</li>
        <li><strong>Freshness:</strong> ${p.freshness}</li>
        <li><strong>Temperatura:</strong> ${p.temperature}</li>
        <li><strong>Riesgo stale:</strong> ${p.stale_risk}</li>
        <li><strong>Repos:</strong> ${p.repo_count}</li>
        <li><strong>Score:</strong> ${p.score} (confianza ${p.confidence})</li>
        <li><strong>Próxima acción:</strong> ${p.next_action || '-'}</li>
        <li><strong>Bloqueos:</strong> ${p.blockers.length ? p.blockers.join(', ') : 'ninguno'}</li>
      </ul>
      <details>
        <summary>Razones</summary>
        <ul>${p.reasons.map(r => `<li>${r}</li>`).join('')}</ul>
      </details>
      ${p.warnings.length ? `<details><summary>Warnings</summary><ul>${p.warnings.map(w => `<li>${w}</li>`).join('')}</ul></details>` : ''}
    </section>
  `).join('\n');

  const issuesSection = snapshot.issues.length
    ? `<section class="card"><h2>Warnings</h2><ul>${snapshot.issues.map(issue => `<li>[${issue.project_id || 'global'}] ${issue.message}</li>`).join('')}</ul></section>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Project Dashboard</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { background: #121933; border: 1px solid #24304f; border-radius: 14px; padding: 16px; }
    .card.green { border-color: #2f855a; }
    .card.yellow { border-color: #b7791f; }
    .card.red { border-color: #c53030; }
    .row { display: flex; gap: 8px; align-items: center; }
    .between { justify-content: space-between; }
    .pill { background: #1f2a44; border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 20px 0; }
    .metric { background: #121933; border: 1px solid #24304f; border-radius: 12px; padding: 12px; }
    a { color: #93c5fd; }
  </style>
</head>
<body>
  <main>
    <h1>Project Dashboard</h1>
    <p>Generado: ${snapshot.generated_at}</p>
    <section class="summary">
      <div class="metric"><strong>Total</strong><br/>${snapshot.summary.total}</div>
      <div class="metric"><strong>Activos</strong><br/>${snapshot.summary.active}</div>
      <div class="metric"><strong>Pausados</strong><br/>${snapshot.summary.paused}</div>
      <div class="metric"><strong>Bloqueados</strong><br/>${snapshot.summary.blocked}</div>
      <div class="metric"><strong>Stale</strong><br/>${snapshot.summary.stale}</div>
      <div class="metric"><strong>Riesgo alto</strong><br/>${snapshot.summary.high_stale_risk}</div>
      <div class="metric"><strong>Warnings</strong><br/>${snapshot.summary.warnings}</div>
      <div class="metric"><strong>Carga</strong><br/>${snapshot.summary.total_estimated_load}</div>
      <div class="metric"><strong>Score promedio</strong><br/>${snapshot.summary.avg_score ?? '-'}</div>
    </section>
    ${issuesSection}
    <section class="grid">
      ${cards}
    </section>
  </main>
</body>
</html>`;
}

function main() {
  const issues = [];
  const registry = readYaml(registryPath);
  const localRegistry = readOptionalYaml(localRegistryPath);
  validateRegistry(registry, issues);
  const projects = (registry.projects || []).map(entry => buildProject(entry, issues, localRegistry));
  const snapshot = {
    generated_at: new Date().toISOString(),
    summary: summarize(projects, issues),
    issues,
    projects,
  };

  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'projects.snapshot.json'), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(path.join(distDir, 'index.html'), renderHtml(snapshot));
  console.log(`Built dashboard for ${projects.length} project(s) with ${issues.length} warning(s).`);
}

main();
