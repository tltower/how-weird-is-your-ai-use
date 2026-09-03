const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let state = null;
let activeSource = localStorage.getItem("ai-use-profile-source") === "claude" ? "claude" : "codex";
let activeTaxonomy = "coding";
let activeRubric = "task_criticality";
let pollTimer = null;
let activeCategoryRows = [];
let selectActiveCategory = null;

const percent = (value, digits = 0) => `${(100 * (value || 0)).toFixed(digits)}%`;
const number = (value, digits = 1) => value == null ? "—" : Number(value).toFixed(digits);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");
const label = (value) => String(value || "—").replaceAll("_", " ");

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function renderReadiness() {
  const counts = state.taskImport.counts;
  const cohort = state.taskImport.cohort;
  const contextual = cohort.counts.withContext
    ?? ((cohort.counts.cachedSummaries || 0) + (cohort.counts.initialPreviews || 0));
  $("#indexed-tasks").textContent = counts.tasks.toLocaleString();
  $("#cohort-tasks").textContent = cohort.counts.tasks.toLocaleString();
  $("#enriched-tasks").textContent = contextual.toLocaleString();
  $("#classified-tasks").textContent = `${state.profile.coverage.classified} / ${cohort.counts.tasks}`;
  $("#footer-cohort-size").textContent = cohort.counts.tasks.toLocaleString();
}

function renderPlatform() {
  const isClaude = activeSource === "claude";
  const sourceName = isClaude ? "Claude Code" : "Codex";
  $("#platform-lede").textContent = `${sourceName} session history, projected onto Anthropic’s published taxonomy.`;
  $("#footer-source-label").textContent = sourceName;
  $("#job-platform").textContent = `LIVE ${state?.activeJob?.agentProviderLabel?.toUpperCase() || sourceName.toUpperCase()} RUN`;
  $$('[data-source]').forEach((button) => button.classList.toggle("active", button.dataset.source === activeSource));
}

function renderSummary() {
  const profile = state.profile;
  const taxonomy = profile.taxonomies[activeTaxonomy];
  const classified = profile.coverage.classified;
  const cohortSize = profile.coverage.indexed;
  const cohortComplete = classified >= cohortSize && cohortSize > 0;
  const score = taxonomy.uniquenessScore;
  $("#uniqueness-score").textContent = score ?? "—";
  const description = score == null ? "" : score < 20 ? "Very similar" : score < 40 ? "Somewhat different" : score < 60 ? "Distinct" : score < 80 ? "Very distinct" : "Almost non-overlapping";
  $("#uniqueness-copy").textContent = classified
    ? `${description}. The score is 100 × Jensen–Shannon divergence: 0 means the same category mix; 100 means no overlap.`
    : "Analyze the recent cohort to compare its category distribution with the baseline.";
  $("#run-recent").dataset.complete = cohortComplete ? "true" : "false";
  $("#run-recent").classList.toggle("hidden", cohortComplete);
  $("#run-recent").textContent = classified ? `ANALYZE ${cohortSize - classified} REMAINING` : `ANALYZE RECENT ${cohortSize}`;
}

function histogramCeiling(rows) {
  const maximum = 100 * Math.max(...rows.flatMap((row) => [row.userRatio, row.referenceRatio]), 0.01);
  const roughStep = maximum / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const niceStep = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((value) => value >= normalized) || 10;
  return niceStep * magnitude * 4 / 100;
}

function categoryBin(row, index, ceiling) {
  const userHeight = 100 * row.userRatio / ceiling;
  const baselineHeight = 100 * row.referenceRatio / ceiling;
  const userIsTaller = userHeight > baselineHeight;
  const userLayer = userIsTaller ? "back" : "front";
  const baselineLayer = userIsTaller ? "front" : "back";
  const shareDigits = Math.max(row.userRatio, row.referenceRatio) < 0.01 ? 2 : 1;
  const accessibleName = `${row.name}. ${row.count} tasks, you ${percent(row.userRatio, shareDigits)}, baseline ${percent(row.referenceRatio, shareDigits)}.`;
  return `
    <button class="category-bin" data-category-index="${index}" type="button" title="${escapeHtml(accessibleName)}" aria-label="${escapeHtml(accessibleName)}">
      <span class="bar-pair" aria-hidden="true">
        <i class="frequency-bar baseline ${baselineLayer}" style="--h:${baselineHeight.toFixed(2)}%"></i>
        <i class="frequency-bar you ${userLayer}" style="--h:${userHeight.toFixed(2)}%"></i>
      </span>
      <span class="bin-number">${String(index + 1).padStart(3, "0")}</span>
    </button>
  `;
}

