// The later parts of e2e-two-devices.mjs (its LATER list), as their own suite so each file fits
// the suite time limit on GitHub's Mac.
process.env.E2E_TWO_DEVICES_LATER = '1';
await import('./e2e-two-devices.mjs');
