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

Passwords require 15–128 characters. Keel uses salted scrypt with `N=131072`, `r=8`, `p=1`. Browser sessions use random credentials stored as hashes, expire after 12 hours, and use HttpOnly, SameSite=Lax cookies with Secure and the `__Host-` prefix under HTTPS. Cookies are not readable by application JavaScript. Cookie-authenticated writes require the configured Origin and a session-bound CSRF header. API tokens stay in browser memory when used through the manual token connection form.

Login responses do not distinguish unknown emails from incorrect passwords. An account gets eight attempts per minute across API instances; authentication endpoints also have an IP limit of twelve requests per minute per API instance. Password hashing is bounded to two concurrent operations per process. The API does not trust forwarded client IP headers, so deployments behind a proxy share its IP budget unless the network design provides separate client addresses.

Changing a password requires the current password and revokes all browser sessions and managed tokens across all workspaces. Forgotten-password recovery requires a server operator to issue a one-use link, valid for 15 minutes:

```sh
npm run identity -- reset-password person@example.com
npm run self-host -- identity-reset --directory /srv/keel --email person@example.com
```

The operator must verify the requester's identity before sharing the link. Workspace administrators cannot reset a global account. Recovery also revokes all sessions, managed tokens and outstanding recovery links. A database restore quarantines sessions, managed tokens, invitations and recovery links; users must sign in again and create replacement tokens. Restored password hashes reflect the backup date.

This stage does not implement SSO, MFA, email delivery, custom roles, project-scoped tokens or a session-management screen. Workspace creation and account recovery are server operations.

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
