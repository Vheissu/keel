import Aurelia from 'aurelia';
import { MyApp } from './my-app';
import { BoatMark } from './boat-mark';
import { NavIcon } from './nav-icon';
import { IntegrationsPanel } from './integrations-panel';
import { SVGAnalyzer } from '@aurelia/runtime-html';
import './styles.css';

Aurelia.register(BoatMark, NavIcon, IntegrationsPanel, SVGAnalyzer).app(MyApp).start();
