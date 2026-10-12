// Local routing proxy between an emulator and its upstream proxy.
//
// The emulator's -http-proxy turns every guest TCP connection into a
// "CONNECT <ip>:<port>" to the proxy - the guest has already resolved DNS, so
// the hostname is gone by then. Pointing -http-proxy here instead lets each
// connection be routed by hostname, recovered from:
// - the TLS ClientHello's SNI (HTTPS, the vast majority of traffic),
// - a nested "CONNECT host:port" - apps that honor Android's global proxy
//   setting (deviceService.applyProxy) send this inside the tunnel,
// - the Host header of plain HTTP.
// Hosts on the bypass list connect directly from this server; everything else
// is CONNECTed to the upstream proxy by hostname (so the proxy resolves DNS
// from its own location), with the upstream credentials added here.
//
// Only hostnames are visible - URLs and file types are inside TLS, so
// browser-api's "/*.js"-style path rules are not possible for an emulator.
const net = require('net');
const logger = require('../logger');

// How long to wait for the guest's first bytes before routing without a
// hostname. TLS ports get long: an emulator under load can take seconds to
// send its ClientHello, and without it the proxy only gets an IP address.
// Short elsewhere, for protocols where the server speaks first.
const FIRST_DATA_TIMEOUT_MS = 1500;
const TLS_FIRST_DATA_TIMEOUT_MS = 15000;
const TLS_PORTS = new Set([443, 853, 5228]);
const HEAD_LIMIT = 16 * 1024;

