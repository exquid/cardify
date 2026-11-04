/* eslint-disable no-console -- command-line QA helpers */
// Shared bits for the Stage 1 browser QA scripts. Playwright is NOT a project dependency:
// the scripts use a globally installed copy (see README.md in this folder).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped global install
export const playwright: any = require('playwright');

export const APP_URL = process.env.CARDIFY_URL ?? 'http://localhost:5173/';
export const SESSION_KEY = 'cardify.session.v1';
export const SETTINGS_KEY = 'cardify.settings.v1';

/** Collects pass/fail lines and sets the exit code. */
export class Checks {
  private readonly failures: string[] = [];
  private passes = 0;

  ok(condition: boolean, label: string): void {
    if (condition) {
      this.passes += 1;
      console.log(`  PASS  ${label}`);
    } else {
      this.failures.push(label);
      console.log(`  FAIL  ${label}`);
    }
  }

  finish(): void {
    console.log(`\n${this.passes} passed, ${this.failures.length} failed`);
    process.exitCode = this.failures.length ? 1 : 0;
  }
}
