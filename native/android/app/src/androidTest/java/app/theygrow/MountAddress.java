package app.theygrow;

import androidx.test.platform.app.InstrumentationRegistry;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The versioned module mount the SHIPPED SHELL references, read out of the APK.
 *
 * <p>WHY THIS EXISTS (EMV-DL-005). A mount bump is copy-forward: the previous
 * generation stays on disk and stays shipped, so a test still naming the FROZEN
 * generation after the shell has moved on does not 404 — it succeeds, against
 * bytes nobody is running. That is precisely how {@code BridgeSmokeTest} came to
 * poll for 31.4 s in silence while the app it was testing had opened its store
 * in 884 ms, and how {@code StoreEngineTest} came to apply the frozen
 * generation's DDL while passing. A written-down mount version in an
 * instrumented test is therefore not a shortcut, it is a latent
 * wrong-generation assertion — which is why EMV-P5-INV-001 bans one anywhere
 * under {@code native/} except the generation the shell runs, this file's own
 * prose included.
 *
 * <p>Deliberately a faithful mirror of {@code currentMount()} in {@code
 * app/tests/support/ship-list.js}, including its derivation and its fail-closed
 * posture: the mount is read from the shell's ONE stylesheet {@code <link>} —
 * the first mount asset a browser resolves, and the one reference that cannot be
 * a delivery hint — and the whole document must then agree on a single mount
 * version. No match, or more than one version, throws rather than picking one.
 * Two mirrors of one parser is one too many, but the alternative is a Java test
 * that cannot see the JavaScript source of truth at all.
 *
 * <p>Reads {@code public/index.html} from the APK's assets, which is where
 * {@code cap sync} stages {@code native/www/} — so this reports what the
 * INSTALLED artifact carries, not what the repo happens to hold.
 */
final class MountAddress {

    private static final String SHELL_ASSET = "public/index.html";

    /** Matches the shell's stylesheet link tag, whatever attribute order it uses. */
    private static final Pattern STYLESHEET_LINK =
            Pattern.compile("<link\\b[^>]*\\brel\\s*=\\s*[\"']stylesheet[\"'][^>]*>",
                    Pattern.CASE_INSENSITIVE);

    private static final Pattern MOUNT_HREF =
            Pattern.compile("\\bhref\\s*=\\s*[\"'](/m/(v\\d+)/[^\"']+)[\"']");

    private static final Pattern ANY_MOUNT = Pattern.compile("/m/(v\\d+)/");

    private static String cached;

    private MountAddress() {}

    /** The mount version the shell references, e.g. {@code "v2"}. */
    static synchronized String version() {
        if (cached == null) {
            cached = derive(readShell());
        }
        return cached;
    }

    /** The mount's URL prefix, e.g. {@code "/m/v2/"}. */
    static String prefix() {
        return "/m/" + version() + "/";
    }

    /** The mount's prefix as an ASSET path, e.g. {@code "public/m/v2/"}. */
    static String assetPrefix() {
        return "public/m/" + version() + "/";
    }

    private static String derive(String html) {
        Matcher link = STYLESHEET_LINK.matcher(html);
        if (!link.find()) {
            throw new IllegalStateException(
                    SHELL_ASSET + ": no stylesheet <link> — the mount cannot be derived");
        }
        Matcher href = MOUNT_HREF.matcher(link.group());
        if (!href.find()) {
            throw new IllegalStateException(
                    SHELL_ASSET + ": the stylesheet <link> names no versioned /m/ mount asset");
        }

        // Fails CLOSED on a half-applied bump: a shell whose hints still point at
        // the frozen generation is a shell whose mount is ambiguous, and guessing
        // which half is authoritative is how the frozen generation gets tested.
        Set<String> versions = new LinkedHashSet<>();
        Matcher all = ANY_MOUNT.matcher(html);
        while (all.find()) {
            versions.add(all.group(1));
        }
        if (versions.size() != 1) {
            throw new IllegalStateException(
                    SHELL_ASSET + ": references " + versions.size() + " mount versions " + versions
                            + " — a bump is half-applied, or a hint points at the frozen"
                            + " generation");
        }
        return href.group(2);
    }

    private static String readShell() {
        try (InputStream in =
                InstrumentationRegistry.getInstrumentation()
                        .getTargetContext()
                        .getAssets()
                        .open(SHELL_ASSET)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            return out.toString(StandardCharsets.UTF_8.name());
        } catch (Exception e) {
            throw new IllegalStateException(
                    "the shell is not in the APK at " + SHELL_ASSET + " — cap sync stages the web"
                            + " root into assets/public/",
                    e);
        }
    }
}
