'use strict';

// The footer's height across filter states (L1-P3, LSC-DL-003 (r) and (w)).
//
// THE JUMP IS REAL, AND THIS FILE IS WHAT ESTABLISHED IT. When the ZPD filter
// is on, the filter button's label shortens to «Показать все навыки»; in the
// pinned container that label stops wrapping and the footer drops from
// 68.78 px to 55 px, taking the whole page above it along. The mount's `app.css`
// reserves exactly two lines (`height: calc(2lh + 16px)`) so the control height
// no longer depends on how many lines a label takes.
//
// READ THIS BEFORE TRUSTING A LOCAL RUN OF THIS FILE. The same declarations
// render differently here and in the container — font metrics differ, and the
// jump this file exists to catch DOES NOT REPRODUCE on a developer machine.
// A local green here is not evidence; `scripts/parity-suite.sh` in the pinned
// container is the arbiter for anything about rendered geometry. This packet
// learned that the expensive way: a local measurement said there was no jump,
// the pin was removed on the strength of it, and the container put it back.
//
// Both directions are asserted, in BOTH filter states, at the mobile viewport
// where the constraint binds:
//   - no control's content overflows its box;
//   - the height does not move between the two states.

const { test, expect, gotoApp, STATES } = require('./support/seed');

const FOOTER = 'footer.control-footer';

// Measured through the live layout rather than compared against a pixel
// constant: a constant would need re-blessing on every font or padding change
// and would say nothing about whether the text actually fits.
function metrics(page) {
  return page.evaluate((selector) => {
    const footer = document.querySelector(selector);
    return {
      footerHeight: footer.getBoundingClientRect().height,
      controls: Array.from(footer.querySelectorAll('button')).map((el) => ({
        id: el.id,
        text: el.textContent.trim(),
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      })),
    };
  }, FOOTER);
}

test.describe('the footer holds its height across filter states', () => {
  for (const [label, state] of [
    ['filter inactive', STATES.seeded],
    ['filter active', STATES.seededFiltered],
  ]) {
    test(`no footer control overflows its box (${label})`, async ({ page }) => {
      await gotoApp(page, { state });
      const { controls } = await metrics(page);

      // Anti-vacuity: an empty footer would pass every assertion below.
      expect(controls.length, 'no footer controls found — the scan would be vacuous').toBeGreaterThan(
        1
      );

      for (const control of controls) {
        // THIS IS THE PRICE OF THE PIN, AND THE ONLY THING WATCHING IT. The
        // reserved two lines make the height constant; they also mean a label
        // that outgrows two lines loses the rest inside `overflow: hidden`
        // instead of pushing the footer taller. Nobody sees that happen — a
        // copy edit, a translation, or a font change in the container is enough
        // to cause it. So it reds here instead, with the numbers that say by
        // how much. Do not relax this assertion; raise the reserve in
        // the mount's app.css or shorten the label.
        expect(
          control.scrollHeight,
          `#${control.id} ("${control.text}") is clipped vertically:`
            + ` needs ${control.scrollHeight}px inside ${control.clientHeight}px.`
            + ' The label outgrew the two lines the footer reserves — shorten it or'
            + ' raise the reserve, but do not let it clip silently.'
        ).toBeLessThanOrEqual(control.clientHeight);
        expect(
          control.scrollWidth,
          `#${control.id} ("${control.text}") is clipped horizontally`
        ).toBeLessThanOrEqual(control.clientWidth);
      }
    });
  }

  test('toggling the filter does not move the footer height', async ({ page }) => {
    // The runtime path, not two separate loads: this is the exact transition
    // that used to jump — the filter button swaps its own label in place.
    await gotoApp(page, { state: STATES.seeded });
    const inactive = await metrics(page);

    await page.locator('#zpdFilterToggleBtn').click();
    await expect(page.locator('#zpdFilterToggleBtn')).toHaveClass(/active/);
    const active = await metrics(page);

    // Anti-vacuity: if the label did not actually change, the assertion below
    // would hold for the wrong reason.
    const before = inactive.controls.find((c) => c.id === 'zpdFilterToggleBtn').text;
    const after = active.controls.find((c) => c.id === 'zpdFilterToggleBtn').text;
    expect(after, 'the filter button did not change its label').not.toBe(before);

    expect(
      active.footerHeight,
      `the footer moved from ${inactive.footerHeight}px to ${active.footerHeight}px`
        + ' when the filter was toggled — the page above it jumps with it'
    ).toBe(inactive.footerHeight);
  });
});
