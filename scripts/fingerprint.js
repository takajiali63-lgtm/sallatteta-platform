// Prints the build fingerprint of this folder (same value the admin panel shows when this code is running).
import { computeFingerprint } from '../src/lib/fingerprint.js';
const f = computeFingerprint();
console.log(`${f.fingerprint}  (${f.files} files)`);
