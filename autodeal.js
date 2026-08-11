const { GatewayApiClient, RadixNetwork } = require('@radixdlt/babylon-gateway-api-sdk');
const { generateShuffledDeck, dealHoleCards } = require('./deck');

const gatewayApi = GatewayApiClient.initialize({
  networkId: RadixNetwork.Stokenet,
  applicationName: 'Radix Poker House Dealer',
});

// Tracks which hands we've already dealt for, so we don't re-deal on
// every poll (keyed by a fingerprint of the current commit round).
const dealtHands = new Set();

async function pollTable(componentAddress, seatSockets) {
  try {
    const resp = await gatewayApi.state.innerClient.stateEntityDetails({
      stateEntityDetailsRequest: { addresses: [componentAddress] },
    });
    const fields = resp.items[0]?.details?.state?.fields;
    if (!fields) return;

    const getField = (name) => fields.find((f) => f.field_name === name);
    const handActive = getField('hand_active')?.value;
    const activeSeats = getField('active_seats')?.entries?.map((e) => Number(e.key.value)) || [];
    const foldedSeats = new Set(
      (getField('folded_seats')?.entries || [])
        .filter((e) => e.value.value === true)
        .map((e) => Number(e.key.value))
    );
    const revealedSeats = (getField('seed_reveals')?.entries || []).map((e) => Number(e.key.value));

    if (!handActive) return;

    const seatsNeedingReveal = activeSeats.filter((s) => !foldedSeats.has(s));
    const allRevealed = seatsNeedingReveal.length > 0 &&
      seatsNeedingReveal.every((s) => revealedSeats.includes(s));

    const fingerprint = `${componentAddress}:${revealedSeats.sort().join(',')}`;
    if (!allRevealed || dealtHands.has(fingerprint)) return;

    dealtHands.add(fingerprint);

    // Compute combined_seed the same way the contract does: concatenate
    // revealed secrets in the order they were revealed (map insertion order).
    const revealEntries = getField('seed_reveals').entries;
    const buffers = revealEntries.map((e) =>
      Buffer.from(e.value.elements.map((x) => Number(x.value)))
    );
    const combined = Buffer.concat(buffers);

    const blake2b = require('blakejs').blake2b;
    const seedHash = Buffer.from(blake2b(combined, undefined, 32));

    const deck = generateShuffledDeck(seedHash);
    const orderedSeats = [...activeSeats].sort((a, b) => a - b);
    const { holeCards, community } = dealHoleCards(deck, orderedSeats);

    for (const seat of orderedSeats) {
      const ws = seatSockets.get(seat);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'hole_cards', cards: holeCards[seat], community }));
      }
    }
    console.log(`Dealt cards for hand at ${componentAddress}, seats: ${orderedSeats.join(',')}`);
  } catch (e) {
    console.error('pollTable error:', e.message);
  }
}

function startAutoDeal(componentAddress, seatSockets, intervalMs = 4000) {
  setInterval(() => pollTable(componentAddress, seatSockets), intervalMs);
  console.log(`Auto-deal polling started for ${componentAddress}`);
}

module.exports = { startAutoDeal };
