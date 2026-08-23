// Analytics-consent knobs (PPR-P2).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob THE CONSENT GATE
// introduces lives HERE, once, with changed_in provenance — never as a literal
// in the shell or in surfaces/consent.js. It takes the place transfer/config.js
// vacated in the same packet, so the mount still ships four device-local config
// surfaces: store/, export/, channel/ and this one.
//
// WHERE THE VOCABULARY LIVES AND WHERE THE STATE LIVES, which is CHANNEL_CONFIG's
// split (DIA-DL-004) applied to a knob whose flip is not the owner's. For the
// download control the vocabulary is here and the VALUE is a <meta> the owner
// edits; for consent the vocabulary is here and the value is the visitor's own
// answer, in their own browser. What both have in common is the reason: the mount
// is served `public, immutable, max-age=2592000` and its bytes are never
// rewritten (A1-DL-004), so nothing that changes at a different rhythm from the
// mount may live in it.
//
// ONE PART OF THE VOCABULARY IS DELIBERATELY NOT HERE: the localStorage key.
// core/storage.js declares key identity for every key this app touches, and that
// is its stated job; a second copy here would be a second thing to drift. The two
// files are paired by app/tests/consent-gate.spec.js instead.
//
// This file ships to BOTH delivery channels byte-identically (LSC-P1-INV-002) and
// is inert on both: nothing here reads, writes or requests anything. Which
// channel asks the question at all is decided at runtime in surfaces/consent.js —
// a branch, never a second build (PDR-034 §3). The native channel carries no
// analytics and asks nothing (L1-P4), and this packet does not change that.

export const CONSENT_CONFIG = Object.freeze({
    // changed_in: PPR-DL-002 — the ONE stored value that means "load analytics".
    // Anything else, including the absence of the key, is not consent. The
    // asymmetry is the design: consent is a specific act, and everything that is
    // not that act fails closed.
    stateGranted: 'granted',

    // changed_in: PPR-DL-002 — the ONE stored value that means "the visitor was
    // asked and said no". It differs from undecided in exactly one respect —
    // whether the banner is shown again — because asking is not a harm and
    // loading is. A visitor who declined is not asked again; a visitor whose
    // stored value is unreadable is, and loads nothing meanwhile.
    stateDenied: 'denied',

    // changed_in: PPR-DL-002 — the name of the global the SHELL defines and this
    // mount calls. `window[shellBridge].enable()` creates the loader tag and
    // configures GA4; `.disable()` sets Google's own ga-disable-<id> switch and
    // stops trackEvent.
    //
    // WHY A NAMED GLOBAL AND NOT THE MEASUREMENT ID IN THIS FILE. The analytics
    // vocabulary — the id, the loader URL, GA_DEBUG, trackEvent — has lived in
    // the shell since the beginning and is left there: moving it into an
    // immutable mount would buy nothing and would put a third-party address in a
    // generation that can never be edited. What moves is the DECISION. So the
    // seam between the two is one name, declared here so a static leg can pair
    // the mount's caller with the shell's definition, and neither can be renamed
    // alone.
    shellBridge: 'theygrowAnalytics',
});
