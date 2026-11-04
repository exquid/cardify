// Usage: node --experimental-transform-types --import ./docs/qa/browser/register.mjs <script>.mts
import { register } from 'node:module';

register('./resolve-ts.mjs', import.meta.url);
