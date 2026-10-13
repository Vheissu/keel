# Accounts and workspace access

Set `KEEL_PUBLIC_URL` to the browser-facing origin to enable invitation-only email/password accounts. Use HTTPS outside loopback development. The value must have no path or trailing slash, for example `https://keel.example` or `http://127.0.0.1:5173` for Vite. Run migrations before starting the updated API.

Hosted identity rejects legacy bootstrap tokens. Existing projects, releases, actors and audit history remain intact. Provision the first owner from the server, accept the invitation, then create managed tokens for your CLI and automation. Leaving `KEEL_PUBLIC_URL` unset preserves the local bootstrap workflow.

## First owner and additional workspaces

For a checkout installation with `DATABASE_URL` and `KEEL_PUBLIC_URL` in `.env`:

```sh
npm run db:migrate
npm run identity -- invite-owner 00000000-0000-4000-8000-000000000001 owner@example.com
npm run identity -- create-workspace 'Customer platform' owner@example.com
```

The first command targets the local bootstrap workspace. Each command prints an invitation link once. Give it to the named recipient through your usual private channel. Keel does not send invitation emails. Creating a workspace also creates staging and production environments; production requires approval.

For packaged installations, set `publicUrl` in `installation.json` to the browser-facing HTTPS origin, then stop and start the installation. New installations can set it with `init --public-url https://keel.example:8443`. This setting is retained in backups. Use the operations wrapper while PostgreSQL is running:

```sh
npm run self-host -- identity-owner --directory /srv/keel --workspace 00000000-0000-4000-8000-000000000001 --email owner@example.com
npm run self-host -- identity-create --directory /srv/keel --name 'Customer platform' --email owner@example.com
```

An existing account accepts additional invitations after signing in with the invited email. New accounts choose a name and password when accepting. Invitations expire after 48 hours, are single-use and can be revoked. A replacement invitation invalidates the earlier one. Already-active members must have their roles changed through member management.

## Roles

Open **Workspace access** after signing in. All signed-in members can manage their own tokens and change their password. Owners and administrators can list members, manage invitations and revoke workspace tokens.

| Role           | Delivery access                      | Membership access                                        |
| -------------- | ------------------------------------ | -------------------------------------------------------- |
| Owner          | Read, write, approve, manage secrets | Manage all roles and invitations                         |
| Administrator  | Read, write, approve, manage secrets | Manage operators, approvers, secret managers and readers |
| Operator       | Read and write                       | None                                                     |
| Approver       | Read and approve                     | None                                                     |
| Secret manager | Read and manage secrets              | None                                                     |
| Reader         | Read                                 | None                                                     |

A workspace must retain an owner, including during concurrent changes. Membership removal immediately blocks new workspace requests and revokes that member's workspace tokens. The actor remains in audit history and is reused if the person rejoins, so reinvitation cannot bypass the ban on approving your own deployment. Membership in other workspaces is unaffected.

## Managed tokens

Tokens belong to their creator and one workspace. Choose explicit permissions and a lifetime of 1–90 days. `read` is mandatory. Effective permissions are the intersection of the token's original grant and the creator's current role; a role change cannot grant a token permissions it never had.

Copy the token when it is created or rotated. Keel stores only its SHA-256 hash. Rotation atomically revokes the old token and issues a replacement; revocation and expiry block subsequent requests. Administrators can revoke another member's token, but only its creator can rotate it. Tokens cannot manage memberships, invitations or other tokens. Those operations require a browser session.

The API saves metadata, not raw tokens or invitation links, in idempotency responses. A replay returns the original metadata without the secret. If a response is lost, rotate the token or create a replacement invitation.

## Sessions and password recovery

Passwords require 15–128 characters. Keel uses salted scrypt with `N=131072`, `r=8`, `p=1`. Browser sessions use random credentials stored as hashes, expire after one hour without activity or 12 hours after sign-in, and use HttpOnly, SameSite=Lax cookies with Secure and the `__Host-` prefix under HTTPS. Cookies are not readable by application JavaScript. Cookie-authenticated writes require the configured Origin and a session-bound CSRF header. API tokens stay in browser memory when used through the manual token connection form.

Login responses do not distinguish unknown emails from incorrect passwords. An account gets eight attempts per minute across API instances; authentication endpoints also have an IP limit of twelve requests per minute per API instance. Password hashing is bounded to two concurrent operations per process. The API does not trust forwarded client IP headers, so deployments behind a proxy share its IP budget unless the network design provides separate client addresses.

Changing a password requires the current password and revokes all browser sessions and managed tokens across all workspaces. Forgotten-password recovery requires a server operator to issue a one-use link, valid for 15 minutes:

```sh
npm run identity -- reset-password person@example.com
npm run self-host -- identity-reset --directory /srv/keel --email person@example.com
```

