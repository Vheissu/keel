import { bindable } from 'aurelia';
import type { Principal, Permission } from '../../../packages/domain/src/index';
import { Api } from './api';
import { errorMessage, formatDate } from './format';

type Member = { id: string; name: string; email: string; role: string };

type Invitation = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
};

type Token = {
  id: string;
  user_id: string;
  name: string;
  email: string;
  permissions: Permission[];
  project_ids: string[] | null;
  expires_at: string;
  revoked_at: string | null;
};

type WorkspaceRole = {
  id: string;
  name: string;
  permissions: Permission[];
  builtin: boolean;
  revision?: number;
};

type Listing<T> = { items: T[]; more: boolean };

export class WorkspaceAccess {
  @bindable api!: Api;
  @bindable principal!: Principal;
  @bindable signedOut!: () => void;
  members: Listing<Member> = { items: [], more: false };
  invitations: Listing<Invitation> = { items: [], more: false };
  tokens: Listing<Token> = { items: [], more: false };
  memberOffset = 0;
  invitationOffset = 0;
  tokenOffset = 0;
  email = '';
  role = 'reader';
  name = '';
  days = 30;
  permissions: Permission[] = ['read'];
  workspaceRoles: WorkspaceRole[] = [];
  roleName = '';
  rolePermissions: Permission[] = ['read'];
  editingRole: WorkspaceRole | null = null;
  allPermissions: Permission[] = ['read', 'write', 'approve', 'manage_secrets'];
  tokenScope = 'workspace';
  selectedProject = '';
  selectedProjectName = '';
  tokenProjects: { id: string; name: string }[] = [];
  currentPassword = '';
  password = '';
  revealed = '';
  revealedLabel = '';
  error = '';
  notice = '';
  busy = false;
  policyLoaded = false;
  authPolicy = {
    require_sso: false,
    require_mfa: false,
    allow_api_tokens: true,
    session_minutes: 720,
  };
  private active = false;
  private revision = 0;

  get admin() {
    return ['owner', 'admin'].includes(this.principal.role || '');
  }

  get roles() {
    return this.workspaceRoles.filter(
      (role) => this.principal.role === 'owner' || !['owner', 'admin'].includes(role.id),
    );
  }

  binding() {
    this.active = true;

    if (this.principal.session_id) {
      void this.load();
    }
  }

  unbinding() {
    this.active = false;
    this.revision++;
    this.revealed = '';
    this.password = '';
    this.currentPassword = '';
  }

  formatDate = formatDate;

  tokenActive(token: Token) {
    return !token.revoked_at && Date.parse(token.expires_at) > Date.now();
  }

  editable(member: Member) {
    return this.principal.role === 'owner' || !['owner', 'admin'].includes(member.role);
  }

  async load() {
    this.policyLoaded = false;
    const revision = ++this.revision;

    try {
      const [tokens, members, invitations, policy, roles] = await Promise.all([
        this.api.request<Listing<Token>>(`/identity/tokens?offset=${this.tokenOffset}`),
        this.admin
          ? this.api.request<Listing<Member>>(`/identity/members?offset=${this.memberOffset}`)
          : Promise.resolve(this.members),
        this.admin
          ? this.api.request<Listing<Invitation>>(
              `/identity/invitations?offset=${this.invitationOffset}`,
            )
          : Promise.resolve(this.invitations),
        this.api.request<typeof this.authPolicy>('/identity/auth-policy'),
        this.api.request<{ items: WorkspaceRole[] }>('/identity/roles'),
      ]);

      if (this.active && revision === this.revision) {
        this.workspaceRoles = roles.items;
        this.tokens = tokens;
        this.members = members;
        this.invitations = invitations;
        this.authPolicy = policy;
        this.policyLoaded = true;
      }
    } catch (error) {
      if (this.active && revision === this.revision) {
        this.error = errorMessage(error, 'The account request failed.');
      }
    }
  }

  async run(work: () => Promise<void>) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';
    this.notice = '';
    this.revealed = '';

