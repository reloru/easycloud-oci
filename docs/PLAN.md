# Plan

## Status
- **Updated:** 2026-10-12
- **Done:** Step 1 (repo setup), M1 (Worker skeleton and OCI request signer), M2 (onboarding, verified live) and M3 (discovery, verified live). See Milestones.
- **M4–M7 status:** code done and tested offline. 111 tests pass here (109 offline plus 2 live); `tsc` is clean; the page passes headless smoke tests at phone size; the rendered boot scripts pass `bash -n` and shellcheck. Live runs are still pending: M4–M7 need an **empty** tenancy and a real VM. The empty tenancy will be the first friend's own new account (see Open items → Empty tenancy).
- **Live read-only run (2026-10-11):** `test/live.test.ts` passed against the reference tenancy.
  - Signing works from workerd. Home region `us-ashburn-1`, 3 ADs.
  - Discovery found 2 micros and the 2/12 A1, 200 GB used and 2 of 2 VCNs.
  - The plan says "Nothing to create".
  - Limits are reported per AD (see Platform facts), and the planner's documented-allowance approach is correct as is.
- **Deployed-page run (2026-10-12):** the maintainer connected the reference tenancy through the live page with an app-generated key (fingerprint `e4:ec:1e…`), then ran "Check plan".
  - The first connect returned 422 and its cause was not recorded; the retry about 107 s later returned 200.
  - The plan listed the A1 and both micros, 200 of 200 GB used, and "Nothing — the free servers already exist."
  - Connect outcomes are now logged to Workers Logs as `{event:"connect", ok, kind, status?, opcRequestId?}`, with no preview, OCIDs, fingerprint or account id.
- **Deployed:** https://eazycloud.app (custom domain, attached 2026-10-12; the `workers.dev` address is turned off) (Worker `easycloud` on the maintainer's Cloudflare account). The product is named **EazyCloud**; server, network and VM names now use `eazycloud-*`; the Worker name and repo name stay `easycloud` because renaming the Worker would create a new one without its secret and data.
  - `KEY_ENCRYPTION_KEY` is set. It was generated and piped straight into `wrangler secret put`, so no copy exists anywhere else. Never put it again: a new value makes every stored key unreadable.
  - Merges to `main` that touch `worker/` redeploy through `.github/workflows/deploy.yml`. Tests and typecheck gate the deploy. The workflow uses the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
  - Smoke-tested on 2026-10-11: `/health` responds, the page loads, and `POST /api/accounts` generates and seals a key with the production secret.