The operator must verify the requester's identity before sharing the link. Workspace administrators cannot reset a global account. Recovery also revokes all sessions, managed tokens and outstanding recovery links. A database restore quarantines sessions, managed tokens, invitations and recovery links; users must sign in again and create replacement tokens. Restored password hashes reflect the backup date.

## MFA and active sessions

Open **Account security** to add an authenticator app. Enter your current password, copy the setup key into the app as a time-based account, then confirm its six-digit code. Setup expires in 10 minutes and belongs to the browser session that started it. MFA applies to your account across all workspaces. Membership removal does not remove access to this account screen.

Keel uses TOTP with SHA-1, six digits and 30-second steps, accepting one adjacent step for clock drift. Keep the API host clock synchronized. A successfully used step cannot be used again. Authenticator secrets use AES-256-GCM under `KEEL_CREDENTIAL_KEY`, with a separate MFA encryption context bound to the account. This key must be configured and retained with backups.

After enabling MFA, save the ten recovery codes. Each contains 96 random bits, works once, and is stored only as an account-bound hash. Enter a recovery code in place of an authenticator code when signing in. Replacing recovery codes requires your password and an unused authenticator or recovery code, and invalidates the previous set. If a response is lost before you save the codes, replace them from Account security.

Enabling MFA revokes other browser sessions and all managed API tokens. The setup browser receives a new MFA-verified session cookie; its previous cookie stops working. Disabling MFA requires both your current password and an unused code, then revokes every session and API token. Create replacement API tokens after signing in again. Password changes and password recovery preserve MFA and invalidate pending setup and sign-in challenges.

Password verification alone issues a five-minute challenge for accounts with MFA. It grants no workspace access and allows at most five failed code submissions. A new password sign-in replaces the previous challenge. MFA setup, verification and changes share a database-backed budget of eight attempts per account per minute, in addition to endpoint IP limits. Codes, setup keys and challenge values are excluded from logs and persisted idempotency responses.

The session list shows the current browser, creation, last activity, expiry and reported browser/network details. These details are hints, not verified device identities; the API does not trust forwarded IP headers. Activity is recorded at most once per minute. Sign out an individual session, this session, or every other session. Keel retains at most 25 unrevoked sessions per account, evicting the oldest on new sign-in. Session revocation affects subsequent authorization checks; API tokens have their own lifecycle.

If someone loses both their authenticator and recovery codes, a server operator must verify their identity before using:

```sh
npm run identity -- reset-mfa person@example.com
npm run self-host -- identity-reset-mfa --directory /srv/keel --email person@example.com
```

This clears MFA, revokes all sessions and API tokens, invalidates password-reset links, and records an operator recovery audit event. The person signs in with their password and enrolls a new authenticator. Workspace administrators cannot reset another person's global MFA.

Restore retains and verifies encrypted authenticator secrets, while invalidating pending challenges, setup and recovery codes. Generate new recovery codes after signing in with the authenticator. MFA settings and the last used code step reflect the backup date; use operator recovery if the restored authenticator is no longer available.

SAML, SCIM, email delivery, custom roles and project-scoped tokens remain later work. Workspace creation and account recovery are server operations.

## Passkeys

Open **Account security**, enter your current password, name the device or key, and choose **Add passkey**. Keel supports up to ten passkeys per account. Enrollment requires an active session, including the authenticator step if MFA is enabled. Your browser asks you to approve the passkey with a fingerprint, face recognition or device PIN. Give each passkey a name you can recognize later.

Choose **Sign in with a passkey** on the sign-in screen. Discoverable credentials let the browser select the account without entering an email. Keel requires user presence and device verification on every sign-in. Accounts with MFA still need an authenticator or recovery code afterward. Passkeys do not satisfy a workspace’s SSO requirement or replace its authenticator policy. Password sign-in remains available, subject to the same workspace policies.

Passkeys are bound to the hostname in `KEEL_PUBLIC_URL`; the exact origin is checked on each response. Use HTTPS in production and keep the hostname stable. Device and browser support varies. Use `http://localhost` for development; IP addresses such as `127.0.0.1` cannot be WebAuthn relying parties. Moving to a different hostname requires enrolling new passkeys. Keel stores the public key, signature counter and device metadata; the private key stays with the authenticator or its sync provider. It uses [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server) to verify WebAuthn responses.

Registration and sign-in challenges expire in five minutes and work once. Registration belongs to the browser session that started it and requires a fresh password check. Sign-in uses an HttpOnly, SameSite=Strict cookie to bind the challenge to the requesting browser. Challenge values are hashed in PostgreSQL. Verification checks the origin, relying-party ID, challenge, signature, account handle and device verification. Counters are updated under the account lock. Synced passkeys that report zero counters are supported.

