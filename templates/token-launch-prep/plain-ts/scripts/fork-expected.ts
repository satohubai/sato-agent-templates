// What the fork check expects at Base block 51800000. These are the token
// addresses the Clanker v4 factory returned when each deploy was simulated
// there (CREATE2: they depend on the token's constructor arguments, the admin
// and the salt, not on the block). Re-read them with `--mode fork --record`
// when config.json or a scenario changes.

export const EXPECTED = {
  config_token_address: "0xe5BB4Cc592F55D913f4f1990D02403D03DD80B31",
  scenario_token_addresses: {
    "custom-salt.input.json": "0xb8632b3e31EdA5ed080267a1A0f99A753ae76D17",
    "project-preset.input.json": "0xB2A0fBfa9c686070c752dFEDbDd273755f457884",
  } as Record<string, string>,
} as const;
