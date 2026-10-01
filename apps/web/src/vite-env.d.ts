interface ImportMetaEnv {
  /** Privy app id (public). Without it (local dev) the game runs without sign-in. */
  readonly VITE_PRIVY_APP_ID?: string;
  /** Where the game API lives (production: https://api.nyxeron.xyz); empty = same origin. */
  readonly VITE_API_BASE?: string;
  /** The multiplayer relay (production: wss://api.nyxeron.xyz/ws); empty = same origin /ws. */
  readonly VITE_RELAY_URL?: string;
}
