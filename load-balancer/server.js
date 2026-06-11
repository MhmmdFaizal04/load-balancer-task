const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const proxy = httpProxy.createProxyServer({});

// ─── Colors ──────────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bright:  '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  bgBlue:  '\x1b[44m',
};

// ─── Server pool ─────────────────────────────────────────────────────────────
const SERVERS = [
  { id: 'server-1', url: 'http://server-1:3001', activeConnections: 0, totalRequests: 0, color: C.cyan },
  { id: 'server-2', url: 'http://server-2:3002', activeConnections: 0, totalRequests: 0, color: C.green },
  { id: 'server-3', url: 'http://server-3:3003', activeConnections: 0, totalRequests: 0, color: C.magenta },
];

// ─── State ───────────────────────────────────────────────────────────────────
let algorithm = 'round-robin'; // 'round-robin' | 'least-connection'
let rrIndex = 0;
const requestLog = [];

// ─── Logging helpers ─────────────────────────────────────────────────────────
function ts() {
  const d = new Date();
  return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function serverTag(server) {
  return `${server.color}${C.bright}[${server.id}]${C.reset}`;
}

function algoTag(algo) {
  return algo === 'round-robin'
    ? `${C.yellow}${C.bright}RoundRobin${C.reset}`
    : `${C.magenta}${C.bright}LeastConn${C.reset}`;
}

function logInfo(msg) {
  console.log(`${C.blue}${C.bright}[LB]${C.reset} ${C.dim}${ts()}${C.reset}  ${msg}`);
}

function logBatchStart(count, algo) {
  console.log(`\n${C.blue}${'─'.repeat(60)}${C.reset}`);
  console.log(
    `${C.blue}${C.bright}[LB]${C.reset} ${C.dim}${ts()}${C.reset}  ` +
    `${C.white}${C.bright}📦 Batch: ${count} request(s)${C.reset}  algo=${algoTag(algo)}`
  );
  console.log(
    `${C.blue}${'─'.repeat(60)}${C.reset}`
  );
}

function logRequestStart(reqId, server, algo, conns) {
  const connState = SERVERS.map(s =>
    `${s.color}${s.id}${C.reset}:${s.activeConnections}`
  ).join('  ');
  console.log(
    `${C.green}${C.bright}  ▶ SEND${C.reset}  ` +
    `${C.dim}${ts()}${C.reset}  ` +
    `id=${C.cyan}${reqId.substring(0, 8)}${C.reset}  ` +
    `→ ${serverTag(server)}  ` +
    `algo=${algoTag(algo)}  ` +
    `connections: [ ${connState} ]`
  );
}

function logRequestDone(reqId, server, algo, ms, status) {
  const icon   = status === 'ok' ? `${C.green}${C.bright}✓ DONE${C.reset}` : `${C.red}${C.bright}✗ ERR ${C.reset}`;
  const connState = SERVERS.map(s =>
    `${s.color}${s.id}${C.reset}:${s.activeConnections}`
  ).join('  ');
  console.log(
    `${icon}    ` +
    `${C.dim}${ts()}${C.reset}  ` +
    `id=${C.cyan}${reqId.substring(0, 8)}${C.reset}  ` +
    `← ${serverTag(server)}  ` +
    `${C.yellow}${ms}ms${C.reset}  ` +
    `connections: [ ${connState} ]`
  );
}

function printBanner() {
  console.log(`\n${C.blue}${C.bright}╔═════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.blue}${C.bright}║      LOAD BALANCER  —  started on port 3000         ║${C.reset}`);
  console.log(`${C.blue}${C.bright}║  Algorithms : Round Robin | Least Connection        ║${C.reset}`);
  console.log(`${C.blue}${C.bright}║  Backends   : server-1  server-2  server-3          ║${C.reset}`);
  console.log(`${C.blue}${C.bright}╚═════════════════════════════════════════════════════╝${C.reset}\n`);
  console.log(`  ${C.yellow}Dashboard  :${C.reset} http://localhost:3000`);
  console.log(`  ${C.yellow}Algorithm  :${C.reset} ${algorithm}`);
  console.log(`\n  Terminal log format:`);
  console.log(`  ${C.green}${C.bright}  ▶ SEND${C.reset}  <time>  id=<reqId>  → ${C.cyan}[server]${C.reset}  connections: [...]`);
  console.log(`  ${C.green}${C.bright}  ✓ DONE${C.reset}  <time>  id=<reqId>  ← ${C.cyan}[server]${C.reset}  <ms>ms  connections: [...]`);
  console.log(`\n${'─'.repeat(60)}\n`);
}

// ─── Algorithm selectors ─────────────────────────────────────────────────────
function selectRoundRobin() {
  const s = SERVERS[rrIndex % SERVERS.length];
  rrIndex = (rrIndex + 1) % SERVERS.length;
  return s;
}

function selectLeastConnection() {
  return SERVERS.reduce((prev, curr) =>
    curr.activeConnections < prev.activeConnections ? curr : prev
  );
}

function selectServer() {
  return algorithm === 'round-robin' ? selectRoundRobin() : selectLeastConnection();
}

// ─── WebSocket broadcast ─────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  logInfo('WebSocket client connected');
  // Send current state on connect
  ws.send(JSON.stringify({
    type: 'init',
    algorithm,
    servers: SERVERS.map(s => ({ id: s.id, activeConnections: s.activeConnections, totalRequests: s.totalRequests })),
    log: requestLog.slice(-50),
  }));
});

