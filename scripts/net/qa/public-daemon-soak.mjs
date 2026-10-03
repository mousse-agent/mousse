#!/usr/bin/env node
/** Real elapsed time, actual protected service-run daemons, public Space scope only. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const DAY = 86400000, argv = process.argv.slice(2), options = {};
for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!/^--[a-z-]+$/.test(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--'))
        throw new Error('Expected --option value');
    options[key.slice(2)] = argv[++i];
}
for (const key of Object.keys(options))
    if (!['entry', 'executable', 'run-dir', 'duration-ms', 'interval-ms', 'fault-every-ms', 'source-sha', 'cleanup'].includes(key))
        throw new Error('Unknown option: ' + key);
const num = (key, fallback, min, max) => { const value = Number(options[key] ?? fallback); if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error('Invalid ' + key); return value; };
const duration = num('duration-ms', DAY, 30000, 2 * DAY), interval = num('interval-ms', 30000, 1000, 60000), faultEvery = num('fault-every-ms', 300000, 5000, 3600000);
const runDir = resolve(options['run-dir'] ?? ''), entry = resolve(options.entry ?? 'out/cli/index.js');
// An explicit production packaged executable accepts CLI arguments directly.
// The entry remains its physical ASAR, frozen and hashed throughout the run.
const executable = options.executable ? realpathSync(resolve(options.executable)) : process.execPath;
const entryArgs = options.executable ? [] : [entry], commandDirectory = options.executable ? dirname(executable) : dirname(dirname(dirname(entry)));
const applicationEnv = { ...process.env, NO_COLOR: '1' };
if (options.executable) delete applicationEnv.ELECTRON_RUN_AS_NODE;
if (!options['run-dir'] || !options.entry)
    throw new Error('--run-dir and --entry are required');
const nodeVersion = /^v(\d+)\.(\d+)\.(\d+)/.exec(process.version);
if (!nodeVersion || Number(nodeVersion[1]) !== 24 || Number(nodeVersion[2]) < 20)
    throw new Error('This qualification requires isolated supported Node24.20+');
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const probe = (command, args) => { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }); if (result.error || result.status !== 0)
    throw new Error('Resource probe failed: ' + command + ' ' + (result.error?.message ?? result.stderr?.slice(-300))); return result.stdout.trim(); };
const startIdentity = pid => probe('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
const boundedLog = (previous, bytes) => (previous + String(bytes)).slice(-8000);
const within = (parent, path) => { const rel = relative(parent, path); return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep); };
if (options.cleanup) {
    if (options.cleanup !== 'yes')
        throw new Error('--cleanup requires yes');
    const registry = JSON.parse(readFileSync(join(runDir, 'processes.json'), 'utf8'));
    for (const target of registry.daemons) {
        if (!within(runDir, target.home))
            throw new Error('Cleanup target is outside the owned run directory');
        const owner = JSON.parse(readFileSync(join(target.home, 'mms.owner.json'), 'utf8'));
        if (owner.pid !== target.pid)
            continue;
        let identity;
        try {
            identity = startIdentity(target.pid);
        }
        catch {
            continue;
        }
        if (identity !== target.startIdentity)
            throw new Error('PID identity changed; cleanup refused');
        const command = probe('/bin/ps', ['-o', 'command=', '-p', String(target.pid)]);
        if (!command.includes(registry.executable ?? registry.entry) || !command.includes(target.home) || !command.includes('service run'))
            throw new Error('Process command changed; cleanup refused');
        process.kill(target.pid, 'SIGTERM');
    }
    console.log(JSON.stringify({ cleanup: 'signalled', runDir }));
    process.exit(0);
}
if (existsSync(runDir))
    throw new Error('Run directory already exists; use a fresh owned directory');
mkdirSync(runDir, { recursive: true, mode: 0o700 });
const canonical = realpathSync(runDir), runId = randomUUID(), passphrase = randomBytes(32).toString('base64url'), homes = ['a', 'b', 'c'].map(name => join(canonical, 'profiles', name)), abort = new AbortController(), started = Date.now(), monotonicStart = process.hrtime.bigint(), children = new Set(), daemons = [], expected = new Map(), positionIds = new Map(), cursors = [0, 0, 0], users = [], nodes = [];
if (homes.some(home => Buffer.byteLength(join(home, 'mms.sock')) > 90))
    throw new Error('Qualification run root is too long for the guarded Unix socket path; use a short canonical /private/tmp path');
const reportPath = join(canonical, 'report.json'), eventsPath = join(canonical, 'events.jsonl'), samplesPath = join(canonical, 'samples.jsonl'), processPath = join(canonical, 'processes.json');
let runningStarted = 0;
let sourceSha = options['source-sha'] ?? 'unspecified', counter = 0, faultIndex = 0, nextFault = 0, space, stream, cliHash = sha(entry), nodeHash = sha(process.execPath), lastSample = 0;
const executableHash = sha(executable);
const report = { v: 1, runId, status: 'starting', qualified: false, scope: 'public-space-conversation', botsSoaked: false, privateStreamsSoaked: false, externalTransportsSoaked: false, node: process.version, platform: process.platform, arch: process.arch, sourceSha, harness: resolve(process.argv[1]), harnessSha256: sha(resolve(process.argv[1])), entry, cliSha256: cliHash, nodeExecutable: process.execPath, nodeSha256: nodeHash, startedAt: new Date(started).toISOString(), requestedDurationMs: duration, mode: duration >= DAY ? 'qualification' : 'smoke', intervalMs: interval, faultEveryMs: faultEvery, driverPid: process.pid, steps: 0, faults: 0, faultCounts: [0, 0, 0, 0], messages: 0, sent: 0, pending: 0, failed: 0, samples: 0, maxRssKiB: [0, 0, 0], maxFd: [0, 0, 0], maxDiskKiB: [0, 0, 0], baseline: [], runDir: canonical };
report.application = { kind: options.executable ? 'packaged-cli-asar' : 'node-cli', executable, executableSha256: executableHash, entryKind: options.executable ? 'physical-asar' : 'javascript' };
const elapsed = () => Number((process.hrtime.bigint() - monotonicStart) / 1000000n);
function save() { report.elapsedMs = elapsed(); report.conversationElapsedMs = runningStarted ? elapsed() - runningStarted : 0; report.wallElapsedMs = Date.now() - started; report.updatedAt = new Date().toISOString(); report.messages = expected.size; const records = [...expected.values()]; report.sent = records.filter(r => r.state === 'sent').length; report.failed = records.filter(r => r.state === 'failed').length; report.pending = records.filter(r => r.state === 'pending' || r.state === 'unknown').length; report.cursors = [...cursors]; const path = reportPath + '.tmp'; writeFileSync(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); renameSync(path, reportPath); }
function registry() { writeFileSync(processPath, JSON.stringify({ v: 1, runId, entry, ...(options.executable ? { executable } : {}), daemons: daemons.filter(Boolean).map(d => ({ pid: d.child.pid, home: d.home, startIdentity: d.startIdentity, generation: d.generation })) }, null, 2) + '\n', { mode: 0o600 }); }
function alive(index) { const d = daemons[index]; if (!d || d.child.exitCode !== null || d.child.signalCode !== null)
    throw new Error('Owned daemon ' + index + ' exited unexpectedly: ' + (d?.log ?? '')); return d; }
const delay = ms => new Promise(resolve => { if (abort.signal.aborted) {
    resolve();
    return;
} const done = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve(); }, timer = setTimeout(done, ms); abort.signal.addEventListener('abort', done, { once: true }); });
async function until(probeFn, ready, timeout = 30000) { const deadline = Date.now() + timeout; do {
    if (abort.signal.aborted)
        throw new Error('Interrupted');
    const value = await probeFn();
    if (ready(value))
        return value;
    await delay(100);
} while (Date.now() < deadline); throw new Error('Owned daemon qualification timed out'); }
function own(child) { children.add(child); child.once('exit', () => children.delete(child)); return child; }
async function kill(child) { if (child.exitCode !== null || child.signalCode !== null)
    return; const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await done; }
async function launch(index) {
    const child = own(spawn(executable, [...entryArgs, '--home', homes[index], 'service', 'run'], { cwd: commandDirectory, stdio: ['ignore', 'pipe', 'pipe'], env: { ...applicationEnv, MOUSSE_HOME: homes[index], MOUSSE_REPO_ROOT: canonical } })), d = { child, home: homes[index], generation: (daemons[index]?.generation ?? 0) + 1, log: '', startIdentity: '' };
    daemons[index] = d;
    child.stdout.on('data', bytes => { d.log = boundedLog(d.log, bytes); });
    child.stderr.on('data', bytes => { d.log = boundedLog(d.log, bytes); });
    await until(() => { alive(index); try {
        return JSON.parse(readFileSync(join(d.home, 'mms.runtime.json'), 'utf8')).pid === child.pid && JSON.parse(readFileSync(join(d.home, 'mms.owner.json'), 'utf8')).pid === child.pid;
    }
    catch {
        return false;
    } }, Boolean, 40000);
    d.startIdentity = startIdentity(child.pid);
    registry();
}
async function cli(index, args, input) {
    alive(index);
    if (sha(entry) !== cliHash || sha(process.execPath) !== nodeHash || sha(executable) !== executableHash)
        throw new Error('Frozen executable changed during the run');
    return await new Promise((resolve, reject) => {
        const child = own(spawn(executable, [...entryArgs, '--home', homes[index], '--json', ...args], { cwd: commandDirectory, stdio: ['pipe', 'pipe', 'pipe'], env: { ...applicationEnv, MOUSSE_HOME: homes[index], MOUSSE_REPO_ROOT: canonical } }));
        let output = '', error = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI deadline: ' + args.slice(0, 2).join(' '))); }, 30000);
        child.stdout.on('data', bytes => { output += String(bytes); if (Buffer.byteLength(output) > 2 * 1024 * 1024) {
            child.kill('SIGKILL');
            reject(new Error('CLI output exceeded resource guard'));
        } });
        child.stderr.on('data', bytes => { error = boundedLog(error, bytes); });
        child.once('error', cause => { clearTimeout(timer); reject(cause); });
        child.once('exit', code => { clearTimeout(timer); if (code !== 0) {
            reject(new Error('CLI failed ' + args.slice(0, 2).join(' ') + ': ' + error));
            return;
        } try {
            resolve(JSON.parse(output));
        }
        catch {
            reject(new Error('CLI result was not JSON'));
        } });
        child.stdin.end(input);
    });
}
function remember(author, text, delivery) {
    if (expected.size >= 16384)
        throw new Error('Original message journal resource guard exceeded');
    if (typeof delivery.id !== 'string' || !/^evt_/.test(delivery.id) || expected.has(delivery.id) || delivery.stream !== stream || !['pending', 'unknown', 'sent', 'failed'].includes(delivery.state))
        throw new Error('Invalid original delivery receipt');
    const record = { author, text, ...delivery };
    expected.set(delivery.id, record);
    ack(record, delivery);
    appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
    save();
    return record;
}
function ack(record, delivery) {
    const changed = record.state !== delivery.state || JSON.stringify(record.position) !== JSON.stringify(delivery.position);
    if (delivery.id !== record.id || delivery.stream !== stream)
        throw new Error('Original delivery binding changed');
    if (record.state === 'sent' && (delivery.state !== 'sent' || JSON.stringify(record.position) !== JSON.stringify(delivery.position)))
        throw new Error('Acknowledged original changed');
    if (delivery.state === 'sent') {
        if (delivery.position?.epoch !== 1 || !Number.isSafeInteger(delivery.position.seq) || delivery.position.seq < 1)
            throw new Error('Invalid host receipt position');
        const existing = positionIds.get(delivery.position.seq);
        if (existing && existing !== record.id)
            throw new Error('Host position reused for a different original');
        positionIds.set(delivery.position.seq, record.id);
    }
    Object.assign(record, { state: delivery.state, ...(delivery.position ? { position: delivery.position } : {}), ...(delivery.error ? { error: delivery.error } : {}) });
    if (changed)
        appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), receipt: { id: record.id, stream, state: record.state, ...(record.position ? { position: record.position } : {}) } }) + '\n', { mode: 0o600 });
}
async function post(author, label) { const text = `${runId}:${++counter}:${label}`; const delivery = await cli(author, ['spaces', 'post', stream, text]); return remember(author, text, delivery); }
async function receipts() { for (const record of expected.values()) {
    if (record.state === 'sent' || record.state === 'failed')
        continue;
    if (daemons[record.author].child.exitCode !== null || daemons[record.author].child.signalCode !== null)
        continue;
    const page = await cli(record.author, ['spaces', 'outbox', stream, '--id', record.id]);
    if (page.entries?.length !== 1)
        throw new Error('Original outbox receipt disappeared');
    ack(record, page.entries[0]);
} }
async function replicas() {
    for (let index = 0; index < 3; index++) {
        if (daemons[index].child.exitCode !== null || daemons[index].child.signalCode !== null)
            continue;
        for (let pageIndex = 0; pageIndex < 128; pageIndex++) {
            const page = await cli(index, ['spaces', 'tail', stream, '--after', `1:${cursors[index]}`, '--limit', '128']);
            if (page.stream !== stream || page.cursor?.epoch !== 1 || !Array.isArray(page.records))
                throw new Error('Invalid replica page');
            for (const row of page.records) {
                if (row.epoch !== 1 || row.seq !== cursors[index] + 1 || row.envelope?.stream !== stream || row.envelope.type !== 'message.posted')
                    throw new Error('Replica order or channel changed');
                const record = expected.get(row.envelope.id);
                if (!record || record.text !== row.envelope.body?.text || row.envelope.author.user !== users[record.author] || row.envelope.author.node !== nodes[record.author])
                    throw new Error('Replica original or speaker changed');
                if (record.position && (record.position.seq !== row.seq || record.position.epoch !== row.epoch))
                    throw new Error('Replica position differs from the sent receipt');
                const prior = positionIds.get(row.seq);
                if (prior && prior !== record.id)
                    throw new Error('Replicas disagree about host order');
                positionIds.set(row.seq, record.id);
                cursors[index] = row.seq;
            }
            if (page.cursor.seq !== cursors[index])
                throw new Error('Replica cursor advanced without validated records');
            if (page.done)
                break;
            if (!page.records.length || pageIndex === 127)
                throw new Error('Replica page/resource guard failed');
        }
    }
}
function metrics(final = false) {
    const rows = [];
    for (let index = 0; index < 3; index++) {
        const d = alive(index), rss = Number(probe('/bin/ps', ['-o', 'rss=', '-p', String(d.child.pid)])), fd = process.platform === 'linux' ? readdirSync(`/proc/${d.child.pid}/fd`).length : probe('/usr/sbin/lsof', ['-a', '-p', String(d.child.pid), '-Ff']).split('\n').filter(line => /^f\d+$/.test(line)).length, disk = Number(probe('/usr/bin/du', ['-sk', d.home]).split(/\s+/)[0]);
        if (!Number.isFinite(rss) || rss <= 0 || !Number.isSafeInteger(fd) || fd < 1 || !Number.isFinite(disk))
            throw new Error('Invalid live resource sample');
        if (rss > 1024 * 1024 || fd > 1024 || disk > 512 * 1024)
            throw new Error('Daemon resource hard limit exceeded');
        const profileId = JSON.parse(readFileSync(join(d.home, 'installation.json'), 'utf8')).defaultProfileId;
        if (typeof profileId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profileId))
            throw new Error('Invalid persisted default profile identity');
        const db = new DatabaseSync(join(d.home, 'profiles', profileId, 'net', 'net.db'), { readOnly: true });
        let outbox, integrity;
        try {
            db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000');
            outbox = db.prepare('SELECT state,count(*) AS count FROM net_outbox GROUP BY state').all();
            if (final)
                integrity = db.prepare('PRAGMA quick_check').all();
        }
        finally {
            db.close();
        }
        if (outbox.some(row => ['pending', 'unknown'].includes(row.state) && Number(row.count) > 128))
            throw new Error('Unresolved outbox resource limit exceeded');
        if (final && integrity.some(row => Object.values(row)[0] !== 'ok'))
            throw new Error('SQLite quick_check failed');
        const row = { index, pid: d.child.pid, generation: d.generation, rssKiB: rss, fd, diskKiB: disk, outbox, ...(integrity ? { quickCheck: integrity } : {}) };
        rows.push(row);
        report.maxRssKiB[index] = Math.max(report.maxRssKiB[index], rss);
        report.maxFd[index] = Math.max(report.maxFd[index], fd);
        report.maxDiskKiB[index] = Math.max(report.maxDiskKiB[index], disk);
    }
    if (!report.baseline.length)
        report.baseline = rows.map(row => ({ rssKiB: row.rssKiB, fd: row.fd, diskKiB: row.diskKiB }));
    for (const row of rows)
        if (row.rssKiB > report.baseline[row.index].rssKiB * 3 + 128 * 1024 || row.fd > report.baseline[row.index].fd + 128)
            throw new Error('Daemon resource growth guard exceeded');
    appendFileSync(samplesPath, JSON.stringify({ at: new Date().toISOString(), elapsedMs: elapsed(), rows }) + '\n', { mode: 0o600 });
    report.samples++;
    save();
}
async function restart(index) { await launch(index); const status = await cli(index, ['net', 'status']); if (status.keystore !== 'locked')
    throw new Error('Restart did not preserve protected keys'); await cli(index, ['net', 'unlock'], passphrase); }
async function fault() {
    const kind = faultIndex++ % 4;
    appendFileSync(eventsPath, JSON.stringify({ at: new Date().toISOString(), fault: kind }) + '\n', { mode: 0o600 });
    if (kind === 0) {
        await kill(alive(0).child);
        for (const index of [1, 2])
            await until(() => cli(index, ['spaces', 'list']), page => page.spaces.find(value => value.space === space)?.offline === true);
        const first = await post(1, 'host-outage-one'), second = await post(1, 'host-outage-two'), third = await post(2, 'host-outage-other');
        if ([first, second, third].some(record => record.state !== 'pending'))
            throw new Error('Offline original did not enter pending');
        await restart(0);
        await until(async () => { await receipts(); return [first, second, third].every(record => record.state === 'sent' || record.state === 'failed'); }, Boolean);
        if ([first, second, third].some(record => record.state !== 'sent'))
            throw new Error('Offline original failed instead of reaching sent');
        if (first.position.seq >= second.position.seq)
            throw new Error('Offline FIFO changed');
    }
    else if (kind === 1 || kind === 2) {
        const index = kind;
        await kill(alive(index).child);
        for (const author of [0, 1, 2].filter(author => author !== index)) {
            const record = await post(author, 'member-restart-' + index);
            if (record.state !== 'sent')
                throw new Error('Live author did not reach sent during member outage');
        }
        await restart(index);
    }
    else {
        const d = alive(2);
        d.child.kill('SIGSTOP');
        try {
            for (const author of [0, 1])
                await post(author, 'paused-recipient');
            await delay(2000);
        }
        finally {
            if (d.child.exitCode === null && d.child.signalCode === null)
                d.child.kill('SIGCONT');
        }
    }
    report.faults++;
    report.faultCounts[kind]++;
    await receipts();
    await replicas();
    metrics();
    save();
}
const interrupted = () => abort.abort();
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
save();
console.log(JSON.stringify({ driverPid: process.pid, reportPath, runDir: canonical, mode: report.mode, requestedDurationMs: duration }));
try {
    if (process.platform !== 'darwin' && process.platform !== 'linux')
        throw new Error('RSS/FD probes are implemented only for darwin/linux');
    for (let index = 0; index < 3; index++) {
        await launch(index);
        await cli(index, ['net', 'init', '--listen', '--port', '0', '--name', 'soak-' + index]);
        await cli(index, ['net', 'protect'], passphrase);
        const status = await cli(index, ['net', 'status']);
        users.push(status.self.user);
        nodes.push(status.self.node);
    }
    if (new Set(users).size !== 3 || new Set(nodes).size !== 3)
        throw new Error('Daemons did not use independent identities');
    const created = await cli(0, ['spaces', 'create', 'Public real-time qualification']);
    space = created.space;
    stream = created.channel;
    report.space = space;
    report.stream = stream;
    for (const index of [1, 2]) {
        const invitation = await cli(0, ['spaces', 'invite', space]);
        await cli(index, ['spaces', 'join'], invitation.invite + '\n');
        await cli(index, ['spaces', 'tail', stream]);
    }
    for (let index = 0; index < 3; index++)
        await post(index, 'initial');
    metrics(true);
    runningStarted = elapsed();
    report.conversationStartedAt = new Date().toISOString();
    report.status = 'running';
    save();
    nextFault = elapsed() + faultEvery;
    while (elapsed() - runningStarted < duration && !abort.signal.aborted) {
        const record = await post(report.steps % 3, 'step-' + report.steps);
        if (record.state === 'failed')
            throw new Error('Unexpected terminal post failure');
        await receipts();
        await replicas();
        report.steps++;
        if (elapsed() >= nextFault) {
            await fault();
            nextFault = elapsed() + faultEvery;
        }
        if (elapsed() - lastSample >= Math.min(60000, faultEvery)) {
            metrics();
            lastSample = elapsed();
        }
        save();
        await delay(interval);
    }
    if (abort.signal.aborted)
        throw new Error('Interrupted before duration completed');
    await until(async () => { await receipts(); await replicas(); const sent = [...expected.values()].filter(record => record.state === 'sent'); return [...expected.values()].every(record => record.state === 'sent' || record.state === 'failed') && cursors.every(cursor => cursor === sent.length); }, Boolean);
    metrics(true);
    if ([...expected.values()].some(record => record.state !== 'sent'))
        throw new Error('An original did not finish sent');
    if (elapsed() - runningStarted < duration || Date.now() - Date.parse(report.conversationStartedAt) < duration - 1000)
        throw new Error('The requested actual elapsed duration was not met');
    if (report.faultCounts.some(count => count === 0))
        throw new Error('The requested smoke/run did not exercise all four fault paths');
    report.validatedOrderSha256 = createHash('sha256').update(JSON.stringify([...positionIds.entries()].sort((a, b) => a[0] - b[0]))).digest('hex');
    report.status = 'completed';
    report.qualified = duration >= DAY;
    report.completedAt = new Date().toISOString();
    save();
}
catch (error) {
    report.status = abort.signal.aborted ? 'interrupted' : 'failed';
    report.qualified = false;
    report.error = error instanceof Error ? error.message : String(error);
    save();
    process.exitCode = 1;
}
finally {
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
    await Promise.all([...children].map(kill));
    report.cleanedOwnedProcesses = true;
    save();
    console.log(JSON.stringify({ status: report.status, qualified: report.qualified, reportPath, elapsedMs: report.elapsedMs, messages: report.messages, faults: report.faults }));
}
