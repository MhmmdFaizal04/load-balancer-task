const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

const SERVER_ID = process.env.SERVER_ID || 'server-unknown';
const PORT = process.env.PORT || 3001;

// ─── Color codes for terminal output ────────────────────────────────────────
const COLORS = {
  reset:  '\x1b[0m',
  bright: '\x1b[1m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  magenta:'\x1b[35m',
  blue:   '\x1b[34m',
  red:    '\x1b[31m',
};

const SERVER_COLOR = {
  'server-1': COLORS.cyan,
  'server-2': COLORS.green,
  'server-3': COLORS.magenta,
};

function log(msg) {
  const color = SERVER_COLOR[SERVER_ID] || COLORS.yellow;
  const ts = new Date().toISOString();
  console.log(`${color}${COLORS.bright}[${SERVER_ID}]${COLORS.reset} ${COLORS.yellow}${ts}${COLORS.reset} ${msg}`);
}

// ─── Active connection tracker ───────────────────────────────────────────────
let activeConnections = 0;
let totalRequests = 0;

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', serverId: SERVER_ID, activeConnections, totalRequests });
});

// Main endpoint – load balancer forwards requests here
app.get('/ping', (req, res) => {
  activeConnections++;
  totalRequests++;
  const requestId = req.headers['x-request-id'] || uuidv4();

  log(`📥 Received request | requestId=${requestId} | activeConnections=${activeConnections}`);

  // Simulate small processing delay (20-80ms) so Least Connection is observable
  const delay = Math.floor(Math.random() * 60) + 20;
  setTimeout(() => {
    activeConnections--;
    log(`📤 Completed request | requestId=${requestId} | delay=${delay}ms | activeConnections=${activeConnections}`);
    res.json({
      serverId: SERVER_ID,
      requestId,
      timestamp: new Date().toISOString(),
      activeConnections,
      totalRequests,
      processingTimeMs: delay,
    });
  }, delay);
});

// Expose live stats (polled by load balancer for Least Connection)
app.get('/stats', (req, res) => {
  res.json({ serverId: SERVER_ID, activeConnections, totalRequests });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const color = SERVER_COLOR[SERVER_ID] || COLORS.yellow;
  console.log(`\n${color}${COLORS.bright}╔══════════════════════════════════════╗${COLORS.reset}`);
  console.log(`${color}${COLORS.bright}║  ${SERVER_ID.toUpperCase()} started on port ${PORT}   ║${COLORS.reset}`);
  console.log(`${color}${COLORS.bright}╚══════════════════════════════════════╝${COLORS.reset}\n`);
});
