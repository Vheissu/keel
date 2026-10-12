import Aurelia from 'aurelia';
import { MyApp } from './my-app';
import { BoatMark } from './boat-mark';
import { NavIcon } from './nav-icon';
import { TargetsPanel } from './targets-panel';
import { IntegrationsPanel } from './integrations-panel';
import { EnvironmentPolicies } from './environment-policies';
import { RollbackPlanner } from './rollback-planner';
import { SVGAnalyzer } from '@aurelia/runtime-html';
import './styles.css';

Aurelia.register(
  BoatMark,
  NavIcon,
  IntegrationsPanel,
  TargetsPanel,
  EnvironmentPolicies,
  RollbackPlanner,
  SVGAnalyzer,
)
  .app(MyApp)
  .start();
