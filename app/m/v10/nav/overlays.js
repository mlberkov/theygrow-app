// The overlays that stand IN FRONT OF a surface, declared once (NAV-P3).
//
// WHAT THIS LIST IS FOR. Two mechanisms need the same answer and must not
// answer it twice. The hardware back button (surfaces/back.js) closes the
// topmost open one before it touches the pager. The page-turn recogniser
// (surfaces/pager.js) refuses to start a gesture while one is open, because a
// finger inside a window that lies over the app is not turning the app's pages.
// Declaring the list here is what keeps those two from drifting apart.
//
// THE DIARY IS NOT IN THIS LIST, AND THAT IS THE WHOLE POINT OF THE PACKET.
// #diaryModal wears the .modal class and opens the way the modals do, but since
// NAV-P3 it is a SURFACE of the pager, not a window over one — so back does not
// «close» it, it steps the pager left, and a right-drag inside it turns the
// page rather than being refused. The class it wears is markup history; what it
// IS is declared in surfaces/pager.js.
//
// NEITHER IS THE HEADER MENU, AND THE EXEMPTION IS NAMED RATHER THAN SILENT.
// #headerMenuPanel is a panel, not a modal: it closes on any click outside it
// and on Escape (surfaces/menu.js), it has no close control to press, and
// scope item 5 of this packet says «modal». Same for #profileDropdown, and for
// the two banners, which are announcements rather than windows. Those
// exemptions are enumerated with their reasons in
// app/tests/overlay-coverage.spec.js, which reds when a shipped module opens
// something that is in none of the three groups.
//
// ORDER IS OUTERMOST FIRST, INNERMOST LAST, and only ONE nesting is real today:
// #activitiesModal opens #skillModal over itself when a card title is pressed
// (surfaces/activities.js). surfaces/diary.js:652-658 records that this shell
// has never had a stack of windows otherwise — the diary CLOSES itself before
// opening the create-profile window, deliberately, because all .modal elements
// share one z-index. So the list is short, its order is checkable by reading
// it, and the nesting it exists for is executed in app/tests/back-button.spec.js.
//
// EACH ROW NAMES THE CONTROL THAT CLOSES IT, and closing means pressing that
// control — not reaching into the surface that owns it. That way the shipped
// close handler runs, whatever else it does (the diary resets its first-entry
// mode, the skill modal walks its own history), and this packet creates no
// second way to close anything.

export const OVERLAYS = Object.freeze([
    // «О приложении» — the greeting, and the only overlay reachable on both
    // channels by a control of its own.
    Object.freeze({ id: 'onboardingModal', closerId: 'onboardingCloseBtn' }),
    // The pre-install window. Web channel only; it is here because this list is
    // about what can be open, not about which channel can open it.
    Object.freeze({ id: 'installModal', closerId: 'installCloseBtn' }),
    Object.freeze({ id: 'exportModal', closerId: 'exportCloseBtn' }),
    // «Отмена», not a cross: this window has no cross of its own in the same
    // sense — #createProfileClose is the cross and #cancelProfile is the button,
    // and both run the same close. The button is named here because it is the
    // one a keyboard reaches.
    Object.freeze({ id: 'createProfileModal', closerId: 'cancelProfile' }),
    Object.freeze({ id: 'storeUnavailableModal', closerId: 'storeUnavailableCloseBtn' }),
    Object.freeze({ id: 'activitiesModal', closerId: 'activitiesModalClose' }),
    // INNERMOST, and the row that carries the packet's owner decision. Since
    // NAV-P3 #skillModalClose is ONE control with two states: with cards behind
    // it, it is «К предыдущей карточке» and steps back through the cards the
    // parent has visited; with none, it is «Закрыть» and closes the window.
    // Pressing it is therefore exactly what the hardware back button owes this
    // window, and this row needs no exception to say so.
    Object.freeze({ id: 'skillModal', closerId: 'skillModalClose' }),
]);

/**
 * Is this overlay in front of the parent right now?
 *
 * ONE RULE FOR ALL SEVEN, AND IT IS THE RENDERED ANSWER RATHER THAN THE
 * MECHANISM. Six of them open by classList.add('show') over a display: none
 * rule; #skillModal opens by an inline style.display. A test that knew both
 * spellings would be a third place that has to be updated when a surface
 * changes how it opens, and it would go quietly wrong rather than loudly when
 * it was not. Asking the computed display asks the question the parent is
 * asking — is this thing on my screen — and cannot drift.
 */
export function isOverlayOpen(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return false;
    return window.getComputedStyle(overlay).display !== 'none';
}

/** True while any declared overlay stands in front of the current surface. */
export function anyOverlayOpen() {
    return OVERLAYS.some((overlay) => isOverlayOpen(overlay.id));
}

/**
 * The innermost open overlay, or null.
 *
 * Reads the declared order backwards: the last row that is open is the one the
 * parent is looking at, which is the one a back press is about.
 */
export function topmostOpenOverlay() {
    for (let at = OVERLAYS.length - 1; at >= 0; at -= 1) {
        if (isOverlayOpen(OVERLAYS[at].id)) return OVERLAYS[at];
    }
    return null;
}
