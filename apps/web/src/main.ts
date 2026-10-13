import { AccountSecurity } from './account-security';
import { WorkspaceAccess } from './workspace-access';
import { NotificationsPanel } from './notifications-panel';
import { PageControls } from './page-controls';
import { ResourcePicker } from './resource-picker';
import Aurelia from 'aurelia';
import { MyApp } from './my-app';
import { BoatMark } from './boat-mark';
import { NavIcon } from './nav-icon';
import { TargetsPanel } from './targets-panel';
import { IntegrationsPanel } from './integrations-panel';
import { EnvironmentPolicies } from './environment-policies';
import { RollbackPlanner } from './rollback-planner';
import { SecretsPanel } from './secrets-panel';
import { SVGAnalyzer } from '@aurelia/runtime-html';
import './styles.css';

Aurelia.register(
  AccountSecurity,
  WorkspaceAccess,
  NotificationsPanel,
  PageControls,
  ResourcePicker,
  BoatMark,
  NavIcon,
  IntegrationsPanel,
  TargetsPanel,
  EnvironmentPolicies,
  RollbackPlanner,
  SecretsPanel,
  SVGAnalyzer,
)
  .app(MyApp)
  .start();