The passkey list shows names, creation dates and last use. Enter your password before removing a passkey. Removal signs out every browser session, revokes managed tokens and cancels pending account challenges. Other passkeys remain usable. If a device is lost, sign in using your password and MFA, then remove its passkey. Server-assisted password recovery removes all passkeys when the recovery link is redeemed; an ordinary password change retains them. Neither operation disables MFA.

A database restore clears passkeys and pending WebAuthn challenges. This avoids restoring a removed credential or rolling its signature counter backward. Sign in using your password and MFA, then enroll passkeys again.

`GET /api/auth/security` includes `passkeys` with `id`, `name`, `created_at`, `last_used_at` and `backed_up`. The JSON POST routes below require the configured Origin. Enrollment, confirmation and removal also require a browser session and CSRF header. These routes do not persist idempotency responses.

| Route                        | Body                               | Result                                                           |
| ---------------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| `/api/auth/passkeys/enroll`  | `{name, current_password}`         | `{attempt, options}` for WebAuthn registration                   |
| `/api/auth/passkeys/confirm` | `{attempt, response}`              | Saves the verified registration                                  |
| `/api/auth/passkeys/options` | `{}`                               | `{options}` for WebAuthn authentication; sets a challenge cookie |
| `/api/auth/passkeys/login`   | `{response}` with challenge cookie | Session cookie, or `{mfa_required: true, challenge}`             |
| `/api/auth/passkeys/remove`  | `{id, current_password}`           | Removes the key and clears the session cookie                    |

## API

`GET /api/auth/session` reports whether hosted identity is enabled, the current user, memberships and a CSRF value. Anonymous requests receive `user: null`. The following JSON POST routes require the configured Origin:

| Route                      | Body                                                                          |
| -------------------------- | ----------------------------------------------------------------------------- |
| `/api/auth/login`          | `{email, password}`                                                           |
| `/api/auth/logout`         | `{}` with session and CSRF                                                    |
| `/api/auth/invitation`     | `{token}`                                                                     |
| `/api/auth/accept`         | `{token, name?, password?}`; existing accounts need matching session and CSRF |
| `/api/auth/password`       | `{current_password, password}` with session and CSRF                          |
| `/api/auth/reset-password` | `{token, password}`                                                           |

Cookie-authenticated `/api/v1` requests select an active membership with `X-Workspace-ID`; unsafe requests also send `X-CSRF-Token`. Bearer tokens carry their workspace scope. A contradictory workspace header is rejected.

Workspace access routes live under `/api/v1/identity`. Writes require an `Idempotency-Key`. `GET /members`, `/invitations` and `/tokens` return `{items, more}` in pages of 50, with an optional nonnegative `offset` up to 100000. These administration lists use offset pagination, so refresh after concurrent changes.

| POST route                | Body                                   |
| ------------------------- | -------------------------------------- |
| `/invitations`            | `{email, role}`                        |
| `/invitations/:id/revoke` | `{}`                                   |
| `/members/:userId`        | `{role}`; `null` removes membership    |
| `/tokens`                 | `{name, permissions, expires_in_days}` |
| `/tokens/:id/rotate`      | `{name, permissions, expires_in_days}` |
| `/tokens/:id/revoke`      | `{}`                                   |

Security references: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) and [CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html).

For MFA accounts, `/api/auth/login` returns `{mfa_required: true, challenge}` without issuing a session. Complete it with `POST /api/auth/mfa/challenge` and `{challenge, code}`. A successful response sets the session cookie.

`GET /api/auth/security` requires a browser session and returns MFA status, remaining recovery-code count and up to 25 active sessions. The following POST routes also require the session, configured Origin and CSRF header. They do not save or replay secret-bearing responses.

| Route                          | Body                       | Result                                                                                         |
| ------------------------------ | -------------------------- | ---------------------------------------------------------------------------------------------- |
| `/api/auth/mfa/enroll`         | `{current_password}`       | One-time `secret` setup key and `uri`                                                          |
| `/api/auth/mfa/cancel`         | `{}`                       | Cancels setup started by this session                                                          |
| `/api/auth/mfa/confirm`        | `{code}`                   | Enables MFA, rotates the session cookie, and returns `recovery_codes` once plus the new `csrf` |
| `/api/auth/mfa/recovery-codes` | `{current_password, code}` | Replaces and returns `recovery_codes` once                                                     |
| `/api/auth/mfa/disable`        | `{current_password, code}` | Disables MFA and clears the session cookie                                                     |
| `/api/auth/sessions/revoke`    | `{id}` or `{others: true}` | Revocation count and `signed_out` flag                                                         |

The authenticator implementation follows [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), with enrollment and recovery controls informed by the [OWASP MFA guidance](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).

## Workspace SSO

