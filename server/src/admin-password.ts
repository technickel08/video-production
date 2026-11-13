// Set, reset or remove the dashboard's admin password from the command line (for first set-up or a lost password).
//   npm run admin-password -- 'a-long-password'     set or reset
//   npm run admin-password -- --clear               turn sign-in off (only sensible on your own machine)
import { setAdminPassword, clearAdminPassword, MIN_PASSWORD } from './auth.ts';

const arg = process.argv[2];
if (!arg) { console.error(`Usage: npm run admin-password -- '<password of at least ${MIN_PASSWORD} characters>'   |   npm run admin-password -- --clear`); process.exit(1); }
try {
  if (arg === '--clear') { clearAdminPassword(); console.log('Sign-in is off and everyone is signed out. Restart the app if it is running.'); }
  else { setAdminPassword(arg); console.log('Admin password set. Sign-in is now required.'); }
} catch (e: any) { console.error(e.message); process.exit(1); }