- **Home Screen icon (open, 2026-10-12):** iOS Safari showed a blue letter tile ("E") instead of the cloud icon. The server side was verified correct: icon returns 200 `image/png` for every user-agent tried, and the manifest is fine. The touch icon is now inlined as a `data:` URI in `index.html` as an experiment. *(Unverified: whether Safari honors a `data:` touch icon.)* If it still fails on the phone, revert to the file URL and look at iOS-side timing or state.
- **Next action:** build accounts in this order (design: Open items → Accounts):
  1. ~~Auth core~~ (done 2026-10-12): `Auth` Durable Object (`src/auth/store.ts`, one global instance) with users, email codes, sessions and setup ownership; `/auth/email/start`, `/auth/email/verify`, `/auth/me`, `/auth/logout` (`src/auth/routes.ts`); `__Host-eazy` session cookie (SHA-256 stored, 30 days, renewed in the second half); Origin check on POSTs; codes HMAC'd with an HKDF key from `KEY_ENCRYPTION_KEY`, 10-minute expiry, 5 tries, 60 s resend gap, 5 per hour, plus the `AUTH_SEND_LIMIT` rate-limit binding.
  2. ~~Ownership~~ (done 2026-10-12): every `/api/*` route needs a session; non-GET also needs `Origin`; each setup is recorded to its creator in `Auth.setups` and other users get 404. Each user has one Oracle account (see Decisions). The page signs in with an emailed code, opens the user's account directly, and has sign-out. `workers_dev` is off and other hosts get a 308 to `ORIGIN`, so `eazycloud.app` is the only origin. Setups created before this change have no owner and are unreachable.
     - Local dev: `wrangler dev` rewrites the host to the custom-domain route; run it with `--local-upstream localhost:<port> --var ORIGIN:http://localhost:<port>`. The local email binding prints the code in the dev log.
  3. Passkeys (check `@simplewebauthn/server` in workerd first; WebCrypto fallback).
  4. Drop the sealed key at handoff.
  5. Google sign-in, optional and last (the maintainer's Google Cloud sign-up was refused on 2026-10-12).
  2. **First real VM** (needs an empty tenancy: the first friend's account; see Open items). Verify each control-sheet command, the keep-alive P95, and Tailscale exit-node forwarding.
- **Live tests:** these need environment variables in the Claude Code cloud environment (session title bar → environment menu → Edit → environment variables; values are never committed):
  - `OCI_KEY_B64` (base64 of a PKCS#8 PEM)
  - `OCI_USER`
  - `OCI_TENANCY`
  - `OCI_REGION`

  They are set in this environment (2026-10-11), so `npm test` runs the live suite here. CI does not have them, so the suite is skipped there. They load at session start. The key is the maintainer's existing CLI key (fingerprint `1f:32:ab…`), not a dedicated one, so deleting it in the Console also breaks his CLI. Live calls are **read-only** unless the maintainer says otherwise.
- **Blockers:** none.
- **Git:** `main` requires PRs (squash only). See `CLAUDE.md` → Git.

## Goal
A friend with no technical background, working from a phone, ends up with the reference configuration in their own OCI account:
- an A1 server plus two micro servers;
- optional components, each with a control sheet.

The only manual steps are:
1. Oracle signup.
2. One console visit to paste the app-generated public API key.
3. Generating an SSH key in Termius.

The first target is friend scale. A public release is possible later.

## Feasibility (settled)
Yes. Every provisioning step is a documented OCI API call, and the configuration is already proven in production.

What cannot be automated:
- **Oracle signup.** This includes MFA enrollment. The home region is chosen at signup and is **permanent**.
- **Adding the API key**: pasting the app-generated public key into the Console, done once.

## Reference configuration (app defaults)
| Item | Default |
|---|---|
| Home region guidance | Choose before signup. A region with multiple ADs helps A1 retries. |
| A1 | `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, 106 GB boot volume |
| Micros | 2× `VM.Standard.E2.1.Micro`, 47 GB boot volume each |
| Storage | 106 + 47 + 47 = 200 GB, the full Always Free allowance |
| Image | Ubuntu 24.04 Minimal (aarch64 for A1, x86_64 for micros), chosen from the live image list |
| Access | Public IPv4 + SSH (Termius). Tailscale is optional, including exit-node mode (use the VM as a VPN / egress-IP change). |
| Keep-alive (micros) | stress-ng, 2 workers at 35% load, 2 h once daily |
| Keep-alive (A1) | stress-ng, 2 workers at 25% load, 30 min every 6 h |

### Keep-alive math (derived)
- Each job runs 7,200 s per 86,400 s day, which is **8.33%** of samples.
- When more than 5% of samples sit at load *L* and the rest sit below it, P95 ≈ *L*.
- With equal samples per day, the 7-day fraction is the mean of the daily fractions, also 8.33% > 5%. So the 7-day P95 is also about *L*.
- Measured daily P95 in the reference deployment:
  - micros: about 35.6, a margin of +15.6 points over the 20% threshold;
  - A1: about 25.2, a margin of +5.2 points.
- Oracle's sampling and interpolation method is undocumented, so the A1 margin is the one to watch (see Open items).
- The verification query is `CpuUtilization[1d].percentile(0.95)` in namespace `oci_computeagent`.

## Platform facts (sourced)
| Fact | Source |
|---|---|
| Always Free tenancy, A1 shape: 1,500 OCPU-h + 9,000 GB-h per month, which is 2 OCPU / 12 GB (since 2026-06-15) | [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| 2× E2.1.Micro, which can be created in only **one** AD, so rotating ADs does not help micros | same |
| 200 GB total block + boot storage. Minimum boot volume is 47 GB (the doc also says 50 in one place). | same |
| Free-tier tenancies: max 2 VCNs. Always Free compute only in the home region. | same |
| Idle reclamation happens only if CPU P95 < 20% **and** network < 20% **and** memory < 20% (A1 only) over 7 days. | same |
| Home region cannot be changed after signup | [Managing Regions](https://docs.oracle.com/iaas/Content/Identity/regions/managingregions.htm) |
| Request signing: RSA-SHA256 (draft-cavage). `keyId` = `tenancyOCID/userOCID/fingerprint`. GET/DELETE sign `(request-target) host date`. POST/PUT also sign `x-content-sha256`, `content-type`, `content-length`. Clock skew limit 5 min. The page's example `Authorization` headers use a placeholder signature. | [Request Signatures](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm) |
| API key: RSA, PEM, minimum 2048 bits. The Console's "Add API key" dialog has a paste-public-key option. Its config preview gives `user`, `fingerprint`, `tenancy` and `region`, where `region` is the **currently selected Console region, not necessarily the home region**. | [Required Keys and OCIDs](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm) |
| Home region is discoverable via `ListRegionSubscriptions`: pick the entry with `isHomeRegion == true`. | [CLI region-subscription list](https://docs.oracle.com/en-us/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/iam/region-subscription/list.html), [RegionSubscription model](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/identity/models/oci.identity.models.RegionSubscription.html) |
| Boot volume: the image default for these images is 47 GB, and the Always Free docs only mention 47 as the default. A **custom** `bootVolumeSizeInGBs` must be ≥ 50 GB (SDK `InstanceSourceViaImageDetails` docstring; Block Volume "Custom Boot Volume Sizes"). So 47 GB is reached by omitting the size. *Whether the API also accepts an explicit 47 is unverified.* | [Boot volumes](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/bootvolumes.htm) |
| A VCN can have only one internet gateway (disable or enable it via update). | [Internet gateway](https://docs.oracle.com/en-us/iaas/Content/Network/Tasks/managingIGs.htm) |
| `metadata` + `extendedMetadata` ≤ 32,000 bytes. `user_data` and `ssh_authorized_keys` cannot be changed after launch. | [CLI launch reference](https://docs.cloud.oracle.com/iaas/tools/oci-cli/latest/oci_cli_docs/cmdref/compute/instance/launch.html) |
| Ubuntu images: iptables REJECTs all inbound traffic except port 22. Don't use UFW. | [Oracle dev blog](https://blogs.oracle.com/developers/enabling-network-traffic-to-ubuntu-images-in-oracle-cloud-infrastructure), [Compute best practices](https://docs.oracle.com/en-us/iaas/Content/Compute/References/bestpracticescompute.htm) |
| Console MFA is on by default for new tenancies. It applies to Console sign-in only; API-key calls are unaffected. | [Security Policy for OCI Console](https://docs.oracle.com/en-us/iaas/Content/Security/Reference/iam_security_topic-iam_mfa_identity_domains_signon_policy.htm) |
| Limits are **per AD** in an Always-Free-only tenancy. In live reads of the reference tenancy (2026-10-11, Ashburn), `standard-a1-core-count` = 2 and `standard-a1-memory-count` = 12 in **each** of the 3 ADs, and `standard-e2-micro-core-count` = 2 only in AD-2. `resourceAvailability` shows 0 left in AD-2, which holds the A1, but still 2 OCPU / 12 GB in AD-1 and AD-3. So per-AD values are not the tenancy total: summing gives 6 OCPU against the documented 2. The planner takes amounts from the documented allowance and uses limits only to pick eligible ADs. Whether a second A1 launch in another AD would be accepted is untested; do not test it. | Live API; [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) |
| Live image list (Ashburn, 2026-10-11): `24.04 Minimal` and `24.04 Minimal aarch64` are at build 2026.09.18. `26.04 Minimal` and `26.04 Minimal aarch64` exist at build 2026.08.17. | Live API (`ListImages`) |
| Each user can have at most three API signing keys. | [Required Keys and OCIDs](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/apisigningkey.htm) |
| One Free Trial or Always Free account per person; creating or trying to create more is prohibited. Signup's card check also flags "one promotion per person" beyond the email address (Oracle signup code; how it detects this is an inference). | [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) |
| Signup cards: credit cards, or debit cards that work like credit cards. PIN debit, virtual, single-use and prepaid cards are refused. Signup places a US$1 authorization, which is reversed. | [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/), [Payment method](https://docs.oracle.com/en-us/iaas/Content/Billing/Tasks/changingpaymentmethod.htm) |
| A new account starts with a 30-day / US$300 trial (select countries only). Trial limits apply until it ends: A1 16 OCPU / 96 GB per AD (the contract caps the standard promotion at 6 concurrent OCPUs) and 10 VCNs per region. The 2-VCN cap applies only once no trial credits remain. At trial end, A1 usage above 2/12 disables **all** A1 instances, which are deleted after 30 days unless the account is upgraded. | [Service limits](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm), [Free Tier](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm), [Universal Credits service descriptions](https://www.oracle.com/a/ocom/docs/paas-iaas-universal-credits-3940775.pdf) |
| Free Tier and Trial tenancies cannot create child tenancies or join an organization. Upgrading to Pay As You Go cannot be undone. | [Organization planning](https://docs.oracle.com/en-us/iaas/Content/General/organization/organization_planning.htm), [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) |
| OCI TS SDK is Node-only, and no CORS is documented on IaaS endpoints, so all OCI calls go through the Worker | [oci-typescript-sdk](https://github.com/oracle/oci-typescript-sdk) |
| Workers WebCrypto supports RSASSA-PKCS1-v1_5. SQLite Durable Objects with alarms are available. | [Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| iOS Web Push requires a Home Screen web app (iOS 16.4+) | [WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) |

## Decisions
| Area | Decision |
|---|---|
| Backend | TypeScript Cloudflare Worker (Workers Paid plan). Static mobile frontend on the maintainer's domain. |
| OCI calls | The Worker signs each request and calls OCI itself. The browser never calls OCI directly. |
| Access (MVP) | The app generates the API key pair (RSA-2048) and keeps the private key, stored encrypted. The app needs it to act. The user then: (1) copies the public PEM from the app, (2) pastes it in Console → API keys → paste public key, (3) pastes the resulting config preview back. The user never handles a private key file on the phone. |
| Home region | Never trust the preview's `region`. Call `ListRegionSubscriptions` and use the `isHomeRegion` entry for all Always Free work. |
| SSH | The user generates an ED25519 key in their SSH app (Termius on iOS and Android, or any client that can make one) and pastes only the public key. The app never generates, sees, or delivers a private SSH key, so browser and WebCrypto Ed25519 issues do not apply. |
| Discovery first | Before creating anything, read A1 and storage limits, current storage use, existing VCNs, and images per shape. |
| Layout order | Reserve 47 GB per planned micro. Create the A1 first because it is the scarce shape, then the micros. Reuse an existing VCN when present. |
| Network | Create only what is needed: VCN, internet gateway, route table, public subnet, security list (22 inbound). Not the wizard's NAT, service gateway, or private subnet. |
| Image | Ubuntu 24.04 Minimal by default. 26.04 is opt-in only; it needs the sudo-rs vs oracle-cloud-agent sudoers fix. |
| Capacity retry | One Durable Object per deployment, driven by an alarm. Each round tries every AD for A1; micros use their single eligible AD. Adaptive pacing: start fast, back off on 429. Stop on LimitExceeded or NotAuthorized. |
| Status / notify | MVP is a reopenable status page. Web Push comes later. iOS needs the site added to the Home Screen (16.4+). Android Chrome reportedly works in-browser *(unverified)*. |
| VM components | Opt-in toggles through cloud-init. Keep-alive is recommended. Each component ships a control sheet (see `CLAUDE.md` → Product rules). |
| Tailscale | The user supplies an auth key. Exit-node mode is the main reason to enable Tailscale (a requested feature) and works as follows:<br>- **On the VM:** IP forwarding via sysctl (`net.ipv4.ip_forward`, `net.ipv6.conf.all.forwarding`), plus `tailscale set --advertise-exit-node`.<br>- **Approval:** the user approves the exit node in the Tailscale admin console, unless `autoApprovers` covers it.<br>- **Clients:** each client device selects the exit node.<br>- **Control sheet:** adds exit-node on/off. |
| One Oracle account per user | Oracle allows one free account per person and enforces it, so each EazyCloud user has at most one connected Oracle account. After sign-in the page opens it directly (`GET /api/me/account`); `POST /api/accounts` returns the existing one instead of making a second. "Start over with a new key" (`POST /api/accounts/:id/reset`) replaces it, refused while servers are being set up and within a minute of the previous key. |
| Access control | Public eventually, with **user accounts**. Sign-in: passkey (primary), emailed one-time code (backup and recovery), and Google sign-in. No Cloudflare Access email allowlist: it keeps strangers out, which a public app doesn't want. Before opening up, the app also drops its sealed key at handoff and rate-limits account creation. A dedicated domain comes first, because passkeys and Google's redirect URI are bound to the domain and moving later would orphan passkeys (see Open items → Accounts). |
| Frontend | A plain HTML page, `worker/public/index.html`, served by Workers static assets. No framework. The capability ID lives in the URL hash (`#a=…`), so it never appears in request logs. |
| Session identity | Each onboarding gets a random 128-bit capability ID. It names the Durable Object and appears in the status-page URL, which the user bookmarks. There are no accounts or logins at friend scale. |

## Milestones
- [x] **Step 1:** Repo setup: `CLAUDE.md`, this plan, auto-approve hook.
- [x] **M1:** Worker skeleton and OCI request signer (`worker/src/oci/signer.ts`, `worker/src/oci/url.ts`).
  - 21 tests pass in workerd:
    - Oracle's GET signing string matches exactly.
    - 8 SDK reference cases match byte-for-byte: GET, HEAD, DELETE, POST, PUT, PATCH, an empty body, and a UTF-8 body.
    - Every printable ASCII character survives URL encoding round-trips.
  - `tsc` is clean.
  - The local workerd runtime sends the `Date` header unchanged, so there is no need for `x-date`. *Production edge confirmed on 2026-10-12: the deployed connect's signed calls to Oracle succeeded.*
  - Fixtures regenerate with `worker/scripts/gen-signer-fixtures.py` (command in its header).
  - An adversarial review (2 agents: spec conformance, and differential tests against the SDK with wire capture) found three issues. All are fixed:
    - The Limits host must be `limits.{region}.oci.oraclecloud.com`; the old host returns NXDOMAIN. Endpoints now follow the SDK's per-service templates.
    - A bare `?` or a fragment was signed without being sent. The signer now normalises the URL and returns `SignedRequest.url`, and the client sends exactly that.
    - `ociUrl` now rejects empty, `.` and `..` path segments, which WHATWG URL parsing would otherwise collapse.
  - The review also captured on the wire, in local workerd, that `Date`, `Host`, `Content-Length` (including 0), and the UTF-8 body length all go out exactly as signed.
- [x] **M2:** Onboarding. *Verified live on 2026-10-12 through the deployed page with an app-generated key against the reference tenancy. The first connect returned 422 with an unrecorded cause; the retry succeeded.*
  - The app generates the API key pair and shows the public PEM.
  - The user pastes it in the Console and pastes the config preview back.
  - The app stores the key encrypted, resolves the home region via `ListRegionSubscriptions`, then validates with a read-only call.
  - *Done when* the flow succeeds against a real tenancy. The maintainer can test by adding a second API key to his own user, so no private key ever has to be shared.
  - Built so far:
    - `src/oci/keys.ts`: RSA-2048 generation and the MD5 fingerprint, which matches the Python reference.
    - `src/oci/config-preview.ts`: preview parser.
    - `src/crypto/envelope.ts`: AES-256-GCM, with the account ID as associated data.
    - `src/oci/client.ts`: OCI client plus `OciError`, which keeps the `opc-request-id`.
    - `src/oci/identity.ts`: region subscriptions and ADs.
    - `src/onboarding.ts`: logic, with plain-language error kinds.
    - `src/account.ts`: the Durable Object.
    - `src/index.ts`: routes.
    - `public/index.html`: page.
  - Routes:
    - `POST /api/accounts`
    - `GET /api/accounts/:id`
    - `POST /api/accounts/:id/connect` with body `{preview}`
- [x] **M3:** Discovery: limits, storage use, VCNs, images per shape. *Verified live on 2026-10-11: the dry-run against the reference tenancy found its 3 servers, 200 GB and 2 VCNs, and planned nothing to create.*
  - *Done when* a dry-run against the reference tenancy prints a correct layout plan.
  - Built so far:
    - `src/oci/discovery.ts`: compartment subtree, instances, boot and block volumes (excluding TERMINATED), VCNs, public subnets routed to an enabled IGW, limit values, and the newest 24.04 Minimal image per shape.
    - `src/plan.ts`: the pure planner. A1 first; 47 GB reserved per micro; network reuse, create or blocked; plain-language blockers and notes.
    - `src/planning.ts`: glue code.
    - `GET /api/accounts/:id/plan`.
    - The page's "Check what EasyCloud will set up" view.
  - The planner uses the documented allowance (`ALWAYS_FREE`) until the live limit values are confirmed.
- [ ] **M4:** Network: create or reuse. *Code done; live run pending (needs an empty tenancy).*
  - *Done when* it is idempotent, so re-running creates nothing new.
  - Built so far: `src/oci/network.ts` → `ensureNetwork`. Each step looks before it creates:
    - VCN `easycloud-vcn`, 10.0.0.0/16, tagged `easycloud=managed`.
    - An enabled internet gateway.
    - The default route table, with 0.0.0.0/0 pointing at the gateway.
    - The default security list, with SSH (TCP 22) open.
    - A regional public subnet, 10.0.0.0/24.
  - It polls each resource until AVAILABLE and sends a per-run `opc-retry-token` on creates.
  - Tests use a stateful fake OCI. They cover a full build, a second run with zero writes, repair of a half-built network, retry tokens, and the poll timeout.
- [ ] **M5:** Launch, the Durable Object retry loop, and the status page. *Code done; live run pending (needs an empty tenancy).*
  - *Done when* capacity, limit, and rate errors are each handled distinctly and the loop survives Worker restarts.
  - Built so far:
    - `src/deploy.ts`: a state machine driven by the Durable Object alarm (`network` → `servers` → `done`/`failed`/`cancelled`).
    - Per alarm, each pending server gets one action:
      - **Launch:** rotates through its candidate ADs and sends a per-attempt `opc-retry-token`.
      - **Adopt:** if an instance named `easycloud-*` already exists (a lost response), it is adopted instead of relaunched.
      - **Poll:** waits for RUNNING, then reads the public IP from VNIC attachments.
      - **Relaunch:** if Oracle terminates an accepted launch, the server is launched again.
    - Error handling:
      - "Out of host capacity" (500 `InternalError`): retry every 60 s on the next AD.
      - 429: exponential backoff from 60 s up to 15 min.
      - 5xx and 409 `IncorrectState`: retry with backoff.
      - `LimitExceeded`/`QuotaExceeded`/401/404: that server fails; the others continue.
      - Unexpected exceptions in the alarm also back off, so the loop never dies.
    - Routes:
      - `POST /api/accounts/:id/deploy` with body `{sshPublicKey}`
      - `GET /api/accounts/:id/deployment`
      - `POST /api/accounts/:id/cancel`
    - The page has an SSH key form and a progress view that polls every 15 s.
  - A second adversarial review (state machine; OCI API conformance) found 9 issues. All are fixed and each has a test:
    - **Boot volume size:** micros now launch with no custom size (image default 47 GB); explicit sizes must be ≥ 50 GB. A 47–49 GB A1 remainder falls back to the default.
    - **Alarm vs cancel/new deploy:** the alarm re-reads storage before writing and skips when the `runId` changed or the run was cancelled. A Durable Object race test covers this.
    - **Adoption:** only instances carrying this run's `easycloud-run` tag are adopted. New server names skip names live instances already use.
    - **Stuck polling:** STOPPED/STOPPING fails the server; provisioning times out after 30 min.
    - **Pacing:** each server has its own next-attempt time, so capacity retries stay at 60 s regardless of other servers.
    - **AD-specific subnets:** reused only when every planned server can launch in that AD, with candidates pinned to it. Otherwise create a network or report a blocker.
    - **Public IP:** a server isn't marked running until its public IP appears (up to 20 polls), else it finishes with an explicit message.
    - **Disabled IGW:** re-enabled instead of creating a second gateway.
- [ ] **M6:** cloud-init components with control sheets, keep-alive first. *Code done; real-VM verification pending.*
  - *Done when* every control-sheet command has been verified on a real VM, including uninstall.
  - Built so far: `src/vm/components.ts`. One definition produces both the first-boot bash script and the per-component control sheets.
  - **Keep-alive:** a systemd timer plus a oneshot service running `stress-ng --cpu 0 --cpu-load LOAD` under `timeout`. Settings live in `/etc/easycloud/keepalive.env`. There is deliberately no `Nice=`, because nice time may not count toward OCI's `CpuUtilization`.
  - **Docker:** the `docker.io` package.
  - **cloudflared:** Cloudflare's apt repo, then `service install <token>`.
  - **Tailscale:** the official `install.sh`, then `up --auth-key --hostname`. Exit node optional: sysctl forwarding plus `--advertise-exit-node`.
  - **Isolation:** each component runs in its own function. Its result goes to `/etc/easycloud/status`, and the log is `/var/log/easycloud-setup.log`.
  - **Packages:** `/etc/easycloud/installed-packages` lists what the app installed. Uninstall commands check that list first, so they never remove packages that were already there.
  - **Control sheet on the VM:** written to `/etc/easycloud/control-sheet.txt` and `~ubuntu/EASYCLOUD.txt`.
  - **Secrets:** tokens and keys are validated by strict format, then single-quoted. They exist only inside the boot script, which is stored sealed per server (AES-GCM, associated data `accountId:serverName`). The stored selection and the sheets are secret-free.
  - **Inspecting the script:** `node worker/scripts/render-cloud-init.mjs [a1|micro] [all|default]` prints the script and runs `bash -n` on it.
- [ ] **M7:** Handoff screen: IP address, Termius connection fields, control sheets. *Code done (`GET /api/accounts/:id/control-sheet` plus the page's "Your servers" view with copy buttons); real-VM check pending.*
- [ ] **M8:** Hardening. Replace the account-wide key with a scoped bot user, delete the admin key, add revoke.

## Open items
- **Secrets in instance metadata:** the tunnel token and Tailscale auth key travel in `user_data`. Anyone with instance-read access in the tenancy can read them, and so can any process on the VM via the metadata service. Suggest one-off Tailscale auth keys. A later improvement could wipe or rotate them after first boot.
- **M5 options (not built):**
  - `CreateComputeCapacityReport` checks capacity before launching; Oracle's Known Issues page points to it.
  - An opt-in A1 fallback to 1 OCPU / 6 GB when 2/12 has no capacity.
  - Push or email notification when servers are ready.
- **Before going public.** The setup link (`#a=<id>`) is the only credential. Whoever holds it acts through the app's admin API key in that tenancy, including deploying with their own SSH key before the owner does. Required before the app is public:
  1. Drop the sealed private key when the deployment ends, and have the user delete the app's API key in the Console. Whether the app can delete its own key with `DeleteApiKey` is an M8 question. After that the link exposes only IPs and the control sheet, and the VM keeps the control sheet, so a lost link costs nothing.
  2. Rate-limit `POST /api/accounts`.
  3. User accounts replace the bare setup link as the credential (see Accounts below).
- **Accounts (decided 2026-10-12).** Passkey + emailed code + Google sign-in.
  - **Infrastructure done 2026-10-12:** `eazycloud.app` bought and attached to the Worker; Email Sending onboarded for it through the API (`POST /zones/{zone}/email/sending/subdomains`, then `preview_enabled=false` so codes are not kept in the dashboard). Cloudflare created the `cf-bounce` MX/SPF/DKIM records and `_dmarc` (p=reject).
  - **Domain first (maintainer):** buy a `.dev` or `.app` domain on Cloudflare Registrar. Live prices on 2026-10-12: $8.20 the first year for both; renewal $12.20 (`.dev`) or $14.20 (`.app`). Available then: `geteasycloud.dev`, `easycloudoci.dev`, `easycloudfree.dev`, `geteasycloud.app`. Registrar fees are non-refundable. The domain becomes the app's address, the passkey relying-party ID, the Google redirect URI host and the email sender.
  - **Email sending:** Cloudflare Email Sending (public beta since 2026-04-16; Workers Paid; the sending domain must use Cloudflare DNS) through a `send_email` binding ([Email Service](https://developers.cloudflare.com/email-service/)).
  - **Google sign-in:** OpenID Connect with `openid email profile`. Google lists no price for Sign in with Google ([SIWG](https://developers.google.com/identity/siwg)), and verification is not mandatory for non-sensitive scopes; showing the app name and logo needs brand verification ([OAuth app verification](https://support.google.com/cloud/answer/13463073)). The maintainer creates the OAuth client in Google Cloud Console once the domain exists.
  - **Passkeys:** `@simplewebauthn/server` v14 documents Node and Deno, not Workers. *Workers compatibility unverified*; the fallback is WebCrypto verification of ES256/RS256 assertions.
- **Custom domain (optional):** attach one to the `easycloud` Worker. The `workers.dev` URL works meanwhile.
- **Home-region fallback:** if `ListRegionSubscriptions` ever fails from a non-home region, fall back to `GetTenancy.homeRegionKey` and map the key to a name with `ListRegions`. *Not needed so far.*
- **M8 research (deferred until M8):**
  - Does the Identity Domains SCIM API accept OCI request signatures?
  - Does self-`DeleteApiKey` work?
  - Is cross-tenancy Endorse/Admit possible between Always Free tenancies? *Unresearched.*
- **M5:** Find the exact LaunchInstance error codes and statuses that distinguish capacity, limit, and rate failures.
- **M5:** Tune retry pacing. Community scripts report 429s below ~30 s intervals. *Community-sourced.*
- **M6:** A1 keep-alive margin is +5 points. Consider a 30% default load.
- **M6:** Decide tunnel ownership: the user's own Cloudflare account, or the maintainer's account and domain.
- **M6:** Decide the implementation for pausable components (systemd timer vs cron). Control-sheet semantics drive the choice.
- **M6 (Tailscale exit node):** OCI Ubuntu images also end the iptables `FORWARD` chain with a `REJECT` rule. Exit-node forwarding works only if Tailscale's own netfilter rules precede it. *Unverified; test on a real VM.* Also check Always Free outbound data-transfer allowance, which exit-node traffic consumes. *Unverified.*
- **Empty tenancy (for M4–M7):** the pilot is the first friend's own new account, signed up with their own details and card. Oracle's Cloud Services Agreement lets the account holder authorize other users and keeps the holder responsible for them ([CSA](https://www.oracle.com/contracts/docs/cloud_csa_online_v062223_us_eng.pdf)). Give the maintainer his own IAM user rather than sharing the friend's login. No Oracle text covers this exact case.
  - During the 30-day trial, trial limits apply. The app still caps at the Always Free allowance (`ALWAYS_FREE` in `src/plan.ts`).
  - The 2-VCN path can be exercised only after day 30.
  - Capacity retry gets exercised only if Oracle is short at the time. Oracle offers no way to simulate it; offline, the fake OCI covers it.
  - Pick a home region with 3 ADs (Ashburn, Chicago, Phoenix, London, Frankfurt) so A1 retries have more ADs to try.
  - Decline any "special offer" at signup: some special trials are suspended at trial end instead of continuing as Always Free. An account idle for 30 days may be suspended. ([Free Tier FAQ](https://www.oracle.com/cloud/free/faq/))
  - Rejected alternatives (all verified against Oracle docs, 2026-10-11):
    - A second account for the maintainer: prohibited (one per person).
    - Compartments: quotas only restrict, and service limits are tenancy-wide ([quota syntax](https://docs.oracle.com/en-us/iaas/Content/Quotas/Concepts/quota_policy_syntax.htm), [API errors](https://docs.oracle.com/en-us/iaas/Content/API/References/apierrors.htm)).
    - Child tenancy: not available on Free Tier or Trial ([child tenancy management](https://docs.oracle.com/en-us/iaas/Content/General/organization/child-tenancy-management.htm)).
    - Pay As You Go: irreversible, and the default micro limit stays 2 ([service limits](https://docs.oracle.com/en-us/iaas/Content/General/Concepts/servicelimits.htm)). It also would not help as the code stands: the planner uses the fixed Always Free caps, so the full reference tenancy still plans nothing to create.
    - Back up, delete, test and restore the reference servers: supported (5 free volume backups; boot volumes can be backed up while running and restored), but takes them offline ([boot volume backups](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/bootvolumebackups.htm)).
- **Planner gap (low priority):** the A1 free allowance is shared with `BM.Standard.A1` and `CI.Standard.A1.Flex` container instances ([price list](https://www.oracle.com/cloud/price-list/)), but the planner counts only `VM.Standard.A1.Flex`. A friend's new tenancy has neither.
- **New API keys take time to work (covered).** A new key starts in `CREATING` and is usable only when `ACTIVE` ([ApiKey model](https://docs.oracle.com/en-us/iaas/tools/python/latest/api/identity/models/oci.identity.models.ApiKey.html)), and IAM changes can take several minutes to reach the home region ([Managing Regions](https://docs.oracle.com/en-us/iaas/Content/Identity/regions/managingregions.htm)). `describeOciError` in `src/onboarding.ts` already maps a 401 to "If you just added it, wait a minute and try again". The connect log now records the kind, so the next failure shows whether this was the cause.
- **M6 (Tailscale toggle only):** Direct WireGuard connections may need inbound 41641/udp in both the security list and iptables, inserted above the REJECT rule. Without it, traffic is expected to fall back to relays. *Unverified. Check Tailscale's docs at M6.*

## Tooling notes
- `opc-retry-token` must be unique per run. OCI keeps tokens for 24 h and may answer a reused token with the original resource, even after that resource was deleted. Re-runs stay idempotent through the lookups.
- `@cloudflare/vitest-pool-workers` is deprecated and renamed to `@cloudflare/vitest-plugin`; the plugin is used via `cloudflareTest()` in `vitest.config.ts`.
- `worker/.npmrc` sets `legacy-peer-deps=true`, because npm 10.9 crashes with `Cannot read properties of null (reading 'edgesOut')` while resolving this peer set. All peers are listed explicitly in `package.json`.
- Dependency versions are pinned to releases at least two weeks old at install time. Exception: a release that fixes a security advisory may be taken as soon as it ships.
- `sharp` and `undici` reach the repo only through the dev chain `@cloudflare/vitest-plugin`/`wrangler` → `miniflare`, which pins exact versions. Neither package ships in the deployed Worker. Clear their advisories by bumping vitest-plugin and wrangler to a release whose miniflare pins patched versions, not with npm `overrides` against miniflare's exact pins. As of vitest-plugin 1.4.0 / wrangler 4.149.0 (2026-10-08, taken under the security exception), miniflare 5.20261006.1-alpha pins sharp 0.35.5 and undici 7.29.1, and `npm audit` reports 0 vulnerabilities.
- Example secrets in tests and scripts are assembled at runtime (for example `["tskey", "auth", …].join("-")`), so GitHub secret scanning never sees a full match.

- Do not name a Durable Object RPC method `connect`. Stubs reserve it for the socket API (`Fetcher.connect`).

## Sources
All sources are linked inline in **Platform facts** above.
