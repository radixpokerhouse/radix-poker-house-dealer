const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { generateShuffledDeck, dealHoleCards } = require('./deck');
const { generateChallenge, verifyPlayerOwnsSeat } = require('./auth');
const { startAutoDeal, getLastDeal } = require('./autodeal');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Radix Poker House dealer listening on :${PORT}`);
});

const wss = new WebSocketServer({ server });

// seat_number -> websocket connection
const seatSockets = new Map();
// sessionToken -> { seat, accountAddress, expiresAt }
const sessions = new Map();
const SESSION_TTL_MS = 60 * 60 * 1000;

app.get('/auth/challenge', (req, res) => {
  res.json({ challenge: generateChallenge() });
});

app.post('/auth/verify', async (req, res) => {
  const { signedChallenge, tableBadgeResource } = req.body;
  try {
    const { accountAddress, seat } = await verifyPlayerOwnsSeat({
      signedChallenge, tableBadgeResource,
    });
    const sessionToken = crypto.randomBytes(24).toString('hex');
    sessions.set(sessionToken, { seat, accountAddress, expiresAt: Date.now() + SESSION_TTL_MS });
    res.json({ sessionToken, seat });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'register') {
        const session = sessions.get(data.sessionToken);
        if (!session || session.expiresAt < Date.now()) {
          ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired session' }));
          ws.close();
          return;
        }
        seatSockets.set(session.seat, ws);
        ws.seat = session.seat;
        console.log(`Seat ${session.seat} authenticated and connected`);

        const cached = getLastDeal(session.seat);
        if (cached) {
          ws.send(JSON.stringify({ type: 'hole_cards', cards: cached.cards, community: cached.community }));
          console.log(`Resent cached deal to seat ${session.seat}`);
        }
      }
    } catch (e) {
      console.error('Bad message:', e.message);
    }
  });
  ws.on('close', () => {
    if (ws.seat) seatSockets.delete(ws.seat);
  });
});

app.post('/deal', (req, res) => {
  const { seedHex, orderedSeats } = req.body;
  if (!seedHex || !orderedSeats) {
    return res.status(400).json({ error: 'seedHex and orderedSeats required' });
  }
  const seedBytes = Buffer.from(seedHex, 'hex');
  const deck = generateShuffledDeck(seedBytes);
  const { holeCards, community } = dealHoleCards(deck, orderedSeats);

  for (const seat of orderedSeats) {
    const ws = seatSockets.get(seat);
    if (ws) {
      ws.send(JSON.stringify({ type: 'hole_cards', cards: holeCards[seat], community }));
    } else {
      console.warn(`Seat ${seat} not connected, cards not delivered`);
    }
  }
  res.json({ ok: true, dealt: orderedSeats.length });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const GENESIS_TABLE_COMPONENT = 'component_tdx_2_1cz8fw07hh03e8mn9ssu2h0vp9t3hnysjpedfhma2tc3q23a7mfkjql';
startAutoDeal(GENESIS_TABLE_COMPONENT, seatSockets);
