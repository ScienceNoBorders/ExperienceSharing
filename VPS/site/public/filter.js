(function () {
  const form = document.getElementById("filter-form");
  const table = document.getElementById("plan-table");
  const empty = document.getElementById("empty-filter");
  const countEl = document.getElementById("f-count");
  if (!form || !table) return;
  const rows = [...table.tBodies[0].rows];

  function apply() {
    const budgetRaw = form.budget.value.trim();
    const budget = budgetRaw === "" ? null : Number(budgetRaw);
    const cycle = form.cycle.value;
    const region = form.region.value;
    const route = form.route.value;
    const vendor = form.vendor.value;
    const strict = form.strict.checked;
    const ips = [...form.querySelectorAll('input[name="ip"]:checked')].map((i) => i.value);
    let shown = 0;
    for (const tr of rows) {
      let ok = true;
      if (vendor && tr.dataset.vendor !== vendor) ok = false;
      if (ok && region && !(tr.dataset.regions || "").split(",").includes(region)) ok = false;
      if (ok && route) {
        const g = tr.dataset.routeGroup;
        if (g !== route && tr.dataset.route !== route) ok = false;
      }
      if (ok && ips.length && !ips.includes(tr.dataset.ip)) ok = false;
      if (ok && strict) {
        const cycles = (tr.dataset.cycles || "").split(",");
        if (!cycles.includes(cycle)) ok = false;
      }
      if (ok && budget != null) {
        const cny =
          cycle === "monthly"
            ? Number(tr.getAttribute("data-monthly-cny"))
            : Number(tr.getAttribute("data-annual-cny"));
        if (!cny || cny > budget * 1.02) ok = false;
      }
      tr.hidden = !ok;
      if (ok) shown += 1;
    }
    if (empty) empty.classList.toggle("show", shown === 0);
    if (countEl) countEl.textContent = `显示 ${shown} / ${rows.length}`;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    apply();
  });
  form.addEventListener("reset", () => {
    setTimeout(apply, 0);
  });
  form.querySelectorAll("select, input").forEach((el) => el.addEventListener("change", apply));
  apply();
})();
