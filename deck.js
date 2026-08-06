const { blake2b } = require('blakejs');

// Must mirror src/lib.rs generate_shuffled_deck() EXACTLY, or the deck
// the dealer computes won't match what the contract's combined_seed proves.
function generateShuffledDeck(seedBytes) {
  const deck = [];
  for (let suit = 0; suit < 4; suit++) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ rank, suit });
    }
  }

  let counter = 0;
  function drawU32() {
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32LE(counter, 0);
    counter++;
    const input = Buffer.concat([Buffer.from(seedBytes), counterBuf]);
    const h = blake2b(input, undefined, 32); // blake2b-256, matches Radix's hash()
    return (h[0] | (h[1] << 8) | (h[2] << 16) | (h[3] << 24)) >>> 0;
  }

  for (let i = deck.length - 1; i >= 1; i--) {
    const r = drawU32() % (i + 1);
    [deck[i], deck[r]] = [deck[r], deck[i]];
  }
  return deck;
}

function dealHoleCards(deck, orderedSeats) {
  const holeCards = {};
  let idx = 0;
  for (const seat of orderedSeats) {
    holeCards[seat] = [deck[idx], deck[idx + 1]];
    idx += 2;
  }
  idx += 1; // burn card, matches contract
  const community = deck.slice(idx, idx + 5);
  return { holeCards, community };
}

module.exports = { generateShuffledDeck, dealHoleCards };
