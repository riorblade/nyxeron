interface ImportMetaEnv {
  /** Where the game API lives (production: https://api.nyxeron.xyz); empty = same origin. */
  readonly VITE_API_BASE?: string;
  /** The multiplayer relay (production: wss://api.nyxeron.xyz/ws); empty = same origin /ws. */
  readonly VITE_RELAY_URL?: string;
}