// ─── API Routes ───────────────────────────────────────────────────────────────

// Switch algorithm
app.post('/api/algorithm', (req, res) => {
  const { algo } = req.body;
  if (!['round-robin', 'least-connection'].includes(algo)) {
    return res.status(400).json({ error: 'Invalid algorithm. Use: round-robin | least-connection' });
  }
  algorithm = algo;
  rrIndex = 0; // reset RR index on switch
  logInfo(`Algorithm switched to: ${C.yellow}${algorithm}${C.reset}`);
  broadcast({ type: 'algorithm_change', algorithm });
  res.json({ algorithm });
});

// Server stats
app.get('/api/stats', (req, res) => {
  res.json({
    algorithm,
    servers: SERVERS.map(s => ({
      id: s.id,
      url: s.url,
      activeConnections: s.activeConnections,
      totalRequests: s.totalRequests,
    })),
    totalRequests: requestLog.length,
  });
});

// Send a batch of test requests from the UI
app.post('/api/test', async (req, res) => {
  const count = Math.min(parseInt(req.body.count) || 10, 50);
  res.json({ message: `Sending ${count} test requests`, count });

  logBatchStart(count, algorithm);

  for (let i = 0; i < count; i++) {
    // Fire requests with slight stagger (30ms) so Least Connection is visible
    setTimeout(() => triggerInternalRequest(), i * 30);
  }
});

// Internal helper – makes a test request through the load balancer pipeline
function triggerInternalRequest() {
  const requestId = uuidv4();
  const selected = selectServer();

  selected.activeConnections++;
  selected.totalRequests++;

  const entry = {
    requestId,
    serverId: selected.id,
    algorithm,
    timestamp: new Date().toISOString(),
    status: 'pending',
    processingTimeMs: null,
  };

  requestLog.push(entry);
  if (requestLog.length > 200) requestLog.shift();

  // ── Log request START to terminal ──────────────────────────────────────────
  logRequestStart(requestId, selected, algorithm, selected.activeConnections);

  broadcast({ type: 'request_start', entry, servers: getServerStats() });

  // Proxy to backend
  const options = {
    hostname: selected.id,
    port: parseInt(selected.url.split(':')[2]),
    path: '/ping',
    method: 'GET',
    headers: { 'x-request-id': requestId },
  };

  const startTime = Date.now();
  const req = http.request(options, (backendRes) => {
    let body = '';
    backendRes.on('data', chunk => body += chunk);
    backendRes.on('end', () => {
      selected.activeConnections = Math.max(0, selected.activeConnections - 1);
      const elapsed = Date.now() - startTime;
      entry.status = 'ok';
      entry.processingTimeMs = elapsed;
      // ── Log request DONE to terminal ──────────────────────────────────────
      logRequestDone(requestId, selected, algorithm, elapsed, 'ok');
      broadcast({ type: 'request_done', entry, servers: getServerStats() });
    });
  });

  req.on('error', (err) => {
    selected.activeConnections = Math.max(0, selected.activeConnections - 1);
    entry.status = 'error';
    entry.error = err.message;
    const elapsed = Date.now() - startTime;
    entry.processingTimeMs = elapsed;
    logRequestDone(requestId, selected, algorithm, elapsed, 'error');
    broadcast({ type: 'request_done', entry, servers: getServerStats() });
  });

  req.end();
}

function getServerStats() {
  return SERVERS.map(s => ({
    id: s.id,
    activeConnections: s.activeConnections,
    totalRequests: s.totalRequests,
  }));
}

// ─── Proxy: forward any /proxy/* request to a selected backend ───────────────
app.all('/proxy/*', (req, res) => {
  const requestId = req.headers['x-request-id'] || uuidv4();
  const selected = selectServer();

  selected.activeConnections++;
  selected.totalRequests++;

  req.headers['x-request-id'] = requestId;

  const entry = {
    requestId,
    serverId: selected.id,
    algorithm,
    timestamp: new Date().toISOString(),
    status: 'pending',
    processingTimeMs: null,
  };

  requestLog.push(entry);
  if (requestLog.length > 200) requestLog.shift();

  logRequestStart(requestId, selected, algorithm, selected.activeConnections);
  broadcast({ type: 'request_start', entry, servers: getServerStats() });

  const startTime = Date.now();

  proxy.web(req, res, { target: selected.url, ignorePath: false }, (err) => {
    selected.activeConnections = Math.max(0, selected.activeConnections - 1);
    const elapsed = Date.now() - startTime;
    entry.status = 'error';
    entry.processingTimeMs = elapsed;
    logRequestDone(requestId, selected, algorithm, elapsed, 'error');
    broadcast({ type: 'request_done', entry, servers: getServerStats() });
    res.status(502).json({ error: 'Bad Gateway', message: err.message });
  });
});

proxy.on('proxyRes', (proxyRes, req, res) => {
  const requestId = req.headers['x-request-id'];
  const entry = requestLog.find(e => e.requestId === requestId);
  if (entry) {
    const srv = SERVERS.find(s => s.id === entry.serverId);
    if (srv) srv.activeConnections = Math.max(0, srv.activeConnections - 1);
    entry.status = 'ok';
    if (srv) logRequestDone(requestId, srv, algorithm, entry.processingTimeMs || 0, 'ok');
    broadcast({ type: 'request_done', entry, servers: getServerStats() });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  printBanner();
});
