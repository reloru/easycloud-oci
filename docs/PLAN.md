# Plan

## Status
- **Updated:** 2026-10-09
- **Done:** Step 1 (repo setup) and M1 (Worker skeleton and OCI request signer). See Milestones.
- **M2–M7 status:** code done and tested offline. 108 tests pass; `tsc` is clean; the page passes headless smoke tests at phone size; the rendered boot scripts pass `bash -n` and shellcheck. Live runs are still pending: M2/M3 need the env vars or a deploy; M4–M7 need an **empty** tenancy and a real VM.
- **Next action:**
  1. When the `OCI_TEST_*` env vars exist, `npm test` also runs `test/live.test.ts`. It has a GET-only guard and covers:
     - the home region and ADs;
     - full discovery plus a dry-run plan, with both logged.

     Check the logged limit values. They show how the Limits API reports the Always Free A1, micro and storage limits (AD-scoped or regional); adjust `planLayout`'s `Allowance` source if needed. For the reference tenancy, the plan should report "nothing to create".
  2. Deploy (maintainer action; see Open items). Run the onboarding page against the reference tenancy with an app-generated second API key. That closes M2.
  3. First real VM (needs an empty tenancy). Verify each control-sheet command, the keep-alive P95, and Tailscale exit-node forwarding.
- **Live tests:** these need environment variables in the cloud environment settings (values are never committed):
  - `OCI_TEST_KEY_B64` (base64 of a PKCS#8 PEM)
  - `OCI_TEST_USER`
  - `OCI_TEST_TENANCY`
  - `OCI_TEST_REGION`

  They load at session start. The key is a dedicated test key on the maintainer's user. Live calls are **read-only** unless the maintainer says otherwise.
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
  - The local workerd runtime sends the `Date` header unchanged, so there is no need for `x-date`. *Production edge not yet confirmed; that happens at M2.*
  - Fixtures regenerate with `worker/scripts/gen-signer-fixtures.py` (command in its header).
  - An adversarial review (2 agents: spec conformance, and differential tests against the SDK with wire capture) found three issues. All are fixed:
    - The Limits host must be `limits.{region}.oci.oraclecloud.com`; the old host returns NXDOMAIN. Endpoints now follow the SDK's per-service templates.
    - A bare `?` or a fragment was signed without being sent. The signer now normalises the URL and returns `SignedRequest.url`, and the client sends exactly that.
    - `ociUrl` now rejects empty, `.` and `..` path segments, which WHATWG URL parsing would otherwise collapse.
  - The review also captured on the wire, in local workerd, that `Date`, `Host`, `Content-Length` (including 0), and the UTF-8 body length all go out exactly as signed.
- [ ] **M2:** Onboarding. *Code done (see below); live run pending.*
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
- [ ] **M3:** Discovery: limits, storage use, VCNs, images per shape. *Code done; live dry-run pending.*
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
- **Deploy (maintainer action):**
  1. Connect this repo to a Worker with Cloudflare Workers Builds. Use root directory `worker`; deploy command `npx wrangler deploy`.
  2. Set the secret `KEY_ENCRYPTION_KEY` to the output of `openssl rand -base64 32`. Changing it later makes stored keys undecryptable; the envelope has a version byte for future rotation.
  3. Optionally attach a custom domain.
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
- **Testing:** the reference tenancy is full (2/2 VCNs, 200/200 GB), so live tests there are read-only or dry-run. Testing the create path (M4/M5) needs an empty tenancy.
- **M6 (Tailscale toggle only):** Direct WireGuard connections may need inbound 41641/udp in both the security list and iptables, inserted above the REJECT rule. Without it, traffic is expected to fall back to relays. *Unverified. Check Tailscale's docs at M6.* Exit-node setup is out of scope.

## Tooling notes
- `opc-retry-token` must be unique per run. OCI keeps tokens for 24 h and may answer a reused token with the original resource, even after that resource was deleted. Re-runs stay idempotent through the lookups.
- `@cloudflare/vitest-pool-workers` is deprecated and renamed to `@cloudflare/vitest-plugin`; the plugin is used via `cloudflareTest()` in `vitest.config.ts`.
- `worker/.npmrc` sets `legacy-peer-deps=true`, because npm 10.9 crashes with `Cannot read properties of null (reading 'edgesOut')` while resolving this peer set. All peers are listed explicitly in `package.json`.
- Dependency versions are pinned to releases at least two weeks old at install time.

- Do not name a Durable Object RPC method `connect`. Stubs reserve it for the socket API (`Fetcher.connect`).

## Sources
All sources are linked inline in **Platform facts** above.
