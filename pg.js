// PostgreSQL restore target: a private, throwaway server started inside this container.
// initdb into a temp directory, listen on a Unix socket only (no TCP), restore the dump,
// answer the checks through psql, then stop it and delete the directory. The live database
// is never contacted, and no Docker socket is needed.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout || 10 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const why = String(stderr || err.message).trim().split('\n').slice(-3).join(' ');
        reject(new Error(`${path.basename(cmd)} failed: ${why}`));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// pg_dump --format=custom files start with "PGDMP"; anything else is treated as plain SQL.
const isCustomFormat = (file) => {
  const fd = fs.openSync(file, 'r');
  try {
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    return b.toString() === 'PGDMP';
  } finally {
    fs.closeSync(fd);
  }
};

// Postgres binaries live on PATH in the image; Debian/Ubuntu keep them in a versioned directory.
function binDir(env = process.env) {
  if (env.PG_BIN) return env.PG_BIN;
  for (const v of ['17', '16', '15']) {
    const d = `/usr/lib/postgresql/${v}/bin`;
    if (fs.existsSync(path.join(d, 'initdb'))) return d;
  }
  return '';
}
const bin = (name) => (binDir() ? path.join(binDir(), name) : name);

// The throwaway server listens on a Unix socket only, so drills need Linux or macOS (the image is Linux).
async function available() {
  if (process.platform === 'win32') return false;
  try { await run(bin('initdb'), ['--version'], { timeout: 10_000 }); return true; } catch { return false; }
}

// Start a server in `dir`, restore `file` into database "restored", hand back a query function.
async function restorePostgres(file, dir) {
  const data = path.join(dir, 'pgdata');
  const sock = dir; // the socket file lands next to the data, inside the private temp dir
  const port = String(54000 + Math.floor(Math.random() * 900));
  await run(bin('initdb'), ['-D', data, '-U', 'drill', '--auth=trust', '--no-sync', '-E', 'UTF8', '--locale=C']);
  await run(bin('pg_ctl'), ['-D', data, '-l', path.join(dir, 'server.log'), '-w', '-t', '60', '-o', `-c listen_addresses='' -k ${sock} -p ${port} -c fsync=off -c full_page_writes=off`, 'start']);
  const conn = ['-h', sock, '-p', port, '-U', 'drill'];
  const stop = () => run(bin('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop']).catch(() => {});
  try {
    await run(bin('createdb'), [...conn, 'restored']);
    // Dumps carry owners and grants from the source server; this throwaway one has neither.
    if (isCustomFormat(file)) {
      await run(bin('pg_restore'), [...conn, '-d', 'restored', '--no-owner', '--no-acl', '--exit-on-error', file]);
    } else {
      // Plain SQL can't skip ownership like pg_restore --no-owner, so create the roles it names.
      // ponytail: reads the whole dump into memory; stream it if plain dumps grow past a few hundred MB.
      const roles = new Set([...fs.readFileSync(file, 'utf8').matchAll(/OWNER TO "?([A-Za-z0-9_-]+)"?;/g)].map((m) => m[1]));
      roles.delete('drill');
      for (const role of roles) await run(bin('psql'), [...conn, '-d', 'restored', '-q', '-c', `CREATE ROLE "${role}"`]);
      await run(bin('psql'), [...conn, '-d', 'restored', '-v', 'ON_ERROR_STOP=1', '-q', '-f', file]);
    }
  } catch (err) {
    await stop();
    throw err;
  }
  const query = async (sql) => (await run(bin('psql'), [...conn, '-d', 'restored', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql])).stdout.trim();
  return { query, stop };
}

module.exports = { restorePostgres, available, isCustomFormat };