function categoryDetail(row, index) {
  const delta = row.deltaPercentagePoints;
  const direction = delta >= 0 ? "over" : "under";
  const shareDigits = Math.max(row.userRatio, row.referenceRatio) < 0.01 ? 2 : 1;
  return `
    <div class="category-detail-number">CATEGORY ${String(index + 1).padStart(3, "0")}</div>
    <div>
      <strong>${escapeHtml(row.name)}</strong>
      <p>${escapeHtml(row.description)}</p>
    </div>
    <div class="category-detail-values">
      <span>YOU <b>${percent(row.userRatio, shareDigits)}</b></span>
      <span>BASELINE <b>${percent(row.referenceRatio, shareDigits)}</b></span>
      <span>DIFFERENCE <b class="${direction}">${delta > 0 ? "+" : ""}${number(delta, 1)} pp</b></span>
    </div>
  `;
}

function connectCategoryHistogram(rows) {
  const detail = $("#category-detail");
  const bins = $$(".category-bin");
  const select = (index) => {
    bins.forEach((bin) => bin.classList.toggle("active", Number(bin.dataset.categoryIndex) === index));
    detail.innerHTML = categoryDetail(rows[index], index);
  };
  bins.forEach((bin) => {
    const index = Number(bin.dataset.categoryIndex);
    bin.addEventListener("mouseenter", () => select(index));
    bin.addEventListener("focus", () => select(index));
    bin.addEventListener("click", () => select(index));
  });
  selectActiveCategory = select;
  select(0);
}

function renderCategorySearch() {
  const input = $("#category-search");
  const results = $("#category-search-results");
  const query = input.value.trim().toLocaleLowerCase();
  const categories = activeCategoryRows.map((category, index) => ({ ...category, index }));
  const matches = query
    ? categories.filter((category) => `${category.name} ${category.description}`.toLocaleLowerCase().includes(query))
    : categories.filter((category) => category.count > 0);
  const visible = matches.slice(0, 2);
  $("#clear-category-search").classList.toggle("hidden", !query);
  $("#category-search-count").textContent = query
    ? `${matches.length} ${matches.length === 1 ? "MATCH" : "MATCHES"}`
    : `${matches.length} USED · ${visible.length} SHOWN`;
  if (!visible.length) {
    results.innerHTML = '<div class="category-search-empty">NO MATCHING CATEGORIES</div>';
    return;
  }
  results.innerHTML = visible.map((category) => {
    const shareDigits = Math.max(category.userRatio, category.referenceRatio) < 0.01 ? 2 : 1;
    return `
    <button class="category-search-result" data-category-index="${category.index}" type="button">
      <b>${escapeHtml(category.name)}</b>
      <span>${category.count} ${category.count === 1 ? "task" : "tasks"} · you ${percent(category.userRatio, shareDigits)} · baseline ${percent(category.referenceRatio, shareDigits)}</span>
      <em>SHOW BAR</em>
    </button>
  `;
  }).join("");
  $$(".category-search-result").forEach((button) => button.addEventListener("click", () => {
    const index = Number(button.dataset.categoryIndex);
    $("#distribution-histogram").scrollIntoView({ behavior: "auto", block: "center" });
    requestAnimationFrame(() => selectActiveCategory?.(index));
  }));
}

