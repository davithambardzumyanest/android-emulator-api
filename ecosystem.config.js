// PM2 config exists for one setting: treekill.
//
// PM2 defaults to treekill: true, which on stop/restart walks the process tree
// by PPID and SIGKILLs every descendant. The API spawns emulators, so each
// device is a descendant and every restart - a deploy, a crash loop, a forced
// /cleanup - took all of them down with it.
//
// Spawning the emulator detached is necessary but not sufficient on its own:
// detached gives the child its own process *group*, and treekill walks parent
// pointers, not groups. It finds the emulator while the API is still alive and
// kills it anyway. With treekill off, PM2 signals only the API process and the
// emulators reparent to init and keep running, which is what
// adoptOrphanEmulators() was always written to expect.
module.exports = {
  apps: [
    {
      name: 'android-emulator-api',
      script: 'index.js',
      exec_mode: 'fork',
      instances: 1,
      treekill: false,
      autorestart: true,
    },
  ],
};