// Same "*" glob semantics as Chrome's --proxy-bypass-list host entries.
const buildHostMatcher = (patterns) => {
    const regexes = (patterns || []).map(pattern => new RegExp(
        `^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i'
    ));
    return (host) => Boolean(host) && regexes.some(re => re.test(host));
};

/**
 * Parse an upstream proxy URL ("http://user:pass@host:port" or "host:port").
 * @returns {{host: string, port: number, auth: string|null}|null} null for
 *   anything but a plain HTTP proxy
 */
const parseUpstream = (proxy) => {
    if (!proxy) return null;
    try {
        const url = new URL(String(proxy).includes('://') ? proxy : `http://${proxy}`);
        if (url.protocol !== 'http:') return null;
        const auth = url.username
            ? Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}`).toString('base64')
            : null;
        return { host: url.hostname, port: Number(url.port) || 80, auth };
    } catch (_) {
        return null;
    }
};

/**
 * Read the SNI hostname out of a TLS ClientHello record.
 * @returns {string|null}
 */
const parseSni = (buf) => {
    try {
        if (buf.length < 43 || buf[0] !== 0x16 || buf[5] !== 0x01) return null;
        let pos = 43; // record header 5 + handshake header 4 + version 2 + random 32
        pos += 1 + buf[pos]; // session id
        pos += 2 + buf.readUInt16BE(pos); // cipher suites
        pos += 1 + buf[pos]; // compression methods
        const extensionsEnd = pos + 2 + buf.readUInt16BE(pos);
        pos += 2;
        while (pos + 4 <= extensionsEnd && pos + 4 <= buf.length) {
            const type = buf.readUInt16BE(pos);
            const length = buf.readUInt16BE(pos + 2);
            pos += 4;
            if (type === 0x0000) {
                // server_name list: list length 2, name type 1, name length 2
                const nameLength = buf.readUInt16BE(pos + 3);
                return buf.slice(pos + 5, pos + 5 + nameLength).toString('ascii');
            }
            pos += length;
        }
    } catch (_) {
        // Truncated or not a ClientHello.
    }
    return null;
};

const isTlsClientHello = (buf) => buf.length > 5 && buf[0] === 0x16 && buf[5] === 0x01;

// A ClientHello often spans several TCP segments - Chrome's post-quantum key
// share alone is over 1KB and extension order is randomized, so the SNI can
// sit in a later segment. Keep reading until the whole TLS record is in.
const readFullClientHello = async (socket, initial) => {
    let buf = initial;
    const recordEnd = () => 5 + buf.readUInt16BE(3);
    while (buf.length >= 5 && buf.length < recordEnd() && buf.length < HEAD_LIMIT) {
        socket.resume();
        const more = await readFirstData(socket);
        if (!more.length) break;
        buf = Buffer.concat([buf, more]);
    }
    return buf;
};

const splitHostPort = (value, defaultPort) => {
    const match = String(value).match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
    return match ? { host: match[1], port: Number(match[2]) || defaultPort } : null;
};

// Read from a socket until a full HTTP head ("\r\n\r\n") has arrived.
const readHead = (socket, initial = Buffer.alloc(0)) => new Promise((resolve, reject) => {
    let buf = initial;
    const check = () => {
        const end = buf.indexOf('\r\n\r\n');
        if (end !== -1) {
            cleanup();
            resolve({ head: buf.slice(0, end).toString('latin1'), rest: buf.slice(end + 4) });
        } else if (buf.length > HEAD_LIMIT) {
            cleanup();
            reject(new Error('HTTP head too large'));
        }
    };
    const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        check();
    };
    const onEnd = () => {
        cleanup();
        reject(new Error('connection closed before HTTP head'));
    };
    const cleanup = () => {
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('error', onEnd);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('error', onEnd);
    socket.resume();
    check();
});

// First bytes the guest sends inside a tunnel, or an empty buffer for
// server-speaks-first protocols.
const readFirstData = (socket, timeoutMs = FIRST_DATA_TIMEOUT_MS) => new Promise((resolve) => {
    const timer = setTimeout(() => {
        socket.off('data', onData);
        socket.pause();
        resolve(Buffer.alloc(0));
    }, timeoutMs);
    const onData = (chunk) => {
        clearTimeout(timer);
        socket.pause();
        resolve(chunk);
    };
    socket.once('data', onData);
});

/**
 * Start a routing proxy for one emulator.
 *
 * @param {Object} options
 * @param {string} options.label - error log prefix, e.g. the emulator serial
 * @param {string} options.upstream - the device's proxy URL
 * @param {string[]} [options.bypassHosts] - hosts connected to directly
 * @returns {Promise<Object|null>} router ({url, setUpstream, close}),
 *   or null when the upstream isn't a plain HTTP proxy this can route for
 */
const startProxyRouter = async ({ label, upstream, bypassHosts = [] }) => {
    let upstreamConfig = parseUpstream(upstream);
    if (!upstreamConfig) return null;
    const isBypassHost = buildHostMatcher(bypassHosts);

    // Open a tunnel to host:port through the upstream proxy.
    const connectViaUpstream = (host, port) => new Promise((resolve, reject) => {
        const { host: proxyHost, port: proxyPort, auth } = upstreamConfig;
        const socket = net.connect(proxyPort, proxyHost);
        socket.once('error', reject);
        socket.once('connect', async () => {
            const target = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
            socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${auth}\r\n` : ''}\r\n`);
            try {
                const { head, rest } = await readHead(socket);
                const status = Number(head.split(' ')[1]);
                if (status !== 200) {
                    socket.destroy();
                    return reject(new Error(`upstream proxy answered ${status}`));
                }
                socket.off('error', reject);
                resolve({ socket, rest });
            } catch (error) {
                socket.destroy();
                reject(error);
            }
        });
    });

    const connectDirect = (host, port) => new Promise((resolve, reject) => {
        const socket = net.connect(port, host);
        socket.once('error', reject);
        socket.once('connect', () => {
            socket.off('error', reject);
            resolve({ socket, rest: Buffer.alloc(0) });
        });
    });

    // Route one guest stream: `initial` is what the guest already sent.
    const route = async (client, { hostname, ip, port, initial }) => {
        const host = hostname || ip;
        const direct = isBypassHost(hostname);
        let outbound;
        try {
            // Direct: the guest's own DNS answer when there is one.
            const connection = direct ? await connectDirect(ip || hostname, port) : await connectViaUpstream(host, port);
            outbound = connection.socket;
            if (connection.rest.length) client.write(connection.rest);
        } catch (_) {
            client.destroy();
            return;
        }
        if (initial.length) outbound.write(initial);
        client.pipe(outbound);
        outbound.pipe(client);
        client.resume();
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            client.destroy();
            outbound.destroy();
        };
        client.on('close', finish);
        outbound.on('close', finish);
        client.on('error', finish);
        outbound.on('error', finish);
    };

    // A plain-HTTP proxy request ("GET http://host/ HTTP/1.1"), from the
    // emulator's port-80 rewriter or a proxy-aware app. Small and rare, so
    // always forwarded to the upstream proxy as-is, with credentials added.
    const forwardHttpToUpstream = (client, head, rest) => {
        const { host, port, auth } = upstreamConfig;
        const outbound = net.connect(port, host, () => {
            const lines = head.split('\r\n').filter(line => !/^proxy-authorization:/i.test(line));
            if (auth) lines.splice(1, 0, `Proxy-Authorization: Basic ${auth}`);
            outbound.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (rest.length) outbound.write(rest);
            client.pipe(outbound);
            outbound.pipe(client);
            client.resume();
        });
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            client.destroy();
            outbound.destroy();
        };
        client.on('close', finish);
        outbound.on('close', finish);
        client.on('error', finish);
        outbound.on('error', finish);
    };

    const handleClient = async (client) => {
        client.on('error', () => client.destroy());
        let head, rest;
        try {
            ({ head, rest } = await readHead(client));
        } catch (_) {
            client.destroy();
            return;
        }
        client.pause();
        const [method, requestTarget] = head.split('\r\n')[0].split(' ');
        if (method !== 'CONNECT') return forwardHttpToUpstream(client, head, rest);

        const tunnel = splitHostPort(requestTarget, 443);
        if (!tunnel) return client.destroy();
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.resume();
        let initial = rest.length ? rest : await readFirstData(client, TLS_PORTS.has(tunnel.port) ? TLS_FIRST_DATA_TIMEOUT_MS : FIRST_DATA_TIMEOUT_MS);

        let hostname = net.isIP(tunnel.host) ? null : tunnel.host;
        let ip = net.isIP(tunnel.host) ? tunnel.host : null;
        let port = tunnel.port;

        if (initial.slice(0, 8).toString('latin1') === 'CONNECT ') {
            // Nested CONNECT from an app using Android's global proxy setting:
            // this server answers it in place of the upstream proxy.
            let nested;
            try {
                nested = await readHead(client, initial);
            } catch (_) {
                return client.destroy();
            }
            client.pause();
            const inner = splitHostPort(nested.head.split('\r\n')[0].split(' ')[1], 443);
            if (!inner) return client.destroy();
            client.write('HTTP/1.1 200 Connection established\r\n\r\n');
            hostname = net.isIP(inner.host) ? null : inner.host;
            ip = net.isIP(inner.host) ? inner.host : null;
            port = inner.port;
            client.resume();
            initial = nested.rest.length ? nested.rest : await readFirstData(client, TLS_PORTS.has(port) ? TLS_FIRST_DATA_TIMEOUT_MS : FIRST_DATA_TIMEOUT_MS);
        } else if (/^[A-Z]+ \S+ HTTP\/1\.[01]\r\n/.test(initial.slice(0, 2048).toString('latin1'))) {
            // Plain HTTP through the tunnel: absolute-URI form means the guest
            // is talking to a proxy (the global proxy setting).
            const text = initial.slice(0, HEAD_LIMIT).toString('latin1');
            if (/^[A-Z]+ https?:\/\//.test(text)) {
                let request;
                try {
                    request = await readHead(client, initial);
                } catch (_) {
                    return client.destroy();
                }
                client.pause();
                return forwardHttpToUpstream(client, request.head, request.rest);
            }
            const hostHeader = (text.match(/\r\nhost:\s*([^\r\n]+)/i) || [])[1];
            if (hostHeader) hostname = splitHostPort(hostHeader.trim(), port)?.host || hostname;
        }

        if (isTlsClientHello(initial)) {
            initial = await readFullClientHello(client, initial);
            hostname = parseSni(initial) || hostname;
        }
        await route(client, { hostname, ip, port, initial });
    };

    const server = net.createServer(client => {
        handleClient(client).catch(error => {
            logger.warn(`[${label}] proxy router error: ${error.message}`);
            client.destroy();
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}`,
        // Point at a new upstream proxy (POST /devices/:id/proxy). Existing
        // tunnels keep their connection; new ones use the new proxy.
        setUpstream: (proxy) => {
            const next = parseUpstream(proxy);
            if (next) upstreamConfig = next;
            return Boolean(next);
        },
        close: () => new Promise(resolve => server.close(() => resolve()))
    };
};

module.exports = { startProxyRouter, parseSni };