function renderDistributionComparison() {
  const taxonomy = state.profile.taxonomies[activeTaxonomy];
  const cohortSize = state.profile.coverage.indexed.toLocaleString();
  $("#taxonomy-note").textContent = activeTaxonomy === "coding"
    ? `Your ${cohortSize} recent ${state.sourceLabel} sessions versus METR’s published Claude Code task distribution.`
    : `Your ${cohortSize} recent ${state.sourceLabel} sessions versus Stanford’s mixed Claude.ai and Claude Code distribution.`;
  const rows = taxonomy.rows.slice().sort((left, right) => (
    Math.max(right.userRatio, right.referenceRatio) - Math.max(left.userRatio, left.referenceRatio)
    || Math.abs(right.deltaPercentagePoints) - Math.abs(left.deltaPercentagePoints)
    || left.name.localeCompare(right.name)
  ));
  const chart = $("#distribution-histogram");
  if (!rows.length) {
    chart.className = "category-histogram empty-state";
    chart.innerHTML = "<span>No classifications yet.</span>";
    $("#category-search-results").innerHTML = "";
    $("#category-detail").innerHTML = "";
    return;
  }
  activeCategoryRows = rows;
  const ceiling = histogramCeiling(rows);
  $("#category-count").textContent = `${rows.length} CATEGORIES`;
  $("#histogram-axis").innerHTML = [4, 3, 2, 1, 0].map((part) => {
    const value = ceiling * part / 4;
    return `<span style="--y:${100 - part * 25}%">${percent(value, value < 0.01 ? 1 : 0)}</span>`;
  }).join("");
  chart.className = "category-histogram";
  chart.innerHTML = rows.map((row, rowIndex) => categoryBin(row, rowIndex, ceiling)).join("");
  connectCategoryHistogram(rows);
  renderCategorySearch();
}

function renderRubric() {
  const rubric = state.profile.rubrics[activeRubric];
  const definitions = state.profile.rubricDefinitions?.[activeRubric];
  const rows = rubric.rows || [];
  $("#rubric-note").textContent = `${rubric.total} categorized records; ${rubric.coverageCount} evidence-supported (${percent(rubric.coverage)} coverage). Coral is you; blue-gray is Anthropic’s reference.`;
  if (!state.profile.coverage.classified) {
    $("#rubric-chart").className = "distribution-chart empty-state";
    $("#rubric-chart").innerHTML = "<span>No classifications yet.</span>";
    return;
  }
  $("#rubric-chart").className = "distribution-chart";
  $("#rubric-chart").innerHTML = rows.map((row, index) => {
    const definition = definitions?.options?.[row.value] || "No definition is available.";
    const tooltipId = `rubric-definition-${activeRubric}-${index}`;
    return `
    <div class="distribution-row">
      <div class="distribution-label">
        <button class="definition-trigger" type="button" aria-label="Define ${escapeHtml(label(row.name || row.value))}" aria-describedby="${tooltipId}">
          <span>${escapeHtml(label(row.name || row.value))}</span><i aria-hidden="true">?</i>
          <span class="definition-tooltip" id="${tooltipId}" role="tooltip">${escapeHtml(definition)}</span>
        </button>
      </div>
      <div class="dual-track">
        <span class="you" style="--w:${Math.max(.6, row.userRatio * 100).toFixed(1)}%"></span>
        <span class="reference" style="--w:${Math.max(.6, row.referenceRatio * 100).toFixed(1)}%"></span>
      </div>
      <div class="distribution-value"><strong>${percent(row.userRatio)}</strong><small>REF ${percent(row.referenceRatio)}</small></div>
    </div>
  `;
  }).join("");
}

function renderAudit() {
  const records = state.profile.records.slice(0, 30);
  const coverage = state.profile.coverage;
  $("#evidence-coverage").textContent = `${coverage.classified} RECORDS · ${coverage.byEvidence.titleOnly} TITLE-ONLY`;
  if (!records.length) {
    $("#audit-table").innerHTML = '<tr><td colspan="6" class="empty-cell">Classified tasks will appear here.</td></tr>';
    return;
  }
  const codeNames = new Map(state.profile.taxonomies.coding.rows.map((row) => [row.id, row.name]));
  $("#audit-table").innerHTML = records.map((record) => `
    <tr title="${escapeHtml(record.rationale)}">
      <td>${escapeHtml(record.task?.title || record.task_id)}</td>
      <td>${escapeHtml(codeNames.get(record.coding_cluster_id) || record.coding_cluster_id)}</td>
      <td>${escapeHtml(label(record.task_criticality))}</td>
      <td>${escapeHtml(label(record.human_agency_level))}</td>
      <td><span class="badge">${escapeHtml(label(record.task?.summarySource || "missing"))}</span></td>
      <td>${escapeHtml(record.cluster_confidence)} / ${escapeHtml(record.rubric_confidence)}</td>
    </tr>
  `).join("");
}

