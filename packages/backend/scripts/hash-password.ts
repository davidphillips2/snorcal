/**
 * Generate a scrypt password hash for SNORCAL_PASSWORD_HASH.
 *
 * Usage:
 *   pnpm --filter backend exec tsx scripts/hash-password.ts
 *
 * Then paste the printed hash into your .env:
 *   SNORCAL_PASSWORD_HASH=scrypt$N=32768$...
 */
import readline from 'node:readline';
import { hashPassword } from '../src/services/auth-crypto.js';

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  const pw1 = await ask('Password: ');
  if (!pw1) { console.error('Password required.'); process.exit(1); }
  const pw2 = await ask('Confirm:  ');
  rl.close();
  if (pw1 !== pw2) { console.error('Passwords do not match.'); process.exit(1); }

  const hash = hashPassword(pw1);
  console.log('\nSNORCAL_PASSWORD_HASH=' + hash);
  console.log('\nPaste this into your .env (or set as an environment variable).');
}

main().catch((e) => { console.error(e); process.exit(1); });
