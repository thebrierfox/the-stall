// ens-lookup.js
//
// ENS name ↔ Ethereum address resolution — forward and reverse.
// Forward: name.eth → address, avatar, social links, content hash.
// Reverse: 0x{address} → primary ENS name + same profile data.
//
// Seam: skills.onesource.io/api/chain/ens — 373 payers, $0.005/call.
// STALL price: $0.031 (20% undercut). Upstream: api.ensdata.net (free, no auth).

const ENS_API = "https://api.ensdata.net";
const UA = "the-stall/3.76 (https://intuitek.ai)";
const TIMEOUT = 10000;

export default {
  name: "ens-lookup",
  price: "$0.059",

  description:
    "ENS name ↔ Ethereum address resolution. Forward: pass a .eth name to get the address, avatar, and social profile records. Reverse: pass a 0x address to get its primary ENS name and profile. Returns address, ens_primary, avatar_url, description, twitter, github, discord, telegram, url, and content_hash.",

  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "ENS name (e.g. 'vitalik.eth') for forward lookup, or 0x Ethereum address for reverse lookup.",
      },
    },
    required: [],
    additionalProperties: false,
  },

  outputSchema: {
    type: "object",
    properties: {
      input:         { type: "string",  description: "Normalized input (name or address)." },
      address:       { type: "string",  description: "Resolved Ethereum address (null if not linked)." },
      ens_primary:   { type: "string",  description: "Primary ENS name for this address." },
      resolver:      { type: "string",  description: "ENS resolver contract address." },
      avatar_url:    { type: "string",  description: "Avatar image URL." },
      content_hash:  { type: "string",  description: "IPFS/IPNS content hash (for decentralised sites)." },
      description:   { type: "string"  },
      url:           { type: "string"  },
      twitter:       { type: "string"  },
      github:        { type: "string"  },
      discord:       { type: "string"  },
      telegram:      { type: "string"  },
      reddit:        { type: "string"  },
      email:         { type: "string"  },
      found:         { type: "boolean", description: "False when the name is not registered or has no linked address." },
      generated_at:  { type: "string"  },
    },
  },

  async handler(query) {
    const raw = (query.name || "vitalik.eth").trim();

    const input = raw.toLowerCase();

    const resp = await fetch(`${ENS_API}/${encodeURIComponent(input)}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT),
    });

    const body = await resp.json();

    if (body.error || resp.status === 404) {
      return {
        input: raw,
        address:      null,
        ens_primary:  null,
        resolver:     null,
        avatar_url:   null,
        content_hash: null,
        description:  null,
        url:          null,
        twitter:      null,
        github:       null,
        discord:      null,
        telegram:     null,
        reddit:       null,
        email:        null,
        found: false,
        generated_at: new Date().toISOString(),
      };
    }

    return {
      input:        raw,
      address:      body.address       || null,
      ens_primary:  body.ens_primary   || body.ens || null,
      resolver:     body.resolverAddress || null,
      avatar_url:   body.avatar_url    || body.avatar || null,
      content_hash: body.contentHash   || null,
      description:  body.description   || null,
      url:          body.url           || null,
      twitter:      body.twitter       || null,
      github:       body.github        || null,
      discord:      body.discord       || null,
      telegram:     body.telegram      || null,
      reddit:       body.reddit        || null,
      email:        body.email         || null,
      found: true,
      generated_at: new Date().toISOString(),
    };
  },
};
