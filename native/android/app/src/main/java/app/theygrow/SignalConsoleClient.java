package app.theygrow;

import android.util.Log;
import android.webkit.ConsoleMessage;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * The one console line this app puts in the device log, and nothing else
 * (DIA-P5).
 *
 * <p>WHY IT EXISTS. `native/capacitor.config.json` sets `loggingBehavior` to
 * `none`, which switches off `com.getcapacitor.Logger` in every build. That is
 * what closes the leak this packet is about: with the gate shut, the bridge
 * stops writing each plugin call's whole argument object to logcat
 * (`Bridge.java:826-837`), and the injected JavaScript stops printing each
 * plugin RESULT to the console (`native-bridge.js:943` tests the same flag,
 * injected by `JSExport.getGlobalJS`). Between them those two carried every
 * family value this app holds — a child's name and birthdate, diary text, the
 * expression built from what a parent typed into the search box, and the
 * store's SQLCipher passphrase.
 *
 * <p>BUT THE SAME GATE CARRIED THE DIAGNOSTIC CHANNEL, and that was measured
 * rather than assumed. `BridgeWebChromeClient.onConsoleMessage` routes every
 * console line through that same `Logger`, so shutting the gate takes the
 * `[signal]` channel with it: on run 32044006357 all 41 `[signal]` lines carry
 * tag `Capacitor/Console`, and the dump holds zero `chromium: [INFO:CONSOLE`
 * lines — a console message consumed by a client that returns `true` produces no
 * second, Logger-independent copy on that WebView build. Nothing else was
 * logging them. `docs/RUNBOOK.md`'s own §4 verification steps read those lines,
 * so the channel is carried here instead, past the gate, on its own tag.
 *
 * <p>THE ALLOWLIST IS THE POINT, AND IT IS STRICTER THAN THE GATE IT REPLACES.
 * Only a message that BEGINS with the signal prefix is forwarded. A `[signal]`
 * line is structurally incapable of carrying family text: `core/signals.js`
 * accepts numbers, booleans, null and declared codes and has no path that takes
 * a free string, and `app/tests/signal-payload.spec.js` asserts that shape on
 * every push. Everything else is dropped — including this app's own
 * `console.error` sites, which pass an engine message through (`store/boot.js`,
 * `surfaces/diary.js`, `surfaces/import.js`), and including anything a future
 * packet adds without thinking about logcat. The channel fails CLOSED: a line
 * has to be a signal to be written, rather than merely not known to be unsafe.
 *
 * <p>WHY IT EMITS IN EVERY BUILD RATHER THAN ONLY IN A DEBUGGABLE ONE. Contract
 * §4.7 scopes the signal channel by PAYLOAD SAFETY, not by build type — a
 * channel carrying only counts, timings, booleans and declared codes is §4-safe
 * wherever it runs. Gating on `FLAG_DEBUGGABLE` would put the release build's
 * behaviour behind a branch no test executes, and would leave the owner's §4
 * verification step unavailable on the artefact the family actually installs
 * (ADR-047). Resolved in plan review, 2026-08-17.
 *
 * <p>WHY IT EXTENDS `BridgeWebChromeClient` RATHER THAN `WebChromeClient`. This
 * class overrides ONE method. Everything else a Capacitor app needs from its
 * chrome client — the file chooser, media capture, the geolocation prompt,
 * `onPermissionRequest`, the JS dialogs, fullscreen — is inherited, and runs
 * against the launchers this instance's own super-constructor registered. A
 * plain `WebChromeClient` would silently break every one of them, most visibly
 * the file chooser the import path needs.
 */
public class SignalConsoleClient extends BridgeWebChromeClient {

    /**
     * The tag the owner greps.
     *
     * <p>A first-party `TheyGrow`-prefixed tag, deliberately not Capacitor's: a
     * line under this tag is one this app decided to write, which is a different
     * claim from one the framework happened to emit. The convention was set by
     * `HistoryTransferPlugin`'s `TheyGrowTransfer`, retired at PPR-P2; this is
     * the only such tag the app still writes.
     */
    public static final String TAG = "TheyGrowSignal";

    /**
     * The prefix, with its trailing space, exactly as `core/signals.js` writes
     * it. The space is part of the allowlist: `[signal]x` is not a signal line.
     */
    private static final String SIGNAL_PREFIX = "[signal] ";

    public SignalConsoleClient(Bridge bridge) {
        super(bridge);
    }

    /**
     * Forwards a signal line and swallows everything else.
     *
     * <p>Returns `true` in both cases, which is what keeps the WebView from
     * logging the message itself: on the measured image a console message a
     * client claims is handled produces no `chromium: [INFO:CONSOLE` line. A
     * `false` here would hand every dropped line straight back to logcat and
     * undo the packet.
     *
     * <p>The message is written as-is, with no source file and no line number.
     * Capacitor prefixed those (`File: %s - Line %d - Msg: %s`); they name a
     * module and an offset in it, which is provenance about our code rather than
     * about the family — but they are also noise in a channel whose whole
     * content is one structured line, and the RUNBOOK greps the line.
     */
    @Override
    public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
        if (consoleMessage != null) {
            String message = consoleMessage.message();
            if (message != null && message.startsWith(SIGNAL_PREFIX)) {
                Log.i(TAG, message);
            }
        }
        return true;
    }
}
