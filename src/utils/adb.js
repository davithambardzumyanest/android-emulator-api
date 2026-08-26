// Safe, serialised adb access.
//
// Every call goes through spawn() with an argv array, so nothing the caller
// passes can be re-interpreted by the host shell. Calls to a single device are
// queued: concurrent `uiautomator dump` or `screencap` invocations on the same
// emulator clobber each other and are a common source of flaky results.
const { spawn } = require('child_process');
const config = require('../config');
const logger = require('../logger');

const queues = new Map();

/** Run `fn` after every previously queued call for `key` has settled. */
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // Keep the chain alive but never let a rejection escape as unhandled.
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * Spawn a command and capture stdout/stderr.
 * @returns {Promise<{code:number, stdout:Buffer, stderr:string}>}
 */
function run(command, args, { timeoutMs = config.adb.timeoutMs, maxBuffer = config.adb.maxBuffer } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: config.android.env,
    });

    const chunks = [];
    let stdoutLength = 0;
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs) : null;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(arg);
    };

    proc.stdout.on('data', (chunk) => {
      stdoutLength += chunk.length;
      if (stdoutLength <= maxBuffer) chunks.push(chunk);
    });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    // 'error' fires when the binary is missing — without this the promise
    // would never settle and the request would hang forever.
    proc.on('error', (err) => finish(reject, err));

    proc.on('close', (code) => {
      if (timedOut) {
        const e = new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`);
        e.status = 504;
        return finish(reject, e);
      }
      finish(resolve, { code, stdout: Buffer.concat(chunks), stderr: stderr.trim() });
    });
  });
}

/**
 * Run an adb subcommand against a serial.
 * @param {string} serial e.g. 'emulator-5554'
 * @param {string[]} args argv after `-s <serial>`
 * @param {object} [opts] check:false to resolve on non-zero exit
 */
async function adb(serial, args, opts = {}) {
  if (!Array.isArray(args)) throw new TypeError('adb() expects an argv array');
  const argv = serial ? ['-s', serial, ...args] : [...args];
  logger.debug({ serial, args }, 'adb');

  const exec = () => run('adb', argv, opts);
  // Global adb calls (devices, start-server) share one queue key.
  const res = await enqueue(serial || '__global__', exec);

  if (res.code !== 0 && opts.check !== false) {
    const e = new Error(`adb ${argv.join(' ')} failed (${res.code}): ${res.stderr || 'no output'}`);
    e.status = 500;
    e.stdout = res.stdout.toString();
    e.stderr = res.stderr;
    e.code = res.code;
    throw e;
  }
  return res;
}

/** adb subcommand returning trimmed stdout text. */
async function adbText(serial, args, opts = {}) {
  const res = await adb(serial, args, opts);
  return res.stdout.toString('utf8').trim();
}

/** adb subcommand returning raw stdout bytes (screencap, exec-out). */
async function adbBuffer(serial, args, opts = {}) {
  const res = await adb(serial, args, opts);
  return res.stdout;
}

/**
 * Quote a string for the *device* shell.
 * adb concatenates its argv and hands the result to /system/bin/sh, so argv
 * arrays alone do not protect against metacharacters in user input.
 */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/** `adb -s X shell <parts...>` with every part quoted for the device shell. */
function shell(serial, parts, opts = {}) {
  const quoted = (Array.isArray(parts) ? parts : [parts]).map(shellQuote);
  return adbText(serial, ['shell', ...quoted], opts);
}

/** Read a device property. Returns '' when unset. */
function getProp(serial, name) {
  return shell(serial, ['getprop', name], { check: false });
}

/** List attached emulator serials that report state `device`. */
async function listEmulators() {
  const res = await adb(null, ['devices'], { check: false });
  return res.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^emulator-\d+\s+device$/.test(line))
    .map((line) => line.split(/\s+/)[0]);
}

module.exports = { run, adb, adbText, adbBuffer, shell, shellQuote, getProp, listEmulators, enqueue };