function renderJob(job) {
  const panel = $("#job-panel");
  const running = job && ["starting", "running"].includes(job.status);
  panel.classList.toggle("hidden", !job);
  $("#cancel-run").classList.toggle("hidden", !running);
  const cohortComplete = $("#run-recent").dataset.complete === "true";
  $("#run-recent").disabled = running || cohortComplete;
  if (!job) return;
  $("#job-phase").textContent = job.phase;
  $("#job-platform").textContent = `LIVE ${job.agentProviderLabel.toUpperCase()} RUN`;
  $("#job-message").textContent = job.errors?.length ? job.errors[0] : job.lastMessage;
  const progress = job.status === "completed" ? 100 : job.status === "failed" || job.status === "cancelled" ? 100 : Math.max(7, 100 * (job.completedWorkers || 0) / Math.max(1, job.totalShards));
  $("#job-progress-bar").style.width = `${progress}%`;
}

function render() {
  renderPlatform();
  renderReadiness();
  renderSummary();
  renderDistributionComparison();
  renderRubric();
  renderAudit();
  renderJob(state.activeJob || state.jobs?.[0] || null);
}

async function boot() {
  try {
    state = await request(`/api/bootstrap?source=${encodeURIComponent(activeSource)}`);
    activeSource = state.source;
    render();
    if (state.activeJob) beginPolling();
  } catch (error) {
    $("#indexed-tasks").textContent = "OFFLINE";
    $("#taxonomy-note").textContent = error.message;
  }
}

async function startRun(limit) {
  try {
    const result = await request("/api/analyze", { method: "POST", body: JSON.stringify({ limit, source: activeSource }) });
    state.activeJob = result.job;
    renderJob(result.job);
    beginPolling();
  } catch (error) {
    $("#taxonomy-note").textContent = error.message;
  }
}

function beginPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const result = await request("/api/job");
    state.activeJob = result.activeJob;
    state.jobs = result.jobs;
    const latest = result.activeJob || result.jobs?.[0] || null;
    renderJob(latest);
    if (!result.activeJob) {
      clearInterval(pollTimer);
      await boot();
    }
  }, 1400);
}

$("#run-recent").addEventListener("click", () => startRun("all"));
$("#cancel-run").addEventListener("click", async () => {
  await request("/api/job/cancel", { method: "POST", body: "{}" });
  await boot();
});
$("#refresh-tasks").addEventListener("click", async () => {
  const button = $("#refresh-tasks");
  button.disabled = true;
  button.textContent = "REFRESHING…";
  try { await request("/api/tasks/refresh", { method: "POST", body: JSON.stringify({ source: activeSource }) }); await boot(); }
  catch (error) { $("#taxonomy-note").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "REFRESH TASK INDEX"; }
});

$$('[data-source]').forEach((button) => button.addEventListener("click", async () => {
  if (button.dataset.source === activeSource) return;
  activeSource = button.dataset.source;
  localStorage.setItem("ai-use-profile-source", activeSource);
  $$('[data-source]').forEach((candidate) => { candidate.disabled = true; });
  $("#category-search").value = "";
  try { await boot(); }
  finally { $$('[data-source]').forEach((candidate) => { candidate.disabled = false; }); }
}));

$("#category-search").addEventListener("input", renderCategorySearch);
$("#clear-category-search").addEventListener("click", () => {
  $("#category-search").value = "";
  $("#category-search").focus();
  renderCategorySearch();
});

$$('[data-taxonomy]').forEach((button) => button.addEventListener("click", () => {
  activeTaxonomy = button.dataset.taxonomy;
  $$('[data-taxonomy]').forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  renderSummary();
  renderDistributionComparison();
}));

$$('[data-rubric]').forEach((button) => button.addEventListener("click", () => {
  activeRubric = button.dataset.rubric;
  $$('[data-rubric]').forEach((candidate) => candidate.classList.toggle("active", candidate === button));
  renderRubric();
}));

boot();
