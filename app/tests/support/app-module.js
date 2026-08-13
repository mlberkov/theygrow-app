'use strict';

// Handle on the booted app entry module (A1-P4).
//
// Until P4 the app's bindings were declared with let/const in a classic inline
// script, so they lived in the global LEXICAL scope and this suite reached them
// as bare identifiers. Module scope removes that, and A1-P1-INV-001 still needs
// the openers and the skills map.
//
// The replacement seam is the entry module's export surface — deliberately NOT
// a window.* global, so nothing on the page can trip over it (see the seam
// comment at the foot of the mount's app.js). import() of an already-loaded URL
// returns the SAME module instance the page booted: the module map is keyed by
// resolved URL per document. This is therefore a handle on the live app, not a
// second copy of it.
//
// If this URL ever changes, every seam call site fails loudly here rather than
// silently testing something else.

const fs = require('fs');
const path = require('path');
const { currentMount } = require('./ship-list');

// Derived from the shell rather than pinned (EMV-DL-001): after a mount bump
// the frozen generation is still served, so a pinned URL would import a module
// the running app does not use.
const ENTRY_URL = `${currentMount(
  fs.readFileSync(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8')
).prefix}app.js`;

// Resolves to a JSHandle for the entry module's namespace object. Pass it into
// page.evaluate like any other argument (Playwright accepts handles nested in
// objects and arrays).
async function appModule(page) {
  return page.evaluateHandle((url) => import(url), ENTRY_URL);
}

module.exports = { ENTRY_URL, appModule };
