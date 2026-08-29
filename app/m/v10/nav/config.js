// Navigation knobs (NAV-P3).
//
// OPERABILITY (ADR-013 / contract §4.7). Every qualitative knob THE NAVIGATION
// introduces lives HERE, once, with changed_in provenance — never as a literal
// in a surface, in the shell or in the stylesheet. It arrives as the FOURTH
// device-local config surface shipped under this mount, beside store/config.js
// ("every qualitative knob THE STORE introduces"), export/config.js ("...the
// export contour...") and channel/config.js ("...the channel composition..."),
// following the same precedent chain: CACHE_VERSION in app/sw.js (PWA-DL-001),
// then store/config.js (LSC-DL-002), export/config.js (LSC-DL-003) and
// channel/config.js (DIA-DL-004). The typed versioned surface of ADR-013 is
// api/theygrow_api/parameters.py, which is server-side and untouched by a
// device-local packet.
//
// A SURFACE OF ITS OWN, AND NOT FOUR MORE ENTRIES IN channel/config.js. That
// file declares its subject at its head — which actions THIS CHANNEL offers —
// and a gesture threshold is not that. What decides whether a page turn is a
// page turn is the same on every channel; what decides whether the recogniser
// is armed at all is the channel, and that decision stays where the other
// channel decisions are (surfaces/channel.js::shouldOfferSurfacePager).
//
// THIS FILE SHIPS TO BOTH DELIVERY CHANNELS BYTE-IDENTICALLY (LSC-P1-INV-002)
// and is inert on both: nothing here reads, writes or requests anything. On the
// web channel nothing ever reads these values at all, because nothing arms the
// pager there — see app/tests/surface-pager.spec.js, which executes that.
//
// NO SIGNAL AND NO COUNTER STANDS BEHIND ANY OF THESE. A knob that tunes a
// gesture is not a measurement of one: nothing counts swipes, page turns or
// back presses, on either channel, and core/signals.js is not touched by this
// packet. The absence is a decision, on the NAV-P2 stance, not an omission.

export const NAV_CONFIG = Object.freeze({
    // changed_in: NAV-DL-003 — the horizontal distance that turns a drag into a
    // page turn, in CSS pixels.
    //
    // WHY A DISTANCE AND NOT A FRACTION OF THE VIEWPORT. A fraction makes the
    // same finger movement mean different things on a phone and on a tablet,
    // and the thing being measured here is a finger, not a screen. 60px is
    // roughly a thumb's comfortable sweep and comfortably past the ~10px slop
    // a browser already allows a tap.
    pageTurnMinDistancePx: 60,

    // changed_in: NAV-DL-003 — THE WHOLE SEPARATION BETWEEN A PAGE TURN AND A
    // SCROLL, and the most consequential number in this file.
    //
    // A drag is a page turn only while |dy| <= ratio * |dx|. At 0.6 the
    // gesture has to be within about 31 degrees of horizontal. Raise this and
    // a parent scrolling the skills table with a slightly slanted thumb loses
    // their place to a page turn; lower it and a deliberate sideways sweep
    // stops working for anyone who does not draw a straight line.
    //
    // The recogniser NEVER calls preventDefault, so a gesture rejected here is
    // not a gesture suppressed: the browser scrolls exactly as it always did.
    // That is what makes an error in this direction cheap and an error in the
    // other direction expensive.
    pageTurnMaxOffAxisRatio: 0.6,

    // changed_in: NAV-DL-003 — the shortest drag a FAST flick may be.
    //
    // Two paths to a page turn, not one: a long slow drag (the knob above) and
    // a short fast flick (this one with the next). Without the second, a quick
    // confident sweep — which is how the gesture is actually performed once it
    // is known — has to be drawn out to 60px before it counts, and the app
    // feels like it did not notice. 24px still refuses a tap by an order of
    // magnitude.
    pageTurnFlickMinDistancePx: 24,

    // changed_in: NAV-DL-003 — the velocity, in CSS pixels per millisecond,
    // that lets a short drag count as a flick. 0.5 px/ms is 500 px/s: fast
    // enough that no scroll adjustment or accidental slide reaches it.
    //
    // Measured from pointerdown to pointerup over the whole gesture, not from
    // the last sample: the last sample of a finger that has already stopped is
    // near zero, and a gesture that ends in a pause is still a flick.
    pageTurnFlickMinVelocityPxPerMs: 0.5,

    // changed_in: NAV-DL-003 — how long the incoming surface takes to arrive,
    // in milliseconds, and THE ONLY LITERAL THAT DURATION HAS.
    //
    // ONE LITERAL FOR TWO PLACES, on the NAV-DL-002 precedent (the update row's
    // fill IS its deadline). surfaces/pager.js writes this value onto the
    // document element as the custom property --surface-transition-ms, and
    // app.css reads that property WITH NO FALLBACK. An unset property means no
    // animation, never a different duration — which is exactly the web
    // channel's state, because nothing arms the pager there to write it.
    //
    // ENTER ONLY. There is deliberately no exit animation and therefore no
    // second duration: an exit would have to hold a surface visible past the
    // moment the decision was taken, which puts a timer between a parent's
    // press of the hardware back button and the app's state. See app.css.
    surfaceTransitionMs: 220,

    // changed_in: NAV-DL-003 — how long a back press may stand unanswered
    // before the native side stops waiting for the WebView, in milliseconds.
    //
    // WHY THIS IS A JS KNOB AND NOT A JAVA LITERAL. It is passed into the
    // plugin at arm() rather than written into BackButtonPlugin.java, on the
    // rule the update deadline already follows: one declaration, in the
    // declared place, and no second copy that can drift out of agreement with
    // this one.
    //
    // WHAT IT PROTECTS. The plugin hands each press to JavaScript and waits for
    // an answer. If the WebView is wedged, an answer never comes — and a family
    // whose Back button has stopped working is a worse failure than any
    // navigation bug this packet fixes. So a press arriving while an earlier
    // one has stood unanswered for longer than this takes the platform default
    // instead. 700 ms is longer than the bridge round trip by two orders of
    // magnitude and shorter than a person's patience.
    backAnswerDeadlineMs: 700,
});
