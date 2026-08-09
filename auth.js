require('isomorphic-fetch');
const { Rola } = require('@radixdlt/rola');
const { GatewayApiClient, RadixNetwork } = require('@radixdlt/babylon-gateway-api-sdk');
const crypto = require('crypto');

const DAPP_DEFINITION_ADDRESS = 'account_tdx_2_12ynl5t4pp7263sz5ynukgex92zk44092gq0d6423wyml8vv3cqtvh9';
const EXPECTED_ORIGIN = 'http://localhost:3000';

const { verifySignedChallenge } = Rola({
  networkId: RadixNetwork.Stokenet,
  applicationName: 'Radix Poker House',
  dAppDefinitionAddress: DAPP_DEFINITION_ADDRESS,
  expectedOrigin: EXPECTED_ORIGIN,
});

const gatewayApi = GatewayApiClient.initialize({
  networkId: RadixNetwork.Stokenet,
  applicationName: 'Radix Poker House Dealer',
});

const pendingChallenges = new Map();
const CHALLENGE_TTL_MS = 2 * 60 * 1000;

function generateChallenge() {
  const challenge = crypto.randomBytes(32).toString('hex');
  pendingChallenges.set(challenge, { createdAt: Date.now() });
  return challenge;
}

function consumeChallenge(challenge) {
  const entry = pendingChallenges.get(challenge);
  pendingChallenges.delete(challenge);
  if (!entry) return false;
  return (Date.now() - entry.createdAt) < CHALLENGE_TTL_MS;
}

async function verifyPlayerOwnsSeat({ signedChallenge, tableBadgeResource }) {
  const challengeValid = consumeChallenge(signedChallenge.challenge);
  if (!challengeValid) {
    throw new Error('Challenge invalid or expired');
  }

  const result = await verifySignedChallenge(signedChallenge);
  if (!result.isValid) {
    throw new Error('Signature verification failed');
  }

  const accountAddress = signedChallenge.address;

  // Step 1: find the vault holding this resource in the account
  const vaultResponse = await gatewayApi.state.innerClient.entityNonFungibleResourceVaultPage({
    stateEntityNonFungibleResourceVaultsPageRequest: {
      address: accountAddress,
      resource_address: tableBadgeResource,
    },
  });
  const vault = vaultResponse.items?.[0];
  if (!vault) {
    throw new Error('Account does not own any badge for this table');
  }

  // Step 2: list the NFT ids in that vault
  const idsResponse = await gatewayApi.state.innerClient.entityNonFungibleIdsPage({
    stateEntityNonFungibleIdsPageRequest: {
      address: accountAddress,
      vault_address: vault.vault_address,
      resource_address: tableBadgeResource,
    },
  });

  const ownedIds = idsResponse.items || [];
  if (ownedIds.length === 0) {
    throw new Error('Account does not own any badge for this table');
  }

  // Check each owned NFT's data for a matching seat_number
  const dataResponse = await gatewayApi.state.innerClient.nonFungibleData({
    stateNonFungibleDataRequest: {
      resource_address: tableBadgeResource,
      non_fungible_ids: ownedIds,
    },
  });

  let ownedSeat = null;
  for (const item of dataResponse.non_fungible_ids || []) {
    const seatField = item.data?.programmatic_json?.fields?.find(
      (f) => f.field_name === 'seat_number'
    );
    if (seatField) {
      ownedSeat = Number(seatField.value);
      break;
    }
  }

  if (ownedSeat === null) {
    throw new Error('Could not read seat number from owned badge');
  }

  return { accountAddress, seat: ownedSeat };
}

module.exports = { generateChallenge, verifyPlayerOwnsSeat };

// Genesis Table (Stokenet)
// component: component_tdx_2_1cqrdwav7ql8stvsq8l85z9yn95s274ee6r3d4zt72xg402fh342q5p
// badge resource: resource_tdx_2_1n2kjrw7lhld0cq0l8ke350854ju7p7jzsteyeddyc029ww9wncapqj
