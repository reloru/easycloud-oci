# Plan

## Status
- **Updated:** 2026-10-09
- **Done:** Step 1, repo setup:
  - `CLAUDE.md`
  - this plan
  - the auto-approve hook
- **Next action:** M1.
  1. Scaffold `worker/`: TypeScript, wrangler, and vitest with `@cloudflare/vitest-pool-workers`.
  2. Implement the OCI request signer.
  3. Unit-test the signer against Oracle's published signing test vectors (sample keys and expected signatures in the "Request Signatures" doc).
- **Blockers:** none.
- **Git:** `main` requires PRs (squash only). Flow: `claude/*` branch, then PR, then immediate squash-merge (see `CLAUDE.md` → Git).
- **Note:** the auto-approve hook was added mid-session. It is expected to load at the next session start. *Whether it applies mid-session is unverified.*

## Goal
A friend with no technical background, working from a phone, ends up with the reference configuration in their own OCI account:
- an A1 server plus two micro servers;
- optional components, each with a control sheet.

The only manual steps are:
1. Oracle signup.
2. One console visit to create an API key.
3. Generating an SSH key in Termius.

The first target is friend scale. A public release is possible later.

## Feasibility (settled)
Yes. Every provisioning step is a documented OCI API call, and the configuration is already proven in production.

What cannot be automated:
- **Oracle signup.** This includes MFA enrollment. The home region is chosen at signup and is **permanent**.
- **Creating the API key**, done once in the console.

## Reference configuration (app defaults)
| Item | Default |
|---|---|
| Home region guidance | Choose before signup. A region with multiple ADs helps A1 retries. |
| A1 | `VM.Standard.A1.Flex`, 2 OCPU / 12 GB, 106 GB boot volume |
| Micros | 2× `VM.Standard.E2.1.Micro`, 47 GB boot volume each |
| Storage | 106 + 47 + 47 = 200 GB, the full Always Free allowance |
| Image | Ubuntu 24.04 Minimal (aarch64 for A1, x86_64 for micros), chosen from the live image list |
| Access | Public IPv4 + SSH (Termius). Tailscale is optional. |
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
| Request signing: RSA-SHA256 (draft-cavage). POST signs `x-content-sha256`, `content-type`, `content-length`. Clock skew limit 5 min. | [Request Signatures](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm) |
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
| Access (MVP) | The user creates an API key in the console, then pastes the private key and the config preview (tenancy OCID, user OCID, fingerprint, region) into the app. The key is stored encrypted. |
| SSH | Key generated in Termius (ED25519). The user pastes only the public key. |
| Discovery first | Before creating anything, read A1 and storage limits, current storage use, existing VCNs, and images per shape. |
| Layout order | Reserve 47 GB per planned micro. Create the A1 first because it is the scarce shape, then the micros. Reuse an existing VCN when present. |
| Network | Create only what is needed: VCN, internet gateway, route table, public subnet, security list (22 inbound). Not the wizard's NAT, service gateway, or private subnet. |
| Image | Ubuntu 24.04 Minimal by default. 26.04 is opt-in only; it needs the sudo-rs vs oracle-cloud-agent sudoers fix. |
| Capacity retry | One Durable Object per deployment, driven by an alarm. Each round tries every AD for A1; micros use their single eligible AD. Adaptive pacing: start fast, back off on 429. Stop on LimitExceeded or NotAuthorized. |
| Status / notify | MVP is a reopenable status page. Web Push comes later and requires a PWA. |
| VM components | Opt-in toggles through cloud-init. Keep-alive is recommended. Each component ships a control sheet (see `CLAUDE.md` → Product rules). |

## Milestones
- [x] **Step 1:** Repo setup: `CLAUDE.md`, this plan, auto-approve hook.
- [ ] **M1:** Worker skeleton and OCI request signer.
  - *Done when* the unit tests pass against Oracle's signing test vectors.
- [ ] **M2:** Onboarding. Paste the config preview and API key, store the key encrypted, validate with a read-only call (for example, list availability domains).
  - *Done when* a read-only call succeeds against a real tenancy.
- [ ] **M3:** Discovery: limits, storage use, VCNs, images per shape.
  - *Done when* a dry-run against the reference tenancy prints a correct layout plan.
- [ ] **M4:** Network: create or reuse.
  - *Done when* it is idempotent, so re-running creates nothing new.
- [ ] **M5:** Launch, the Durable Object retry loop, and the status page.
  - *Done when* capacity, limit, and rate errors are each handled distinctly and the loop survives Worker restarts.
- [ ] **M6:** cloud-init components with control sheets, keep-alive first.
  - *Done when* every control-sheet command has been verified on a real VM, including uninstall.
- [ ] **M7:** Handoff screen: IP address, Termius connection fields, control sheets.
- [ ] **M8:** Hardening. Replace the account-wide key with a scoped bot user, delete the admin key, add revoke.

## Open items
- **M8 research (deferred until M8):**
  - Does the Identity Domains SCIM API accept OCI request signatures?
  - Does self-`DeleteApiKey` work?
  - Is cross-tenancy Endorse/Admit possible between Always Free tenancies? *Unresearched.*
- **M5:** Find the exact LaunchInstance error codes and statuses that distinguish capacity, limit, and rate failures.
- **M5:** Tune retry pacing. Community scripts report 429s below ~30 s intervals. *Community-sourced.*
- **M6:** A1 keep-alive margin is +5 points. Consider a 30% default load.
- **M6:** Decide tunnel ownership: the user's own Cloudflare account, or the maintainer's account and domain.
- **M6:** Decide the implementation for pausable components (systemd timer vs cron). Control-sheet semantics drive the choice.

## Sources
All sources are linked inline in **Platform facts** above.
