# Desktop boot incident and current verification boundary

Date: 2026-10-24

## Recovery

The development `@hail7723/dsh-project-memory` bundle was removed from the desktop profile with the official plugin manager after the second boot failure. Removal returned `application: applied` with no warnings. No project SQLite database was removed or modified by recovery.

> **Postscript (later on 2026-10-24).** The package was unified as `dsh-longtime-memory`. The defects below were fixed in the verified `0.2.2` build, which passed real Client/Host Gateway tests and a full isolated browser flow. The withdrawn `0.2.0` and `0.2.1` archives remain unsafe; do not install them.

Do not install the existing local `0.2.0` or `0.2.1` archives. They are failed development builds, not validated releases. The current repair uses version `0.2.2-dev.0` to distinguish it from those archives.

## Proven defects

- `0.2.0`: the static Client declared `remote.projectMemory` as an injection dependency without mounting a Client Remote contribution. Web boot remained pending.
- `0.2.1`: the Client mounted descriptors using `src-json` input codecs. The real Harness Client gateway requires strict input codecs (`requireStrictInputs` / `requireStrictCodec` in `dsh-api-gateway`). The Client entry therefore failed during boot.
- The original fake `$mount` unit test accepted invalid codecs and did not exercise the actual Harness gateway.
- A running Web server, HTTP 200, and presence in `__DSH_BOOT__` establish Host/artifact delivery only. They DO NOT verify browser entry activation or rendered UI.

## Repair in the checkout

- Client descriptors use strict JSON object codecs.
- The UI API strips absent optional properties before validating the request.
- Mount exceptions are contained and reported inside the memory panel; they do not reject the plugin's `apply` lifecycle.
- Agent tools delegate to the same operations layer used by the visual service.
- Candidate projections use the store's actual `seq` field and selected task identity.

## Required remaining evidence

1. Real Harness Client Remote registry/Gateway mount and namespace creation.
2. Real request argument encoding and Host Gateway invocation, including bootstrap/claim/checkpoint and CAS errors.
3. Complete Client disposal using actual Cordis effects.
4. Browser entry activation and real UI operation in an isolated profile; HTTP alone is insufficient.
5. Complete missing UI scope (task selection/release, user-only candidate confirmation/rejection, locale integration) before advertising the full proposed feature set.

Keep the desktop profile free of this development bundle until browser activation has actually been verified. No automatic desktop reinstallation is authorized by this report.
