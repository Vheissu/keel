import {
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { bindable } from 'aurelia';
import { Api } from './api';
import { errorMessage, formatDate } from './format';

type Session = {
  id: string;
  current: boolean;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string;
  ip_address: string;
  mfa_verified: boolean;
};

type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };

type Security = {
  passkeys: Passkey[];
  mfa_enabled: boolean;
  recovery_codes_remaining: number;
  sessions: Session[];
};

export class AccountSecurity {
  @bindable api!: Api;
  @bindable signedOut!: () => void;
  data: Security | null = null;
  passkeyName = '';
  passkeyPassword = '';
  passkeysSupported =
    browserSupportsWebAuthn() &&
    !/^[\d.]+$/.test(location.hostname) &&
    !location.hostname.includes(':');
  password = '';
  code = '';
  secret = '';
  recoveryCodes: string[] = [];
  busy = false;
  error = '';
  notice = '';
  private active = false;
  formatDate = formatDate;

  binding() {
    this.active = true;
    void this.run(() => this.load());
  }

  unbinding() {
    this.active = false;
    this.passkeyPassword = '';
    this.password = '';
    this.code = '';
    this.secret = '';
    this.recoveryCodes = [];
  }

  async load() {
    const data = await this.api.auth<Security>('/security');

    if (this.active) {
      this.data = data;
    }
  }

  async run(work: () => Promise<void>) {
    if (this.busy) {
      return;
    }

    this.busy = true;
    this.error = '';
    this.notice = '';

    try {
      await work();
    } catch (error) {
      if (this.active) {
        this.error = errorMessage(error, 'Account request failed.');
      }
    } finally {
      this.busy = false;
      this.passkeyPassword = '';
      this.password = '';
      this.code = '';
    }
  }

  addPasskey() {
    return this.run(async () => {
      const result = await this.api.auth<{
        attempt: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>('/passkeys/enroll', {
        name: this.passkeyName,
        current_password: this.passkeyPassword,
      });

      const response = await startRegistration({ optionsJSON: result.options });

      if (!this.active) {
        return;
      }

      await this.api.auth('/passkeys/confirm', { attempt: result.attempt, response });
      this.passkeyName = '';
      this.notice = 'Passkey added. You can use it the next time you sign in.';
      await this.load();
    });
  }

  removePasskey(id: string) {
    return this.run(async () => {
      await this.api.auth('/passkeys/remove', { id, current_password: this.passkeyPassword });

      if (this.active) {
        this.signedOut();
      }
    });
  }

  cancelSetup() {
    return this.run(async () => {
      await this.api.auth('/mfa/cancel', {});

      if (this.active) {
        this.secret = '';
        this.code = '';
      }
    });
  }

  enroll() {
    return this.run(async () => {
      const result = await this.api.auth<{ secret: string }>('/mfa/enroll', {
        current_password: this.password,
      });

      if (this.active) {
        this.secret = result.secret;
      }
    });
  }

  confirm() {
    return this.run(async () => {
      const previousCsrf = this.api.csrf;

      const result = await this.api.auth<{ recovery_codes: string[]; csrf: string }>(
        '/mfa/confirm',
        {
          code: this.code,
        },
      );

      if (this.api.csrf === previousCsrf) {
        this.api.csrf = result.csrf;
      }

      if (this.active) {
        this.secret = '';
        this.recoveryCodes = result.recovery_codes;
        this.notice = 'MFA enabled. Other sessions and API tokens have been revoked.';
        await this.load();
      }
    });
  }

  changeFactor(action: 'disable' | 'recovery-codes') {
    return this.run(async () => {
      const result = await this.api.auth<{ recovery_codes?: string[] }>(`/mfa/${action}`, {
        current_password: this.password,
        code: this.code,
      });

      if (!this.active) {
        return;
      }

      if (action === 'disable') {
        this.signedOut();
      } else {
        this.recoveryCodes = result.recovery_codes || [];
        this.notice = 'Recovery codes replaced. The previous codes no longer work.';
        await this.load();
      }
    });
  }

  revoke(id?: string) {
    return this.run(async () => {
      const result = await this.api.auth<{ signed_out: boolean; revoked: number }>(
        '/sessions/revoke',
        id ? { id } : { others: true },
      );

      if (!this.active) {
        return;
      }

      if (result.signed_out) {
        this.signedOut();
      } else {
        this.notice = `${result.revoked} session(s) signed out.`;
        await this.load();
      }
    });
  }
}
