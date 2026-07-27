'use strict';

// Structural digests for the parity suite (A1-P1).
//
// #tableBody is 174 skill rows x 73 month columns — roughly 12,700 cells. Its
// full markup is committed as a SHA-256 (see normalize.captureHash), which
// catches everything but names nothing: a failing hash says "something moved"
// and stops there.
//
// These digests are the readable half. They record the state that actually
// carries product meaning — skill identity, ZPD readiness, completion, the
// month-window band — in a form where a regression names itself in the diff.
// Month cells are run-length encoded so 73 columns collapse to a handful of
// entries.

const { ENTRY_URL } = require('./app-module');

// Serialized in the browser; must stay self-contained.
function tableDigestInPage() {
  const rle = (values) => {
    const out = [];
    for (const v of values) {
      const last = out[out.length - 1];
      if (last && last[1] === v) last[0] += 1;
      else out.push([1, v]);
    }
    return out.map(([n, v]) => (n === 1 ? v : `${n}x${v}`));
  };

  const rows = [];
  document.querySelectorAll('#tableBody tr').forEach((tr) => {
    if (tr.classList.contains('category-row')) {
      const firstCell = tr.querySelector('td');
      rows.push({
        type: 'category',
        text: (firstCell ? firstCell.textContent : '').trim(),
        count: firstCell ? firstCell.getAttribute('data-skills-count') : null,
        classes: Array.from(tr.classList).sort().join(' '),
        hidden: tr.classList.contains('hidden'),
        inlineDisplay: tr.style.display || null,
      });
      return;
    }

    const checkbox = tr.querySelector('input[type="checkbox"]');
    const monthClasses = Array.from(tr.querySelectorAll('td.col-month')).map((td) =>
      Array.from(td.classList).sort().join('|')
    );

    rows.push({
      type: 'skill',
      id: tr.dataset.skillId,
      name: (tr.querySelector('td.col-skill') || {}).textContent,
      classes: Array.from(tr.classList).sort().join(' '),
      zpdReady: tr.dataset.zpdReady,
      startMonth: tr.dataset.startMonth,
      endMonth: tr.dataset.endMonth,
      checked: checkbox ? checkbox.checked : null,
      hidden: tr.classList.contains('hidden'),
      inlineDisplay: tr.style.display || null,
      months: rle(monthClasses),
    });
  });

  const head = Array.from(document.querySelectorAll('#tableHead th')).map((th) => ({
    text: th.textContent.trim(),
    classes: Array.from(th.classList).sort().join(' '),
    month: th.dataset.month || null,
    hidden: th.classList.contains('hidden'),
    inlineDisplay: th.style.display || null,
  }));

  return { head, rows };
}

async function captureTableDigest(page) {
  const digest = await page.evaluate(tableDigestInPage);
  return JSON.stringify(digest, null, 1) + '\n';
}

// Hash of every skill-modal body, opened one at a time. This is the direct
// automation of the VDK-P3 method (docs/decision-log.md:617): "all 174
// skill-modal bodies". One line per skill keeps the diff pinpoint-able.
async function captureAllSkillModalBodies(page) {
  const hashes = await page.evaluate(async (entryUrl) => {
    // NOTE: the app's bindings are module-scoped since A1-P4 — neither global
    // lexical identifiers nor window properties. They are reached through the
    // entry module's parity seam; import() of the already-loaded URL returns the
    // instance the page booted (see support/app-module.js).
    // Reuse the app's own opener so the captured markup is what users see.
    const app = await import(entryUrl);
    const ids = Object.keys(app.DATA._skillsMap).sort();
    const enc = new TextEncoder();
    const out = [];
    for (const id of ids) {
      app.openSkillModal(app.DATA._skillsMap[id], false, 'parity_capture');
      const html = document.getElementById('skillModalBody').innerHTML;
      const buf = await crypto.subtle.digest('SHA-256', enc.encode(html));
      const hex = Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      out.push(`${id}  ${hex}`);
    }
    app.closeSkillModal('parity_capture');
    return out;
  }, ENTRY_URL);
  return hashes.join('\n') + '\n';
}

module.exports = { captureTableDigest, captureAllSkillModalBodies };
