'use strict';

// DOM normalization for parity baselines (A1-P1).
//
// The goal is a byte-stable, human-diffable rendering of a container's markup.
// The only transformation applied is a newline between adjacent tags (`><` ->
// `>\n<`). That never touches a text node — it only splits tag boundaries — so
// the baseline stays a faithful record of the DOM while producing reviewable
// diffs instead of one 100 KB line.

const crypto = require('crypto');

function prettifyHtml(html) {
  return String(html).replace(/></g, '>\n<').trim() + '\n';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// outerHTML of a single element, normalized.
async function captureHtml(page, selector) {
  const html = await page.locator(selector).first().evaluate((el) => el.outerHTML);
  return prettifyHtml(html);
}

// Full-fidelity hash of a container. Used where the markup is too large to
// commit verbatim (#tableBody is 174 rows x 73 month columns).
async function captureHash(page, selector) {
  const html = await page.locator(selector).first().evaluate((el) => el.outerHTML);
  return sha256(html);
}

module.exports = { prettifyHtml, sha256, captureHtml, captureHash };
