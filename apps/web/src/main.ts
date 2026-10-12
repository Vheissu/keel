import Aurelia from 'aurelia';
import { MyApp } from './my-app';
import { BoatMark } from './boat-mark';
import { NavIcon } from './nav-icon';
import { SVGAnalyzer } from '@aurelia/runtime-html';
import './styles.css';

Aurelia.register(BoatMark, NavIcon, SVGAnalyzer).app(MyApp).start();
