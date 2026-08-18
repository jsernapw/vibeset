#!/usr/bin/env node

// This file is intentionally plain, dependency-free ESM: it must run
// correctly under whatever Node the user's shell defaults to (which may be
// far below the floor VibeSet requires) so the version check below always
// fires with a clear message, instead of the process crashing on a syntax
// or API it doesn't understand deep inside a dependency.
//
// Everything that actually needs Node >= 22 (the Salesforce SDKs, the
// server, better-sqlite3) is only reached via the dynamic import() below,
// which never executes if the preflight check fails.

// 22.10 rather than plain 22: `worker_threads.markAsUncloneable` landed in
// Node 22.10, and undici (via @jsforce/jsforce-node, via @salesforce/core)
// calls it at module load. On 22.2 the Salesforce SDKs crash on import with
// an error that points nowhere near the real cause, so the floor is here.
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 10;

function preflight() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const tooOld =
    Number.isNaN(major) || major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);
  if (tooOld) {
    process.stderr.write(
      '\n' +
        `VibeSet requires Node.js >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}, but this process is running ` +
        `Node ${process.version} (${process.execPath}).\n\n` +
        'Fix one of these ways:\n' +
        '  - nvm:    nvm install 22.21.0 && nvm use 22.21.0\n' +
        '  - volta:  volta install node@22.21.0\n' +
        '  - manual: install Node 22.10+ from https://nodejs.org and re-run `vibeset`\n' +
        '\n' +
        'This project pins Node 22.21.0 in .nvmrc / package.json "volta".\n\n',
    );
    process.exit(1);
  }
}

preflight();
main();

async function main() {
  const { run } = await import('../dist/cli.js');
  await run(process.argv);
}
