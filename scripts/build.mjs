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

const EFFORT_WEIGHT = { tiny: 1, small: 2, medium: 3, large: 5, huge: 8 };
const PIE_COLORS = [
  '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#a78bfa',
  '#fb923c', '#22d3ee', '#f472b6', '#84cc16', '#facc15',
  '#94a3b8', '#06b6d4', '#10b981', '#ef4444', '#8b5cf6',
  '#eab308',
];

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function colorFor(category, key, index) {
  const palettes = {
    health: { green: '#34d399', yellow: '#fbbf24', red: '#f87171', unknown: '#94a3b8' },
    stage: {
      idea: '#60a5fa', active: '#34d399', paused: '#fbbf24',
      blocked: '#f87171', done: '#a78bfa', maintenance: '#22d3ee',
      unknown: '#94a3b8',
    },
    priority: {
      low: '#94a3b8', medium: '#fbbf24', high: '#f87171',
      critical: '#dc2626', unknown: '#64748b',
    },
  };
  if (palettes[category] && palettes[category][key]) return palettes[category][key];
  return PIE_COLORS[index % PIE_COLORS.length];
}

function renderPie(data, size = 220) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  if (!total) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="pie">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 8}" fill="#1f2a44"/>` +
      `<text x="50%" y="50%" text-anchor="middle" dy=".35em" fill="#94a3b8" font-size="12">sin datos</text>` +
      `</svg>`;
  }
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  if (data.length === 1) {
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="pie">` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${data[0].color}"/></svg>`;
  }
  let cumulative = 0;
  const paths = data.map((d) => {
    const startAngle = (cumulative / total) * Math.PI * 2;
    cumulative += d.value;
    const endAngle = (cumulative / total) * Math.PI * 2;
    const x1 = cx + r * Math.sin(startAngle);
    const y1 = cy - r * Math.cos(startAngle);
    const x2 = cx + r * Math.sin(endAngle);
    const y2 = cy - r * Math.cos(endAngle);
    const large = endAngle - startAngle > Math.PI ? 1 : 0;
    const path = `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large},1 ${x2},${y2} Z`;
    return `<path d="${path}" fill="${d.color}" stroke="#0b1020" stroke-width="1"><title>${escapeHtml(d.label)}: ${d.value}</title></path>`;
  }).join('');
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="pie">${paths}</svg>`;
}

function renderLegend(data) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return `<ul class="legend">` + data.map((d) => {
    const pct = total ? ((d.value / total) * 100).toFixed(1) : '0.0';
    return `<li><span class="swatch" style="background:${d.color}"></span><span class="legend-label">${escapeHtml(d.label)}</span><span class="legend-value">${d.value} (${pct}%)</span></li>`;
  }).join('') + `</ul>`;
}

function bucketKanban(projects) {
  const buckets = { backlog: [], todo: [], doing: [], test: [], done: [], history: [] };
  for (const p of projects) {
    const pct = p.progress_pct ?? 0;
    const stage = p.stage || 'unknown';
    if (stage === 'idea') buckets.backlog.push(p);
    else if (stage === 'done') buckets.done.push(p);
    else if (stage === 'paused' || stage === 'maintenance' || stage === 'blocked') buckets.history.push(p);
    else if (stage === 'active') {
      if (pct < 10) buckets.todo.push(p);
      else if (pct < 70) buckets.doing.push(p);
      else buckets.test.push(p);
    } else {
      buckets.history.push(p);
    }
  }
  return buckets;
}

function computeStats(projects) {
  const weightByProject = projects.map((p, i) => ({
    label: p.name,
    value: EFFORT_WEIGHT[p.effort] || 1,
    color: PIE_COLORS[i % PIE_COLORS.length],
  })).sort((a, b) => b.value - a.value);

  const progressByProject = projects.map((p) => ({
    label: p.name,
    value: Math.max(0, Math.min(100, p.progress_pct ?? 0)),
    health: p.health || 'unknown',
  })).sort((a, b) => b.value - a.value);

  const countByCategory = (key, category) => {
    const counts = {};
    for (const p of projects) {
      const v = p[key] || 'unknown';
      counts[v] = (counts[v] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({
        label,
        value,
        color: colorFor(category, label, i),
      }));
  };

  return {
    weightByProject,
    progressByProject,
    stageBreakdown: countByCategory('stage', 'stage'),
    priorityBreakdown: countByCategory('priority', 'priority'),
    healthBreakdown: countByCategory('health', 'health'),
  };
}

function renderMainCard(p) {
  return `
    <section class="card ${escapeHtml(p.health)}">
      <div class="row between">
        <h2>${escapeHtml(p.name)}</h2>
        <span class="pill">${escapeHtml(p.stage)}</span>
      </div>
      <p>${escapeHtml(p.summary || 'Sin resumen')}</p>
      <ul>
        <li><strong>Owner:</strong> ${escapeHtml(p.owner || '-')}</li>
        <li><strong>Prioridad:</strong> ${escapeHtml(p.priority || '-')}</li>
        <li><strong>Esfuerzo:</strong> ${escapeHtml(p.effort || '-')}</li>
        <li><strong>Avance:</strong> ${p.progress_pct ?? '-'}%</li>
        <li><strong>Freshness:</strong> ${escapeHtml(p.freshness)}</li>
        <li><strong>Temperatura:</strong> ${escapeHtml(p.temperature)}</li>
        <li><strong>Riesgo stale:</strong> ${escapeHtml(p.stale_risk)}</li>
        <li><strong>Repos:</strong> ${p.repo_count}</li>
        <li><strong>Score:</strong> ${p.score} (confianza ${p.confidence})</li>
        <li><strong>Próxima acción:</strong> ${escapeHtml(p.next_action || '-')}</li>
        <li><strong>Bloqueos:</strong> ${p.blockers.length ? p.blockers.map(escapeHtml).join(', ') : 'ninguno'}</li>
      </ul>
      <details>
        <summary>Razones</summary>
        <ul>${p.reasons.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>
      </details>
      ${p.warnings.length ? `<details><summary>Warnings</summary><ul>${p.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></details>` : ''}
    </section>
  `;
}

function renderMiniCard(p) {
  const pct = p.progress_pct ?? 0;
  const blockers = p.blockers.length ? `<small class="blockers">⚠ ${p.blockers.length} bloqueo(s)</small>` : '';
  return `
    <article class="mini-card ${escapeHtml(p.health)}">
      <div class="row between">
        <strong>${escapeHtml(p.name)}</strong>
        <span class="pill small">${escapeHtml(p.priority || '-')}</span>
      </div>
      <div class="mini-meta">
        <span>${escapeHtml(p.effort || '-')}</span>
        <span>·</span>
        <span>${pct}%</span>
        <span>·</span>
        <span class="freshness-${escapeHtml(p.freshness)}">${escapeHtml(p.freshness)}</span>
      </div>
      <div class="progress"><span style="width:${pct}%"></span></div>
      <small class="next-action">${escapeHtml(p.next_action || 'Sin próxima acción definida')}</small>
      ${blockers}
    </article>
  `;
}

function renderKanban(projects) {
  const buckets = bucketKanban(projects);
  const columns = [
    { id: 'backlog', label: 'Backlog' },
    { id: 'todo', label: 'Todo' },
    { id: 'doing', label: 'Doing' },
    { id: 'test', label: 'Test' },
    { id: 'done', label: 'Done' },
    { id: 'history', label: 'History' },
  ];
  return `
    <div class="kanban">
      ${columns.map((col) => `
        <div class="kanban-col" data-col="${col.id}">
          <header class="kanban-col-header">
            <strong>${col.label}</strong>
            <span class="count">${buckets[col.id].length}</span>
          </header>
          <div class="kanban-cards">
            ${buckets[col.id].length ? buckets[col.id].map(renderMiniCard).join('') : '<p class="empty">—</p>'}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderProgressBars(progressByProject) {
  return `<ul class="progress-bars">` + progressByProject.map((row) => {
    const fill = colorFor('health', row.health, 0);
    return `
      <li>
        <div class="progress-bar-row">
          <span class="progress-bar-label">${escapeHtml(row.label)}</span>
          <span class="progress-bar-value">${row.value}%</span>
        </div>
        <div class="progress-bar"><span style="width:${row.value}%; background:${fill};"></span></div>
      </li>
    `;
  }).join('') + `</ul>`;
}

function renderStats(stats) {
  return `
    <div class="stats-grid">
      <div class="chart-card">
        <h3>Peso por proyecto (effort)</h3>
        <div class="chart-body">
          ${renderPie(stats.weightByProject)}
          ${renderLegend(stats.weightByProject)}
        </div>
      </div>
      <div class="chart-card">
        <h3>Distribución por stage</h3>
        <div class="chart-body">
          ${renderPie(stats.stageBreakdown)}
          ${renderLegend(stats.stageBreakdown)}
        </div>
      </div>
      <div class="chart-card">
        <h3>Distribución por prioridad</h3>
        <div class="chart-body">
          ${renderPie(stats.priorityBreakdown)}
          ${renderLegend(stats.priorityBreakdown)}
        </div>
      </div>
      <div class="chart-card">
        <h3>Distribución por health</h3>
        <div class="chart-body">
          ${renderPie(stats.healthBreakdown)}
          ${renderLegend(stats.healthBreakdown)}
        </div>
      </div>
      <div class="chart-card full">
        <h3>Avance por proyecto</h3>
        ${renderProgressBars(stats.progressByProject)}
      </div>
    </div>
  `;
}

function renderHtml(snapshot) {
  const cards = snapshot.projects.map(renderMainCard).join('\n');
  const kanban = renderKanban(snapshot.projects);
  const stats = renderStats(computeStats(snapshot.projects));

  const issuesSection = snapshot.issues.length
    ? `<section class="card"><h2>Warnings</h2><ul>${snapshot.issues.map(issue => `<li>[${escapeHtml(issue.project_id || 'global')}] ${escapeHtml(issue.message)}</li>`).join('')}</ul></section>`
    : '';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Project Dashboard</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 0; background: #0b1020; color: #e5e7eb; }
    main { max-width: 1280px; margin: 0 auto; padding: 24px; }
    h1 { margin: 0 0 6px; }
    h2 { margin: 0; font-size: 18px; }
    h3 { margin: 0 0 12px; font-size: 15px; color: #cbd5f5; }
    a { color: #93c5fd; }

    .tabs { display: flex; gap: 6px; margin: 18px 0 18px; border-bottom: 1px solid #24304f; }
    .tabs button {
      background: transparent; color: #94a3b8; border: 0; padding: 10px 16px;
      font-size: 14px; cursor: pointer; border-bottom: 2px solid transparent;
      font-family: inherit;
    }
    .tabs button:hover { color: #e5e7eb; }
    .tabs button.active { color: #e5e7eb; border-bottom-color: #60a5fa; }
    .tab { display: none; }
    .tab.active { display: block; }

    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin: 8px 0 20px; }
    .metric { background: #121933; border: 1px solid #24304f; border-radius: 12px; padding: 12px; }

    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
    .card { background: #121933; border: 1px solid #24304f; border-radius: 14px; padding: 16px; }
    .card.green { border-color: #2f855a; }
    .card.yellow { border-color: #b7791f; }
    .card.red { border-color: #c53030; }
    .card ul { padding-left: 18px; margin: 8px 0; }
    .row { display: flex; gap: 8px; align-items: center; }
    .between { justify-content: space-between; }
    .pill { background: #1f2a44; border-radius: 999px; padding: 4px 10px; font-size: 12px; }
    .pill.small { font-size: 11px; padding: 2px 8px; }

    .kanban {
      display: grid;
      grid-template-columns: repeat(6, minmax(220px, 1fr));
      gap: 12px;
      overflow-x: auto;
      padding-bottom: 8px;
    }
    .kanban-col {
      background: #0f172a; border: 1px solid #24304f; border-radius: 12px;
      display: flex; flex-direction: column; min-height: 200px;
    }
    .kanban-col-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 12px; border-bottom: 1px solid #24304f;
      background: #121933; border-radius: 12px 12px 0 0;
    }
    .kanban-col-header .count {
      background: #1f2a44; border-radius: 999px; padding: 2px 8px;
      font-size: 12px; color: #cbd5f5;
    }
    .kanban-col[data-col="backlog"] { border-top: 3px solid #60a5fa; }
    .kanban-col[data-col="todo"]    { border-top: 3px solid #fbbf24; }
    .kanban-col[data-col="doing"]   { border-top: 3px solid #34d399; }
    .kanban-col[data-col="test"]    { border-top: 3px solid #22d3ee; }
    .kanban-col[data-col="done"]    { border-top: 3px solid #a78bfa; }
    .kanban-col[data-col="history"] { border-top: 3px solid #94a3b8; }
    .kanban-cards { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
    .kanban-cards .empty { color: #64748b; text-align: center; margin: 16px 0; font-size: 13px; }

    .mini-card {
      background: #121933; border: 1px solid #24304f; border-left: 4px solid #24304f;
      border-radius: 8px; padding: 10px; font-size: 13px;
    }
    .mini-card.green  { border-left-color: #34d399; }
    .mini-card.yellow { border-left-color: #fbbf24; }
    .mini-card.red    { border-left-color: #f87171; }
    .mini-card strong { font-size: 13px; }
    .mini-meta { color: #94a3b8; font-size: 11px; margin: 6px 0; display: flex; gap: 6px; flex-wrap: wrap; }
    .freshness-fresh { color: #34d399; }
    .freshness-warm  { color: #fbbf24; }
    .freshness-stale { color: #f87171; }
    .progress {
      background: #1f2a44; border-radius: 999px; height: 6px; overflow: hidden; margin: 6px 0;
    }
    .progress span { display: block; height: 100%; background: #60a5fa; }
    .next-action { color: #cbd5f5; display: block; margin-top: 4px; }
    .blockers { color: #f87171; display: block; margin-top: 4px; }

    .stats-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;
    }
    .chart-card {
      background: #121933; border: 1px solid #24304f; border-radius: 14px; padding: 16px;
    }
    .chart-card.full { grid-column: 1 / -1; }
    .chart-body { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
    .pie { flex-shrink: 0; }
    .legend { list-style: none; padding: 0; margin: 0; flex: 1; min-width: 160px; font-size: 12px; }
    .legend li { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
    .swatch { width: 12px; height: 12px; border-radius: 3px; flex-shrink: 0; }
    .legend-label { flex: 1; color: #cbd5f5; }
    .legend-value { color: #94a3b8; }

    .progress-bars { list-style: none; padding: 0; margin: 0; }
    .progress-bars li { margin: 10px 0; }
    .progress-bar-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
    .progress-bar-label { color: #cbd5f5; }
    .progress-bar-value { color: #94a3b8; }
    .progress-bar { background: #1f2a44; border-radius: 999px; height: 10px; overflow: hidden; }
    .progress-bar span { display: block; height: 100%; background: #60a5fa; }
  </style>
</head>
<body>
  <main>
    <h1>Project Dashboard</h1>
    <p>Generado: ${escapeHtml(snapshot.generated_at)}</p>
    <nav class="tabs" role="tablist">
      <button type="button" data-tab="resumen" class="active" role="tab" aria-selected="true">Resumen</button>
      <button type="button" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
      <button type="button" data-tab="stats" role="tab" aria-selected="false">Estadísticas</button>
    </nav>

    <section class="tab active" id="tab-resumen" role="tabpanel">
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
    </section>

    <section class="tab" id="tab-kanban" role="tabpanel">
      ${kanban}
    </section>

    <section class="tab" id="tab-stats" role="tabpanel">
      ${stats}
    </section>
  </main>
  <script>
    (function () {
      const buttons = document.querySelectorAll('.tabs button');
      const panels = document.querySelectorAll('.tab');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          buttons.forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
          panels.forEach((p) => p.classList.remove('active'));
          btn.classList.add('active');
          btn.setAttribute('aria-selected', 'true');
          const target = document.getElementById('tab-' + btn.dataset.tab);
          if (target) target.classList.add('active');
        });
      });
    })();
  </script>
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