Keel supports one OpenID Connect provider per workspace using the authorization-code flow, S256 PKCE and signed RS256 ID tokens. The provider must support `client_secret_post`, the `openid email` scopes, a verified email claim and `auth_time`. Keel checks issuer, audience, expiry, signature, nonce and state. Configure the provider to accept this exact callback URL:

```text
https://keel.example/api/auth/sso/callback
```

A server operator configures the provider from a private JSON file. Copy endpoint URLs from the provider's trusted metadata. These endpoints are trusted server configuration; workspace members cannot supply or change them. HTTPS is required, except loopback HTTP when Keel itself uses a loopback HTTP development origin. Provider requests have a ten-second timeout and do not follow redirects.

```json
{
  "name": "Company sign-in",
  "issuer": "https://identity.example/tenant",
  "authorization_endpoint": "https://identity.example/tenant/authorize",
  "token_endpoint": "https://identity.example/tenant/token",
  "jwks_uri": "https://identity.example/tenant/keys",
  "client_id": "keel",
  "client_secret": "replace-with-the-provider-secret"
}
```

Restrict the file to the operator, then run either:

```sh
npm run identity -- configure-sso WORKSPACE_UUID /private/sso.json
npm run self-host -- identity-sso --directory /srv/keel --workspace WORKSPACE_UUID --config-file /private/sso.json
```

The command stores the configuration encrypted under `KEEL_CREDENTIAL_KEY` with a separate SSO context. It prints the workspace ID and callback URL, without the secret. Replacing the configuration retires the previous subject bindings, pending SSO attempts and SSO sessions, revokes managed workspace tokens, and turns off the required-SSO rule. Members must connect the replacement provider before an owner enables that rule again. Use this procedure for client-secret rotation too.

Accounts remain invitation-only. Accept a workspace invitation and sign in with your password first, including Keel MFA if enabled. In **Account security**, choose **Connect SSO account** for the workspace. The provider's verified email must match your account. The connection binds that provider's subject to your account; an email match alone never creates a connection or signs someone in. Changing a subject requires operator reconfiguration. SSO does not create memberships, synchronize roles or accept invitations automatically.

After connecting, choose **Sign in with SSO**, or enter the workspace ID on the signed-out screen. An SSO session grants access only to that workspace, even if the account belongs to others. Local password sessions can still open Account security when a workspace requires SSO. If Keel MFA is enabled, SSO sign-in also requires a Keel authenticator or recovery code. Provider MFA claims do not replace that check.

SSO attempts expire after ten minutes and are single-use, with a separate HttpOnly browser-binding cookie. PKCE verifiers are encrypted in the database. Callback failures return a fixed error without exposing provider responses. Access and refresh tokens are neither stored nor used. Provider logout and deprovisioning do not end an existing Keel session: remove the workspace membership or revoke the session in Keel when access must stop immediately.

## Workspace authentication policy

An owner can open **Workspace access** to require SSO, require a Keel authenticator, disable managed API tokens, or shorten the maximum browser-session age to 15–720 minutes. The one-hour idle limit still applies. Cookie rotation, MFA enrollment and invitation acceptance preserve the original sign-in time. Every member, including owners, must meet the policy. The owner saving a rule must already meet its new sign-in and MFA requirements; this prevents enabling a rule before testing it. Reads enforce the current policy, and writes recheck it inside the transaction.

Every policy save revokes existing managed tokens for that workspace. When tokens remain allowed, they are an explicit automation exception to SSO and browser-session age limits. A user must meet the workspace's browser policy to issue a new token, and required MFA must remain enabled on the account for the token to work. Disabling tokens blocks issuance and bearer-token access.

Password and MFA recovery do not remove workspace rules. For an inaccessible provider or an owner who cannot satisfy the rules, a server operator can reset the workspace policy after verifying the request:

```sh
npm run identity -- reset-auth-policy WORKSPACE_UUID
npm run self-host -- identity-reset-policy --directory /srv/keel --workspace WORKSPACE_UUID
```

This restores optional SSO/MFA, allows tokens and restores the 12-hour maximum. It does not reinstate revoked sessions or tokens. The reset is audited. Provider configuration, account bindings and policies survive backups; restore verification decrypts provider configuration, and quarantine removes pending SSO attempts and revokes sessions and tokens.

`POST /api/auth/sso/start` takes `{workspace_id, link}` and returns an authorization URL. Linking requires a local browser session and CSRF header; both modes require the configured Origin. `GET /api/auth/sso/callback` consumes the browser-bound attempt. Signed-in members can read policy; only owners can save it at `GET` and `POST /api/v1/identity/auth-policy`, with `{require_sso, require_mfa, allow_api_tokens, session_minutes}` as the write body.

Protocol validation uses [openid-client's authorization-code grant checks](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md) and explicit ID-token signature verification.
