// Node 25 treats an explicit directory as a module; retain the documented
// directory command as well as node --test .../*.test.mjs on older Node.
import('./brain-skills.test.mjs');