    try {
      await work();

      if (this.active) {
        await this.load();
      }
    } catch (error) {
      if (this.active) {
        this.error = errorMessage(error, 'The account request failed.');
      }
    } finally {
      this.busy = false;
    }
  }

  roleLabel(id: string) {
    return this.workspaceRoles.find((role) => role.id === id)?.name || id;
  }

  get customRoles() {
    return this.workspaceRoles.filter((role) => !role.builtin);
  }

  editRole(role: WorkspaceRole) {
    this.editingRole = role;
    this.roleName = role.name;
    this.rolePermissions = [...role.permissions];
  }

  clearRole() {
    this.editingRole = null;
    this.roleName = '';
    this.rolePermissions = ['read'];
  }

  saveRole() {
    return this.run(async () => {
      const role = this.editingRole;

      await this.api.request(
        role ? `/identity/roles/${role.id}/update` : '/identity/roles',
        'POST',
        {
          name: this.roleName,
          permissions: this.rolePermissions,
          ...(role ? { expected_revision: role.revision } : {}),
        },
      );

      this.clearRole();

      this.notice = role
        ? 'Role updated. Its permissions apply to existing sessions and tokens.'
        : 'Custom role created.';
    });
  }

  archiveRole(role: WorkspaceRole) {
    return this.run(async () => {
      await this.api.request(`/identity/roles/${role.id}/archive`, 'POST', {
        expected_revision: role.revision,
      });

      this.clearRole();
      this.notice = 'Custom role archived.';
    });
  }

  projectChanged = (project?: { id: string; name?: string }) => {
    this.selectedProjectName = project?.name || '';
  };

  addProject() {
    if (
      this.selectedProject &&
      !this.tokenProjects.some((project) => project.id === this.selectedProject)
    ) {
      this.tokenProjects = [
        ...this.tokenProjects,
        { id: this.selectedProject, name: this.selectedProjectName || this.selectedProject },
      ];
    }
  }

  removeProject(id: string) {
    this.tokenProjects = this.tokenProjects.filter((project) => project.id !== id);
  }

  saveAuthPolicy() {
    return this.run(async () => {
      await this.api.request('/identity/auth-policy', 'POST', {
        require_sso: this.authPolicy.require_sso,
        require_mfa: this.authPolicy.require_mfa,
        allow_api_tokens: this.authPolicy.allow_api_tokens,
        session_minutes: Number(this.authPolicy.session_minutes),
      });

      this.notice = 'Authentication policy saved. Existing workspace API tokens were revoked.';
    });
  }

  invite() {
    return this.run(async () => {
      const result = await this.api.request<{ link?: string }>('/identity/invitations', 'POST', {
        email: this.email,
        role: this.role,
      });

      if (!this.active) {
        return;
      }

      this.revealed = result.link || '';
      this.revealedLabel = 'Invitation link';

      this.notice = result.link
        ? 'Copy this link and send it to the invited person. It expires in 48 hours.'
        : 'This invitation was already created. Its link is shown only once; create a replacement if needed.';

      this.email = '';
      this.invitationOffset = 0;
    });
  }

  saveMember(member: Member, remove = false) {
    return this.run(async () => {
      await this.api.request(`/identity/members/${member.id}`, 'POST', {
        role: remove ? null : member.role,
      });

      if (member.id === this.principal.user_id) {
        this.signedOut();

        return;
      }

      this.notice = remove ? 'Member removed and their workspace tokens revoked.' : 'Role updated.';
    });
  }

  revokeInvitation(id: string) {
    return this.run(async () => {
      await this.api.request(`/identity/invitations/${id}/revoke`, 'POST', {});
      this.notice = 'Invitation revoked.';
    });
  }

  issue(rotate?: Token) {
    return this.run(async () => {
      const selectedProjects =
        this.tokenScope === 'workspace' ? null : this.tokenProjects.map((project) => project.id);

      const result = await this.api.request<{ token?: string }>(
        rotate ? `/identity/tokens/${rotate.id}/rotate` : '/identity/tokens',
        'POST',
        {
          name: rotate?.name || this.name,
          permissions: rotate
            ? rotate.permissions.filter((permission) =>
                this.principal.permissions.includes(permission),
              )
            : this.permissions,
          expires_in_days: Number(this.days),
          project_ids: rotate ? rotate.project_ids : selectedProjects,
        },
      );

      if (!this.active) {
        return;
      }

      this.revealed = result.token || '';
      this.revealedLabel = 'New API token';

      this.notice = result.token
        ? 'Copy this token now. It will not be shown again.'
        : 'This token was already created. Rotate it to receive a new value.';

      this.name = '';
      this.tokenOffset = 0;
    });
  }

  revokeToken(id: string) {
    return this.run(async () => {
      await this.api.request(`/identity/tokens/${id}/revoke`, 'POST', {});
      this.notice = 'Token revoked.';
    });
  }

  changePassword() {
    return this.run(async () => {
      await this.api.auth('/password', {
        current_password: this.currentPassword,
        password: this.password,
      });

      this.currentPassword = '';
      this.password = '';
      this.signedOut();
    });
  }

  async page(kind: 'member' | 'invitation' | 'token', delta: number) {
    this[`${kind}Offset`] = Math.max(0, this[`${kind}Offset`] + delta * 50);
    await this.load();
  }
}
