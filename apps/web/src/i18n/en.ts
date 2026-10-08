import type {
  ActionResult,
  GameEvent,
  Objective,
  Outcome,
} from "@nyxeron/core";

export const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
/** Night minute 0 = 22:00. */
export const clock = (minute: number) => {
  const total = (22 * 60 + minute) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

/** Minutes → "1:20". */
export const duration = (m: number) =>
  `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

export const genres: Record<string, string> = {
  edm: "EDM",
  hiphop: "Hip-hop",
  house: "House",
  techno: "Techno",
  rnb: "R&B",
};

export const segmentNames: Record<string, string> = {
  locals: "Locals",
  community: "Community",
  urban25: "Urban 25+",
  genZ: "Gen-Z",
  premium: "Premium",
};

type FailReason = Extract<ActionResult, { ok: false }>["reason"];
const reasons: Record<FailReason, (short?: number) => string> = {
  notEnoughCoin: (s) => `Not enough NYX Points: ${fmt(s ?? 0)} short`,
  storageFull: (s) =>
    `Stock room full: room for ${fmt(s ?? 0)} more (upgrade storage in Build)`,
  notEnoughEnergy: () => "Not enough CEO Energy",
  notEnoughRep: (s) => `Not enough Reputation: ${fmt(s ?? 0)} short`,
  levelLocked: () => "Locked at your current level",
  maxLevel: () => "Already at the top level",
  invalidQty: () => "Invalid quantity",
  invalidPrice: () => "Invalid price",
  alreadyBooked: () => "A DJ is already booked tonight",
  alreadyActive: () => "Already used",
  noStaff: () => "You need security staff for that",
  invalidTarget: () => "Nothing to do there",
  wrongPhase: () => "Not available right now",
};
export const reasonText = (r: FailReason, short?: number) => reasons[r](short);

export const en = {
  /** Classic mode's play currency (farmed now, for the token launch later). Real money is Credit. */
  unit: "NP",
  title: "NYXERON",
  subtitle: "Nightclub Empire",
  tagline: "Plan by day. Survive the night.",

  /** The only outbound link the client shows. */
  social: {
    x: "https://x.com/nyxeron_xyz",
    follow: "Follow @nyxeron_xyz",
  },
  landing: {
    docTitle: "NYXERON · Nightclub Empire",
    main: ["Nyxeron", "Nightlife"],
    alt: ["Open the", "Doors"],
    crew: ["Sixty", "Nights"],
    // "Nyx, goddess of the night": the name comes from Greek myth.
    greek: ["ΝΥΞ", "·", "ΘΕΑ ΤΗΣ ΝΥΧΤΑΣ"],
    zone: ["Veltra City", "Local Time"],
    enter: "Enter",
    settings: "Settings",
    followX: "Follow on 𝕏",
    contactNew: "Open the doors",
    lede: "Veltra City, 22:00. One token booth, ten thousand NYX Points and a permit that runs out in thirty days. Stock the token desk, book the DJ, keep the inspectors sweet, and build it into the venue this city can't stop talking about.",
    copyright: "©2026 NYXERON",
    scroll: "Scroll down",
    statement: "From one token booth to a premium venue in sixty nights.",
    left: "Five venues, one ladder. Every level unlocks a new system: staff, live music, DJs, security, whale tables.",
    right:
      "No choice is free. More security means a slower door, cheap stock sells out by midnight, and one bad promo brings the inspector.",
    bottom: ["Plan by day", "Survive the night", "Own the city"],
    newCareer: "Enter",
    soundOn: "Sound on",
    soundOff: "Sound off",
  },

  auth: {
    title: "Sign in to play",
    why: "Your club, wallet and night-outs follow your account. Sign in with email or Google; we create your BNB Chain wallet for you.",
    signIn: "Sign in",
    modalTitle: "Sign in to NYXERON",
    loading: "Loading your account…",
    back: "Back to the landing page",
    signOut: "Sign out",
    bannedTitle: "Account suspended",
    banned: (reason: string) =>
      `This account can't play right now${reason ? `: ${reason}` : ""}. Contact support if you think this is a mistake.`,
    announcement: "Announcement",
    wallet: "BNB Chain",
    walletPending: "Creating your wallet…",
    copied: "Address copied",
    syncFailed: "Couldn't save to your account; showing what the server has.",
    server: {
      checking: "checking…",
      ok: "✓ verified",
      mismatch: "mismatch",
      failed: "server check failed",
    },
    serverHint:
      "The game server checked your sign-in with Privy (it, not the browser, is trusted for rewards).",
  },

  dashboard: {
    title: "Dashboard",
    kicker: "Veltra City · tonight",
    anon: "Guest",
    namePlaceholder: "Your name",
    nameLabel: "Player name",
    avatar: "Your look",
    men: "Men",
    women: "Women",
    avatarPick: (n: number) => `Avatar ${n}`,
    wallet: "NYX Points",
    walletNote:
      "Classic mode's play currency, farmed for the NYX launch. Not real money.",
    refill: "Claim starter wallet",
    nights: "Nights out",
    totalPnl: "Total P&L",
    bestPnl: "Best night",
    portfolio: "Portfolio",
    portfolioEmpty: "Nothing yet. Tokens you buy as a guest land here.",
    paid: (c: string) => `paid ${c} NP`,
    club: "Your clubs",
    noClub: "No club yet. Rent a venue as CEO.",
    clubCount: (venues: number, practice: number) =>
      [
        venues ? `${venues} city venue${venues === 1 ? "" : "s"}` : "",
        practice ? `${practice} Classic club${practice === 1 ? "" : "s"}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
    enter: "Enter game",
    chooseRole: "Choose your role",
    back: "Back",
    landing: "Landing page",
    roles: {
      ceo: {
        title: "CEO",
        tagline: "Host the night",
        desc: "Run the club: stock tokenized stocks, set the prices, book the DJ, hire the crew and keep the inspectors happy. Guests' buys are your revenue.",
      },
      dj: {
        title: "DJ",
        tagline: "Play the room",
        desc: "Two decks, a mixer, effects and a sampler. Practise your transitions here; CEOs will be able to book you for their events when multiplayer goes live.",
      },
      guest: {
        title: "Guest",
        tagline: "Party and trade",
        desc: "Walk into a live event, pay the door, and trade tokenized stocks at the desk while the DJ moves the market. Walk out richer, or not.",
      },
    },
    ceoTitle: "CEO · your clubs",
    ceoNote:
      "Classic: grow your club from a token booth, level by level, and farm NYX Points.",
    noClubs:
      "No club yet. Start a Classic club: a token booth first, then level by level.",
    tagCity: "City",
    tagPractice: "Classic",
    manage: "Manage",
    shopOpen: "shop open",
    shopClosed: "shop closed",
    daysLeft: (d: number) => `${d} day${d === 1 ? "" : "s"} of rent left`,
    partiesPlanned: (n: number) => `${n} part${n === 1 ? "y" : "ies"} planned`,
    dayOf: (d: number) => `Day ${d} of 60`,
    outcome: {
      victory: "Won",
      survived: "Finished",
      defeat: "Closed down",
    } as Record<string, string>,
    open: "Open",
    close: "Close club",
    closeConfirm: "Delete this club for good?",
    closeYes: "Delete",
    closeNo: "Keep",
    rentNew: "Rent a new venue",
    rentNewDesc:
      "A real venue in the shared city: shop, parties, other players",
    newPractice: "New Classic club",
    newPracticeDesc: "Start at a token booth and climb level by level",
    clubsFull: "Four Classic clubs is the limit: close one to start another",
    cityTitle: "City · coming soon",
    cityDesc: "Rent a real venue with Credit (real money). Real guests only.",
    eventsTitle: "Guest · live events",
    eventsNote:
      "Hosted by AI CEOs for now. When multiplayer goes live, these are other players' clubs.",
    hostedBy: "Hosted by AI CEO",
    live: "Live",
    cover: (c: string) => `Door ${c} NP`,
    join: "Join",
    menu: (n: number) => `${n} tokens on the desk`,
  },

  live: {
    room: (code: string) => `Room ${code}`,
    connecting: "Connecting to the club…",
    closed: "The club has closed.",
    error: (code: string) =>
      code === "room_not_found"
        ? "No club with that code (it may have closed)."
        : code === "room_full"
          ? "The club is full."
          : `Couldn't join (${code}).`,
    hostAway: "The CEO lost connection. Hang on, the club is still here…",
    refused: (why: string) => `The door said no: ${why}`,
    doorsClosed:
      "Doors open at 22:00. You're on the list: you walk in the moment the CEO opens the club.",
    atTheDoor: "At the door…",
    joinTitle: "Join a live club",
    joinHint: "Got a code from a CEO? Enter it to walk into their club.",
    code: "Room code",
    join: "Walk in",
    openTitle: "Open to players",
    openHint:
      "Players join with this code (or the link) and party in your club: their buys are your revenue.",
    open: "Open club to players",
    opening: "Opening…",
    copyLink: "Copy link",
    visibility: "Who can come in",
    public: "Public",
    private: "Invite only",
    publicHint: "Listed for every guest under Clubs open now.",
    privateHint: "Hidden from the list: only players with your link get in.",
    copied: "Link copied",
    close: "Close room",
    players: (n: number) => `${n} player${n === 1 ? "" : "s"} connected`,
    inside: "inside",
    waiting: "waiting",
    kick: "Kick",
    none: "No one yet. Share the code.",
    djTaken: "This club already has a DJ on the decks.",
    djJoinTitle: "Play a live club",
    djJoinHint:
      "A CEO invited you to DJ? Enter their room code: your decks become the club's music, everyone hears your mix.",
    djJoin: "Take the decks",
    djLive: (name: string) => `DJ ${name} is on the decks`,
  },

  city: {
    title: "City · rent a venue",
    desc: "Rent a real venue in the shared city by the week. Run a shop, host parties.",
    rentTitle: "Rent a new venue",
    gone: "This venue isn't yours any more (the lease ended).",
    rentNote:
      "Paid weekly in Credit (real money). Any venue runs a shop that resells real stock while you're away. From Level 3 you can host parties.",
    free: (n: number, of: number) => `${n} of ${of} free`,
    perWeek: (c: string) => `${c} Credit / week`,
    clubName: "Venue name",
    weeks: (n: number) => `${n} week${n === 1 ? "" : "s"}`,
    rent: (c: string) => `Rent · ${c} Credit`,
    full: "All taken",
    yours: "Your venue",
    until: (d: string) => `Rented until ${d}`,
    extend: (c: string) => `Extend 1 week · ${c} Credit`,
    shop: "Shop",
    shopOpen: "Open: other players can buy",
    storage: (n: number, of: number) => `Storage ${n} / ${of}`,
    inStock: (n: number) => `${n} in stock`,
    cost: (c: string) => `stock costs ${c} C`,
    shelf: "Your price",
    maxPrice: (c: string) => `max ${c}`,
    restock: (n: number, c: string) => `Restock +${n} · ${c} C`,
    margin: (c: string) => `+${c} Credit each`,
    floor: (min: string, max: string) => `${min}–${max}`,
    menuNote:
      "Real stock from the platform's warehouse, at your price in Credit per unit (0.001 share). You hold no stock: each sale pays you the margin. Blank = not sold.",
    credit: (c: string) => `${c} Credit`,
    venueLevel: (lv: number, name: string) => `Level ${lv} · ${name}`,
    enter: "Enter club",
    enterHint: "Starts a public party now",
    scheduleLater: "Schedule",
    daysLeft: (d: number) =>
      d <= 1 ? "Last day of rent" : `${d} days of rent left`,
    extendShort: (c: string) => `Extend · ${c} Credit`,
    shopLine: (open: boolean, n: number) =>
      open
        ? `Shop open · ${n} on the menu · sells while you're away`
        : `Shop closed · ${n} on the menu`,
    manage: "Manage",
    done: "Done",
    emptyShelf: "Your menu is empty. Set a price to start selling.",
    addStock: "Add a stock",
    partyLocked: "Parties open at Level 3. Until then your shop sells for you.",
    savePrices: "Save prices",
    outOfRange: "A price is outside its range (wholesale to 3×).",
    parties: "Parties",
    partiesLocked:
      "Parties need a Level 3 venue or bigger. Smaller venues sell.",
    when: "Starts",
    minutes: "Minutes",
    partyTitle: "Title (optional)",
    schedule: "Schedule party",
    noParties: "No parties scheduled.",
    hostNow: "Host now",
    cancel: "Cancel",
    liveNow: "Live now",
    openNow: "Clubs open now",
    noneOpen:
      "No club is open right now. A club opens to guests while its CEO is in it; scheduled parties are below.",
    nightOn: "night is on",
    doorsSoon: "doors open at 22:00",
    inside: (n: number) => `${n} player${n === 1 ? "" : "s"} in`,
    join: "Join",
    upcoming: "Upcoming parties",
    noUpcoming: "Nothing scheduled yet.",
    shops: "Open shops",
    noShops: "No shops open right now.",
    buy: "Buy",
    by: (owner: string) => `by ${owner || "a CEO"}`,
    at: (club: string, level: string) => `${club} · ${level}`,
    rented: "Venue rented",
    renamed: "Venue renamed",
    rename: "Rename",
    warehouse: (n: number) =>
      n ? `platform has ${n}` : "sold out at the platform",
    stocked: "Stock delivered",
    saved: "Shop updated",
    bought: (n: number, t: string) => `Bought ${n} ${t}`,
    scheduled: "Party scheduled",
    cancelled: "Party cancelled",
    failed: (code: string) =>
      ({
        rejected: "Not enough Coin, storage or stock for that.",
        sold_out: "The platform's warehouse doesn't have that many right now.",
        conflict: "That's taken (or you already rent a venue).",
        no_lease: "Rent a venue first.",
        city_closed: "The city opens with Credit (real money). Coming soon.",
        bad_request: "Check the values.",
        banned: "This account is suspended.",
      })[code] ?? `Couldn't do that (${code}).`,
    signIn: "Sign in to rent a venue.",
    loading: "Loading the city…",
  },

  events: {
    title: "Events",
    locked:
      "Events start at a Level 3 venue (bar & live music) or bigger. Smaller venues sell.",
    when: "Date and time",
    minutes: "Length",
    minutesOpt: (m: number) => `${m} min`,
    who: "Who can come",
    public: "Public",
    private: "Private",
    publicHint:
      "Public: listed for every player. Share the invite link too, if you like.",
    privateHint:
      "Private: only players with your invite link can see it and come in.",
    titleLabel: "Event name",
    titlePlaceholder: "Event name (optional)",
    schedule: "Schedule",
    none: "No events planned for this club yet.",
    live: "Live",
    going: (n: number) => `${n} going`,
    copyInvite: "Invite link",
    openClub: "Open club",
    copied: "Invite link copied",
    cancel: "Cancel",
    now: "starting now",
    inTime: (x: string) => `in ${x}`,
    onNow: "on now",
    feedTitle: "Events",
    feedEmpty:
      "No events yet. When a CEO schedules one (or invites you), it shows here.",
    invited: "Invite",
    by: (owner: string) => `by ${owner || "a CEO"}`,
    join: "Join",
    goingAsk: "I'm going",
    goingYes: "Going ✓",
    liveBanner: (host: string) =>
      `is live: ${host || "the CEO"} opened the club.`,
    joinNow: "Join now",
    scheduled: "Event scheduled",
    cancelled: "Event cancelled",
    invitedToast: "Event added to your list",
    failed: (code: string) =>
      ({
        rejected:
          "Not possible: check the venue level, the lease dates or your event limit.",
        conflict: "That overlaps another event at this club.",
        not_found: "That event isn't available (cancelled, over, or private).",
        started:
          "It has started: guests may have bought, so it can't be cancelled now.",
        bad_request: "Check the date, time and length.",
        no_lease: "That venue isn't yours any more.",
      })[code] ?? `Couldn't do that (${code}).`,
  },

  gig: {
    left: (d: string) => `${d} of your set left`,
    crowd: "Crowd",
    fee: "Fee",
    pause: "Pause the night",
    resume: "Resume",
    leave: "Leave the gig",
    stay: "Keep playing",
    showDecks: "Show the decks",
    leaveTitle: "Walk off the decks?",
    leaveText: "Leave before 04:00 and the club doesn't pay the fee.",
    doneTitle: "04:00 · Lights up",
    doneText: "That's your set. The club pays your fee.",
    peak: "Peak energy",
    collect: "Collect fee",
    invites: "Gig invites",
    invitesNote:
      "Clubs hosted by AI CEOs for now. With multiplayer, real CEOs send these.",
    slot: (from: string) => `Your set: ${from}–04:00`,
    accept: "Accept & play",
    studio: "Practice in the studio",
    studioDesc: "Two decks, the mixer, pads and your planned sets",
    gigs: (n: number) => `${n} gig${n === 1 ? "" : "s"} played`,
  },

  guest: {
    doorsClosed: "Doors closed",
    live: "LIVE",
    cash: "Cash",
    holdings: "Holdings",
    value: "Value",
    pnl: "Tonight",
    desk: "Token desk",
    deskNote:
      "Buy at the live price. What you buy is yours: it goes home to your portfolio.",
    held: (n: number) => `${n} held`,
    left: (n: number) => `${n} left`,
    buy: (q: number) => `Buy ${q}`,
    leave: "Leave the club",
    leaveTitle: "Leave the club?",
    leaveWarn:
      "Your tokens go home with you to your portfolio, and your cash back to your wallet.",
    stay: "Stay",
    closing: "04:00 · Lights up",
    summary: "Your night",
    cashLeft: "Cash to wallet",
    tokensHome: "Tokens to portfolio (live value)",
    broughtIn: "Brought in",
    toDashboard: "Back to dashboard",
    soldOut: "Sold out",
    you: "YOU",
    bought: (q: number, ticker: string, cost: number) =>
      `Bought ${q} ${ticker} · ${fmt(cost)} NP`,
  },

  intro: {
    doors: "Doors open",
    skip: "Skip",
    dontShow: "Don't show again",
  },

  nav: {
    home: "Home",
    homeTitle: "Back to the main menu (progress is saved)",
    saved: "Club saved. Find it under CEO · your clubs.",
  },

  menu: {
    back: "Back",
  },

  setup: {
    title: "Club Setup",
    name: "Club name",
    namePlaceholder: "Nyx Booth",
    genre: "Main music genre",
    difficulty: "Difficulty",
    difficulties: { easy: "Easy", normal: "Normal", hard: "Hard" } as Record<
      string,
      string
    >,
    start: "Start Career",
    venue: "Starting venue",
    venueNote:
      "Unlocked for your account: skip the climb and open at a bigger venue.",
  },

  hud: {
    day: (d: number) => `Day ${d}`,
    coin: "NP",
    rep: "Rep",
    hype: "Hype",
    safety: "Safety",
    energy: "CEO Energy",
    violations: "Violations",
    permits: "Permits",
    level: (n: number, name: string) => `Lv ${n} · ${name}`,
    /** Tap a stat on the top bar: what it is, what it does, how it moves, and what moved it lately. */
    infoHint: "Tap for details",
    whatItDoes: "What it does",
    howItMoves: "How it moves",
    recently: "Recently",
    nothingYet: "No changes yet.",
    when: (day: number, time?: string) =>
      `Day ${day}${time ? ` · ${time}` : ""}`,
    lastNight: (day: number, revenue: number, profit: number) =>
      `Night of day ${day}: took in ${fmt(revenue)} NP, ${profit >= 0 ? "profit" : "loss"} ${fmt(Math.abs(profit))} NP after costs and tax.`,
  },

  statInfo: (k: {
    bankruptDays: number;
    nextRep: number | null;
    victoryRep: number;
    good: number;
    bad: number;
    repGain: [number, number];
    repLoss: number;
    fightRep: number;
    fightSafety: number;
    promoRep: number;
    shutdownRep: number;
    hypeDecay: number;
    safetyRecovery: number;
    safetyLossPct: number;
    riskyBelow: number;
    riskyPct: number;
    perGuard: number;
    energyPerDay: number;
    maxViolations: number;
    fine: number;
    missingPct: number;
  }) => ({
    coin: {
      what: "NYX Points (NP): your club's money in Classic, farmed for the NYX launch. You spend it on stock, staff, rent, DJs, promos and upgrades; guests bring it in at the door, the bar and the tables.",
      does: [
        `Below 0 for ${k.bankruptDays} days in a row: bankrupt, game over.`,
        "Pays for the next venue (together with reputation).",
      ],
      moves: [
        "Price tokens close to the market and keep the popular ones in stock.",
        "A DJ the crowd likes keeps guests happy, and happy guests buy more.",
        "Fill tables and VIP: Guest Relations and house rules.",
        "Avoid fines: keep every permit valid.",
      ],
    },
    rep: {
      what: "How the city rates your club, 0–100. Each star is 20 points.",
      does: [
        "More guests every night.",
        "More table and VIP bookings.",
        k.nextRep != null
          ? `The next venue needs ${k.nextRep}.`
          : "You're at the top venue.",
        `Win: Level 5 with ${k.victoryRep} or more.`,
        "At 0: game over.",
      ],
      moves: [
        `End a night with average satisfaction ${k.good}+: +${k.repGain[0]} to +${k.repGain[1]}.`,
        `Average satisfaction under ${k.bad}: −${k.repLoss}.`,
        `Each fight: −${k.fightRep}.`,
        `A controversial promo that backfires: −${k.promoRep}.`,
        `Shut down for crowding without a crowd permit: −${k.shutdownRep}.`,
      ],
    },
    hype: {
      what: "Buzz about tonight, 0–100.",
      does: ["The biggest driver of how many guests come tonight."],
      moves: [
        `Fades by ${k.hypeDecay} every morning.`,
        "Promo posts in Social Media (1 CEO Energy each).",
        "Booking a DJ or a band brings their fans.",
        "A rival's promo takes some away.",
      ],
    },
    safety: {
      what: "How safe your club feels, 0–100.",
      does: [
        `An unsafe club loses walk-ins: up to −${k.safetyLossPct}% guests at 0.`,
        `Under ${k.riskyBelow}: inspectors are likelier to visit (${k.riskyPct}% a night).`,
      ],
      moves: [
        `Each fight: −${k.fightSafety}.`,
        `Recovers +${k.safetyRecovery} every morning.`,
        `Fights start when tilted guests outnumber security: hire 1 guard per ${k.perGuard} guests.`,
        "Hot (FOMO) tokens tilt guests faster.",
      ],
    },
    energy: {
      what: `Your own time as CEO: ${k.energyPerDay} actions a day.`,
      does: [
        "Each promo post costs 1. With none left you can't post until tomorrow.",
      ],
      moves: [`Refills to ${k.energyPerDay} every morning.`],
    },
    violations: {
      what: "Strikes against your license. They never go away.",
      does: [
        `${k.maxViolations} violations: license revoked, game over.`,
        `A failed inspection also costs a ${fmt(k.fine)} NP fine.`,
      ],
      moves: [
        "A failed inspection: a missing or expired permit, or underage guests let in without security at the door.",
        "Forcing the door open past capacity.",
      ],
    },
    permits: {
      what: "The licenses this venue needs to open.",
      does: [
        `With one missing, an inspector is likely (${k.missingPct}% a night): fine and a violation.`,
      ],
      moves: ["Renew them in the Permits room before they expire."],
    },
  }),

  office: {
    title: "Office",
    daytime: "Daytime",
    tabs: {
      stock: "Stock",
      talent: "Talent",
      promo: "Promo",
      staff: "Staff",
      rules: "House Rules",
      permits: "Permits",
      build: "Build",
      events: "Events",
    },
    lockedTab: (lv: number) => `Unlocks at Level ${lv}`,
    open: "Open Club",
    openKicker: "Let the night begin",
    back: "Back to the floor",
    backKicker: "The club is waiting",
    nightTime: "Club open",
    dayOnly: "Daytime only",
    nightBanner:
      "The club is open and the clock waits while you're up here. Promos you post now pull in extra guests for the rest of the night; staff and stock changes apply the moment you're back.",
    tabInfo: {
      stock: {
        title: "Stock Room",
        desc: "Stock tokenized stocks, pick a supplier and set your list prices. Tonight's market moves them.",
      },
      talent: {
        title: "Talent Agency",
        desc: "Book a DJ or a live band who fits tonight's crowd.",
      },
      promo: {
        title: "Social Media",
        desc: "Build hype before the doors open.",
      },
      staff: {
        title: "Staff Room",
        desc: "Brokers, security, hosts, guest relations and the MC: the people who make the night.",
      },
      rules: {
        title: "House Rules",
        desc: "Who gets in, and on what terms. Set by day; they hold until you change them.",
      },
      permits: {
        title: "Permit Office",
        desc: "Stay legal. Inspectors don't do warnings.",
      },
      events: {
        title: "Events",
        desc: "Plan a night, public or invite-only, and send the link. Guests join the moment you open the club.",
      },
      build: {
        title: "Empire Ladder",
        desc: "Grow from a booth to the city's premium venue.",
      },
    } as Record<string, { title: string; desc: string }>,
    capacity: (n: number) => `Capacity ${n}`,
    crowdWarning: (n: number) =>
      `About ${n} guests expected tonight. Above 150 inside without a Crowd permit, police may shut the night down (Permits tab). CEO Call "Close Door" can also cap the crowd.`,
    permitWarning: (names: string) =>
      `Missing or expired: ${names}. Inspectors come far more often (40% per night).`,
    expected: (lo: number, hi: number) => `Expected guests ${lo}–${hi}`,
    tonight: "Tonight",
    noDj: "No DJ",
    sealed: "Venue sealed tonight by the authorities",
  },

  storage: {
    label: "Stock room",
    value: (used: number, max: number) => `${fmt(used)} / ${fmt(max)}`,
    hint: "Stock on hand plus orders on the way. Upgrade in Build.",
  },

  stock: {
    supplier: "Supplier",
    autoRefill: "Auto-refill",
    autoRefillHint: (batch: number, at: number) =>
      `Orders ${batch} more from the corner store when a token drops to ${at}`,
    lead: (d: number) => (d === 0 ? "instant" : `${d} day${d > 1 ? "s" : ""}`),
    drink: "Token",
    inStock: "In stock",
    price: "Price",
    cost: "Unit cost",
    order: "Order",
    pending: "Incoming orders",
    arrives: (d: number) => `arrives Day ${d}`,
    emergency: "Emergency restock",
    need: "Tonight",
    needHint:
      "Forecast for tonight: expected guests × ~3 buys, spread over the menu",
    fill: "Fill to forecast",
    low: (name: string) => `${name} running low`,
  },

  bands: {
    title: "Live bands",
    main: "No DJ tonight: the band is the main act on stage, 22:30–01:00. A genre that suits the crowd fills the floor.",
    opener:
      "With a DJ booked, the band opens the night on stage, 22:00–23:00, then hands over to the decks.",
    fans: (n: number) => `${n} fans`,
    book: (fee: string) => `Book · ${fee} NP`,
    booked: "Booked",
    live: "LIVE ON STAGE",
  },

  talent: {
    djs: "DJs",
    book: "BOOK",
    booked: "BOOKED",
    match: "Crowd match",
    locked: (lv: number) => `Requires Level ${lv}`,
    fanbase: "Fanbase",
    forecast: "Crowd genre forecast",
    forecastHint:
      "A DJ who matches the dominant crowd genre gives +20% satisfaction; a mismatch gives −15%.",
  },

  promo: {
    title: "Promote Tonight's Event",
    channel: "Channel",
    cost: "Cost",
    hype: "Hype",
    audience: "Audience",
    post: "POST",
    posted: "POSTED",
    energyNote: "Each post costs 1 CEO Energy.",
    nightNote:
      "Club is open: every post brings extra guests for the rest of the night (none in the last hour). Costs 1 CEO Energy.",
    controversial: "Controversial stunt",
    controversialDesc:
      "Hype +30. 25% chance it backfires: Rep −20 and a guaranteed inspection.",
    risk: "RISK IT",
  },

  staff: {
    wage: (n: number) => `${fmt(n)} NP/day`,
    hire: "Hire",
    fire: "Fire",
    securityHint: (cap: number) =>
      `Keep at least 1 security per 40 guests (${Math.ceil(cap / 40)} for full capacity). Security also checks IDs at the door.`,
    bartenderHint:
      "Each desk broker adds order capacity. A slow desk means lost sales and unhappy guests.",
    hostHint:
      "Social hosts keep the room lively: the club looks fuller, men spend more (and buy them tokens). Unlocks the 'Hosts to the floor' move.",
    relationsHint:
      "Guest relations meet every guest, keep them happy, talk up bigger orders and book tables (whale service). One covers ~60 guests.",
    mcHint:
      "Hype man on the stage. Unlocks 'MC hype': sing-alongs and hands in the air that lift the room's energy.",
  },

  permits: {
    active: (d: number) => `Valid until Day ${d}`,
    expired: "Expired",
    none: "Not held",
    required: "Required",
    optional: "Optional",
    apply: "Apply",
    renew: "Renew",
    renewNow: "Renew now",
    applyNow: "Apply now",
    crowdNote: "Needed for nights with more than 150 guests inside.",
  },

  build: {
    title: "Empire Ladder",
    current: "Current",
    upgrade: "UPGRADE",
    needs: (coin: number, rep: number) => `${fmt(coin)} NP · Rep ${rep}`,
    unlocks: [
      "Stock, pricing, posters",
      "Staff, suppliers, OTC trading licence",
      "Token desk, trading-floor licence, more promo channels",
      "DJs, security, full night phase, crowd permit",
      "Premium DJs, whale-table crowd, festivals",
    ],
    levelUp: (name: string) => `Welcome to your ${name}!`,
    permitsNeeded: (names: string) => `Also needs: ${names}`,
  },

  night: {
    capacity: "CAPACITY",
    queue: (n: number) => `queue ${n}`,
    stock: "STOCK",
    feed: "EVENT FEED",
    feedEmpty: "Quiet so far. Your decisions show up here.",
    nowPlaying: "NOW PLAYING",
    noDj: "House playlist",
    djLeft: (name: string, genre: string, left: string) =>
      `${name} · ${genre} · ${left} left`,
    mood: "Crowd mood",
    tonight: "TONIGHT'S REVENUE",
    guestsTonight: (n: number) =>
      `${fmt(n)} ${n === 1 ? "guest" : "guests"} tonight`,
    revenue: (n: number) => `Tonight's revenue: ${fmt(n)} NP`,
    ceoCall: "CEO CALL",
    ceoCallHint: "[Q] 1× / night",
    happyHour: "Happy Hour",
    happyHourDesc: "+Satisfaction now, half-price tokens",
    closeDoor: "Close Door",
    closeDoorDesc: "Stop letting guests in",
    forceDoor: "Force door open",
    forceDoorDesc: "Violation! Lets guests in over capacity",
    skip: "Skip to 04:00",
    skipTitle: "Skip to 04:00?",
    skipWarn:
      "The rest of the night plays out instantly: no more crowd moves, restocks or dealing with trouble. The report opens straight away.",
    skipCancel: "Keep playing",
    paused: "PAUSED",
    securityBusy: (busy: number, total: number) =>
      `Security: ${busy} of ${total} walking a tilted guest out`,
    securityStretched: (waiting: number, total: number) =>
      `${waiting} tilted guest${waiting > 1 ? "s" : ""} waiting · all ${total} security busy`,
    noSecurity: (waiting: number) =>
      `${waiting} tilted guest${waiting > 1 ? "s" : ""} and no security on shift`,
    hireSecurity: "Fights can break out: hire more security (Office → Staff)",
    objectives: "OBJECTIVES",
    panel: "Panels [Tab]",
    speed: (x: number) => `Speed ${x}×`,
    bandLive: (name: string, genre: string) => `Live: ${name} · ${genre}`,
    toOffice: "Office",
    cinematic: "Cinematic camera",
    cinematicExit: "Exit cinematic",
    hideHud: "Hide UI",
    showHud: "Show UI",
    editLayout: "Layout",
    mute: "Mute",
    unmute: "Unmute",
  },

  report: {
    title: (d: number) => `Night Report · Day ${d}`,
    guests: "Guests",
    rejected: "Underage turned away",
    bar: "Token sales",
    cover: "Cover charge",
    table: "Tables",
    tax: "Entertainment tax",
    fines: "Fines",
    profit: "Night profit",
    satisfaction: "Avg satisfaction",
    rep: "Reputation",
    fights: "Fights",
    violations: "Violations",
    upkeepNote: "Wages and rent are paid at the start of the next day.",
    next: "NEXT DAY",
    results: "SEE RESULTS",
    reviews: "What guests said",
    heading: "Night Report",
    repLow: "−5 Rep below 40",
    repHigh: "+Rep from 70",
    why: "Why guests felt this way",
    factorStock: (n: number) =>
      `${n} guests wanted a token you had run out of (−10 each)`,
    factorSlow: (n: number) =>
      `${n} times the desk was too busy to fill orders (hire brokers)`,
    factorDjMatch: "The DJ matched the crowd (+20% on the dance floor)",
    factorDjMiss: "The DJ didn't match the crowd (−15% on the dance floor)",
    factorNoDj: "No DJ tonight: the dance floor was half as fun",
    factorFights: (n: number) => `${n} fight${n > 1 ? "s" : ""}: Rep −5 each`,
    factorClean: "Smooth night: nothing went wrong at the desk",
    energy: "Crowd energy",
    energyValue: (avg: number, peak: number) => `avg ${avg} · peak ${peak}`,
    rounds: "Tokens bought for others",
    escorted: "Walked out by security",
    tables: "Tables reserved",
    vipTables: "VIP tables",
    barSeats: "Bar seats (minimum charge)",
    rejectedDress: "Turned away (dress code)",
    guestList: "Guest list guests",
    commission: "Promoter commission",
    platformFee: "Platform share (spread over spot)",
    bottles: "Block buys from sparkler parades",
    factorEnergyHigh: (avg: number) =>
      `The room was buzzing (energy ${avg}): more dancing, more spending`,
    factorEnergyLow: (avg: number) =>
      `The room felt flat (energy ${avg}): try hosts, the MC or the DJ's anthem at the right moment`,
    factorMoves: (n: number) => `${n} crowd move${n > 1 ? "s" : ""} used`,
    subtitle: (d: number) => `Day ${d}`,
  },

  outcome: {
    victory: "VICTORY",
    defeat: "DEFEAT",
    survived: "SURVIVED",
    victoryText: "Your nightlife empire is the talk of Veltra City.",
    defeatText: "The lights go out. Your venue has closed.",
    survivedText: "You made it through, but the goal slipped away.",
    retry: "Retry",
    menu: "Main Menu",
    stats: "Final stats",
  } as Record<Outcome | string, string>,

  pause: {
    autosaved: "Your club saves itself after every night and when you leave.",
    title: "Paused",
    resume: "Resume",
    save: "Save",
    saved: (n: number) => `Saved to slot ${n}`,
    quit: "Quit to Menu",
    controls:
      "Space pause · 1/2/3 speed · F/G/B pyro (manual) · Shift+1–8 sampler · O office · L layout · H hide UI · C cinematic · Tab panel · Q CEO Call · M mute · drag rotate · right-drag / arrows pan · wheel zoom · Esc menu",
  },

  /** What each token tracks. Baskets use Portir's curated weights. */
  tokenInfo: {
    tsla: {
      about:
        "Electric cars, batteries and robotaxis. The crowd's favourite meme-stock: when the room is loud, TSLA moves.",
    },
    us500: {
      about:
        "The whole US market in three ETFs. Low drama, low FOMO: the safe first buy of the night.",
    },
    nvda: {
      about:
        "The chips behind the AI boom. Big swings, bigger FOMO when the drop hits.",
    },
    bigtech: {
      about: "The five platforms most of the internet runs on.",
    },
    aisemis: {
      about: "The chips, fabs and clouds behind AI.",
    },
    dividend: {
      about:
        "Household names that have paid dividends for decades. Guests hold it through a red candle.",
    },
    skhy: {
      about:
        "Korean memory giant feeding the AI data centres. Moves hard on every chip headline.",
    },
    spcx: {
      about:
        "Rockets and satellites. The most volatile token on the floor: whales love it.",
    },
  } as Record<string, { about: string }>,
  rules: {
    ladies: "Ladies' night",
    ladiesDesc:
      "Women get in free. More women come, more men follow, and men spend more buying rounds. You lose their cover charge.",
    dress: "Dress code",
    dressDesc:
      "A stricter door turns some guests away and puts a few off coming, but the crowd that gets in spends far more.",
    dressCodes: { none: "None", smart: "Smart", strict: "Strict" },
    dressDetail: {
      none: "Anyone gets in.",
      smart: "~10% of men and ~3% of women turned away · budgets +20%",
      strict: "~25% of men and ~8% of women turned away · budgets +40%",
    },
    forecast: "Tonight with these rules",
    expected: "Expected guests",
    women: "Women in the crowd",
    tables: "Tables booked (Guest Relations)",
    locked: "House rules unlock at Level 3.",
    cover: "Cover charge",
    coverDesc:
      "A cheaper door pulls more people in, but a thriftier crowd. A pricier door keeps the numbers down and the spenders in.",
    coverStandard: (n: string) => `Standard ${n} NP`,
    coverReset: "Use standard",
    happy: "Happy hour",
    happyDesc:
      "Half-price tokens for one hour. Early fills the room sooner (and they stay); late keeps the crowd until close.",
    happySlots: {
      off: "Off",
      early: "Early · 22:00–23:00",
      late: "Late · 03:00–04:00",
    },
    dayOnly: "Change the rules by day.",
  },

  minSpend: {
    title: "Minimum spend",
    desc: "What each reserved seat must spend tonight. Charge more and fewer book; charge less and more do. VIP, sofas and tables are booked by Guest Relations; bar seats fill with walk-ins.",
    types: { vip: "VIP table", sofa: "Sofa", table: "Table", bar: "Bar seat" },
    booked: (n: number, of: number) => `~${n} of ${of} booked tonight`,
    standard: (c: string) => `standard ${c}`,
    vipLocked: "Build the VIP lounge first (Build tab)",
  },

  promoters: {
    title: "Promoters · guest list",
    desc: "A promoter fills tonight's guest list with their crowd. List guests arrive early and skip the cover; you pay per head who gets in.",
    heads: (n: number) => `~${n} guests`,
    perHead: (n: string) => `${n} NP per head`,
    book: "Book",
    booked: "Booked",
    segment: (s: string) => `Crowd: ${s}`,
  },

  rig: {
    title: "Venue upgrades",
    desc: "Spend NYX Points on the building. Everything here belongs to this venue: a new venue starts from scratch.",
    capacity: "Venue capacity",
    capacityDesc: (n: number) =>
      `Knock through walls and extend the licence: +15% guests per tier. Now ${fmt(n)}.`,
    storage: "Stock room",
    storageDesc: (n: number) =>
      `More shelving and cold storage: +50% token inventory per tier. Now ${fmt(n)}.`,
    sound: "Sound system",
    soundDesc: "Bigger speakers: more energy, dancing feels better",
    lighting: "Lighting rig",
    lightingDesc: "More beams and lasers: more energy, happier guests",
    tier: (t: number) => `Tier ${t} / 3`,
    buy: (c: string) => `Upgrade · ${c} NP`,
    maxed: "Maxed out",
    vip: "VIP lounge",
    vipDesc: (n: number) =>
      n
        ? `Opens the roped-off VIP area: up to ${n} VIP tables a night (3× a table's minimum spend), booked by Guest Relations.`
        : "Needs a Nightclub (Level 4) or bigger.",
    build: (c: string) => `Build · ${c} NP`,
    built: "Built",
    notBuilt: "Not built",
  },

  dj: {
    title: "DJ Studio",
    live: "Live · the club hears you",
    practice: "Practice",
    hint: "Load two tracks, sync, blend with EQ and the crossfader. Pads 1–8 · Esc to close",
    close: "Close studio",
    empty: "Load a track",
    cue: "CUE",
    sync: "SYNC",
    syncHint: "Match the other deck's tempo and line the beats up",
    reverse: "REV",
    reverseHint: "Play backwards",
    hotCueHint: "Hot cue: set here, then jump to it · right-click clears",
    loopHint: "Loop this many beats (again to release)",
    jumpHint: "Beat jump: 4 beats back / forward",
    brake: "BRAKE",
    brakeHint: "Vinyl brake: wind down to a stop",
    spin: "SPIN",
    spinHint: "Backspin / rewind: spin the record back",
    pitch: "Pitch",
    rangeHint: "Pitch range: ±16% or ±50% (wide)",
    bpmHint: "Tempo read at half or double? Correct it here",
    nudge: "Nudge (bend the tempo to line up by ear)",
    platter: "Platter",
    platterHint: "Grab and drag round to scratch, hold still to stop",
    crossfader: "Crossfader",
    trim: "Gain",
    high: "High",
    mid: "Mid",
    low: "Low",
    filter: "Filter",
    echo: "Echo",
    reverb: "Reverb",
    fader: "Vol",
    crate: "Crate",
    loading: "loading…",
    loadTo: (d: string) => `→ ${d}`,
    upload: "Bring your own track (mp3, wav…)",
    crateOnly:
      "Live in another club: crate tracks only (the other players can't hear a file from your computer).",
    loadError: "Couldn't load that track.",
    sampler: "Sampler",
    ceoSamplerHint:
      "Fire them over the resident DJ's set. Riser and snare roll last a bar at the club's tempo.",
    pads: {
      horn: "Air horn",
      siren: "Siren",
      riser: "Riser",
      down: "Downlifter",
      impact: "Impact",
      sub: "Sub drop",
      laser: "Laser",
      roll: "Snare roll",
    },
    takeDecks: "Take the decks",
    tabs: { crate: "Crate", sets: "Sets" },
    mySet: {
      title: "Your DJ set tonight",
      desc: (at: string) =>
        `Plays from ${at} instead of the booked DJ's music (the booked DJ still counts for the crowd). Plan sets in the DJ Studio: Dashboard → DJ, or Take the decks at night.`,
      none: "No, the booked DJ plays",
    },
    planner: {
      pick: "Set",
      new: "New set",
      newName: (n: number) => `My set ${n}`,
      name: "Set name",
      delete: "Delete this set",
      track: "Track",
      up: "Move up",
      down: "Move down",
      remove: "Remove",
      from: "from",
      play: "play",
      bars: (n: number) => `${n} bars`,
      move: "Move into the next track",
      length: "Length of the move",
      beats: (n: number) => `${n} beats`,
      sfx: "Pad on the drop",
      noSfx: "no pad",
      add: "Add a track",
      preview: "Play set",
      stop: "Stop",
      tonight: "Play at my club tonight",
      moves: {
        fade: "Fade",
        cut: "Cut",
        bass: "Bass swap",
        filter: "Filter",
        echo: "Echo out",
        spin: "Backspin",
      },
      moveHints: {
        fade: "Smooth crossfade, both tracks beat-matched",
        cut: "Hard cut on the downbeat",
        bass: "Next track comes in without bass; the basses swap halfway",
        filter:
          "Old track thins out through a high-pass while the new one opens up",
        echo: "Old track echoes out, the new one drops on the last beat",
        spin: "Old record spun back as the new one drops",
      },
      clash: (pct: number) =>
        `Tempos ${pct}% apart: a blend will clash. Use Cut, Echo out or Backspin, or pick closer tracks.`,
      auto: "AUTO",
      loading: "loading…",
      now: (title: string) => `Now: ${title}`,
      next: (move: string, title: string) => `next: ${move} into ${title}`,
      moving: (move: string, title: string) => `${move} into ${title}…`,
    },
  },

  pyro: {
    title: "Pyro",
    modes: { auto: "Auto", manual: "Manual" },
    cues: { fire: "Fire", fog: "Fog", both: "Both" },
    autoHint: "Flames and fog fire on the DJ's beat and every drop.",
    manualHint: "You call it: F fire · G fog · B both.",
  },

  moves: {
    title: "Crowd moves",
    energy: "Energy",
    energyHint:
      "How full and how moving the room is. Low energy + unhappy guests = people go home.",
    mcHype: "MC hype",
    mcHypeDesc: "Sing-along, hands up",
    hostsFloor: "Hosts to the floor",
    hostsFloorDesc: "Fill an empty dance floor",
    djAnthem: "DJ anthem",
    djAnthemDesc: "Signature set: everyone stays",
    sparkler: "Sparkler parade",
    sparklerDesc: (cost: string) => `Whale-table show · ${cost} NP`,
    needTables: "Tables seated first",
    active: (m: number) => `Live · ${m} min`,
    ready: "Ready",
    cooldown: (m: number) => `Again in ${m} min`,
    needMc: "Hire an MC",
    needHost: "Hire hosts",
    needDj: "After the DJ starts",
    used: "Used tonight",
  },

  settings: {
    title: "Settings",
    open: "Settings",
    close: "Close",
    audio: "Audio",
    volume: "Master volume",
    menuMusic: "Music outside the club",
    menuMusicDesc: "Landing, office, reports",
    venueMusic: "Music inside the club",
    venueMusicDesc: "House warm-up, then the DJ",
    sfx: "Sound effects",
    sfxDesc: "Cash register and alerts",
    venue: "Venue",
    clips: "Dancer clips on the wall screens",
    clipsDesc:
      "Peak hours = 00:00–03:00 with a DJ on; before that the screens run the visualizer",
    clipModes: { peak: "Peak hours", always: "Always", off: "Off" },
    ads: "Ads on venue screens",
    adsDesc: "Off: sponsor slots show club visuals instead",
    intro: "Open Club cutscene",
    introDesc: "The short video before each night",
    on: "On",
    off: "Off",
  },

  topup: {
    credit: "Credit",
    creditNote:
      "Real money: 100 Credit = $1, backed by USDC on BNB Chain. It buys real stock in the city.",
    open: "Top up",
    title: "Top up Credit",
    close: "Close",
    balance: "Your Credit",
    usd: (cents: number) => `$${(cents / 100).toFixed(2)}`,
    addTitle: "1 · Add USDC",
    addNote: "Pay by card into your game wallet (USDC on BNB Chain).",
    add: "Add USDC by card",
    addCancelled: "Card payment closed",
    sendTitle: "2 · Send to the game",
    sendNote: (fee: number) =>
      `You pay no gas. ${fee}% goes to the game; the rest becomes your Credit.`,
    amount: "Amount (USD)",
    youGet: (credits: number) => `You get ${fmt(credits)} Credit`,
    min: (usd: number) => `At least $${usd}`,
    room: (cents: number) =>
      `You can still add $${(cents / 100).toFixed(2)} (the limit during the hackathon)`,
    full: "You've reached the top-up limit for now.",
    send: (usd: string) => `Top up $${usd}`,
    sending: "Confirm in your wallet…",
    confirming: "Confirming on BNB Chain… this takes about a minute.",
    done: (credits: number) => `Done: ${fmt(credits)} Credit is yours.`,
    partly: (credits: number) =>
      `${fmt(credits)} Credit added, up to the limit. The rest is recorded and will be refunded.`,
    viewTx: "View transaction",
    history: "Recent top-ups",
    status: {
      pending: "Confirming",
      credited: "Added",
      unknown: "Not matched",
      rejected: "Not added",
    } as Record<string, string>,
    errors: {
      not_configured: "Top-ups aren't open yet.",
      no_wallet: "Your game wallet isn't ready yet. Sign in again.",
      tx_failed: "The transfer failed on BNB Chain. Nothing was taken.",
      not_a_topup: "That transaction isn't a top-up from your wallet.",
      chain_unavailable: "BNB Chain can't be read right now. Try again soon.",
      slow: "Still confirming. Your Credit will appear within a few minutes.",
      not_yours: "That transfer was sent from another wallet, not yours.",
      rejected:
        "Not added: under the minimum or over the limit. It's recorded and will be refunded.",
      wallet: "The transfer wasn't sent. Nothing was taken.",
      unknown: "Something went wrong. Try again in a moment.",
    } as Record<string, string>,
  },

  sales: {
    prices: "Credit prices",
    pricesNote:
      "Real stock sold at this party, per unit (0.001 share), in Credit. Blank = not sold. Set before it starts; locked after.",
    floor: (w: number, max: number) => `${fmt(w)}–${fmt(max)}`,
    save: "Save prices",
    saved: "Prices saved",
    menu: "Real stock here",
    each: (credits: number) => `${fmt(credits)} Credit`,
    yourCredit: (credits: number) => `Your Credit: ${fmt(credits)}`,
    bought: (qty: number, ticker: string, left: number) =>
      `Bought ${qty} ${ticker} with Credit · ${fmt(left)} left`,
    busy: "Still buying the last one…",
    errors: {
      rejected: "Not enough Credit, or this token isn't on the menu.",
      sold_out: "The warehouse is out of this token right now.",
      not_live: "The party isn't on.",
      prices_locked: "The party has started: prices are locked.",
      no_price: "No live price right now. Try again in a minute.",
      bad_request: "Check the prices: each between the two numbers shown.",
      price_changed: "The price changed. Check it and buy again.",
    } as Record<string, string>,
  },

  tokenDetail: {
    title: "Token",
    stock: "Stock",
    basket: "Basket",
    inStock: "In stock",
    cost: "Unit cost",
    list: "List price",
    live: "Live price",
    change: "vs list",
    margin: "Margin",
    fomo: "FOMO",
    chart: "Tonight's market",
    chartIdle: "The market opens with the doors. Open the club to see it move.",
    legs: "What's in the basket",
    rails: "On-chain later",
    railsNote:
      "Planned rails for the real thing: tokenized stocks on BNB Chain.",
    unlock: (lv: number) => `Unlocks at Lv ${lv}`,
    close: "Close",
    open: "Show token details",
  },

  spot: {
    live: (at: Date) =>
      `Spot prices live from Binance (RWA, BNB Chain) · ${at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`,
    offline: "Spot feed offline: using the game's own prices",
    fee: (pct: number) =>
      `The platform takes ${pct}% of your spread over spot on every sale`,
    markup: (pct: number) => `spot ${pct >= 0 ? "+" : ""}${pct}%`,
    markupHint:
      "Your sale price over what one lot costs at spot. The spread is your income; the platform takes its share of it.",
    spotLot: "Spot cost / lot",
    underlying: "Real price (per share)",
  },

  ticker: {
    label: "Club market",
    index: "Index",
  },

  venue: {
    vipLocked: "BUILD IT: OFFICE → BUILD",
    tokenBoard: "TOKEN DESK · LIVE",
  },

  videotron: {
    shoutout: "SHOUTOUT",
    anthem: "THE ANTHEM",
    bottles: "WHALE TABLES",
    sparklers: "SPARKLERS UP",
    mc: "MC ON THE MIC",
    handsUp: "HANDS UP!",
    floor: "HOSTS ON THE FLOOR",
    everybody: "EVERYBODY DANCE",
    topSpenders: "TOP SPENDERS TONIGHT",
    movers: "TOP MOVERS",
    nowPlaying: "NOW ON THE DECKS",
    welcome: "WELCOME TO",
    title: "Videotron",
    hint: "Shown on the LED board above the DJ",
    placeholder: "Happy birthday Sarah!",
    add: "Show",
    remove: "Remove",
    names: [
      "RAKA",
      "DINA",
      "BIMO",
      "SARAH",
      "KEVIN",
      "MAYA",
      "ANDRE",
      "NADIA",
      "RIZKY",
      "CLARA",
      "DIMAS",
      "PUTRI",
      "JASON",
      "LUNA",
      "FARHAN",
      "BELLA",
      "ARYA",
      "TASHA",
      "REZA",
      "GISELLE",
      "OMAR",
      "KIRANA",
      "LEO",
      "VANYA",
    ],
  },

  editor: {
    title: "Edit layout",
    hint: "Drag furniture to move · R rotate · Del remove · drag floor to orbit · Esc done",
    add: "Add",
    kinds: {
      sofa: "Sofa",
      chair: "Chair",
      table: "Table",
      stool: "Bar stool",
      highTable: "High table",
    },
    rotate: "Rotate",
    remove: "Remove",
    reset: "Reset to default",
    done: "Done",
  },

  tutorial: {
    career1:
      "Welcome to your token booth. Stock TSLA and US500 in the Stock tab (guests buy both), then press OPEN CLUB to start the night.",
    career2:
      "Post a poster in the Promo tab. Hype brings more guests, and it fades by 10 every day.",
    basement1:
      "The Basement, Week 1. Every system is live: stock, DJs, promo, security, permits. Survive the week and finish with Rep 60+ and no violations.",
  },

  objectives: (o: Objective): string => {
    const p =
      o.target !== undefined
        ? ` (${fmt(Math.min(o.current ?? 0, o.target))}/${fmt(o.target)})`
        : "";
    const text: Record<Objective["id"], string> = {
      orderStock: "Order stock",
      openClub: "Open the club",
      postPromo: "Post a promo",
      reachGuests: `Reach ${o.target} guests tonight`,
      bookDj: "Book a DJ",
      hireSecurity: "Hire security",
      renewLiquor: "Renew the trading licence",
      noViolationsTonight: "Finish the night without violations",
      noOutOfStock: "Don't run out of stock tonight",
      crowdPermit: "Hold a crowd permit",
      reachRep: `Reach Rep ${o.target}`,
      saveCoin: `Save ${fmt(o.target ?? 0)} NP for the next level`,
      noViolations: "Zero violations this week",
    };
    return (
      text[o.id] + (o.id === "reachGuests" || o.id === "saveCoin" ? p : "")
    );
  },

  event: (
    e: GameEvent,
    names: {
      drink: (id: string) => string;
      dj: (id: string) => string;
      channel: (id: string) => string;
      promoter: (id: string) => string;
      band: (id: string) => string;
      permit: (id: string) => string;
    },
  ): string => {
    switch (e.kind) {
      case "orderPlaced":
        return `Ordered ${e.qty} ${names.drink(e.drink)} for ${fmt(e.cost)} NP`;
      case "orderDelivered":
        return `${e.qty} ${names.drink(e.drink)} delivered`;
      case "outOfStock":
        return `Out of stock: ${names.drink(e.drink)}!`;
      case "upkeepPaid":
        return `Paid wages ${fmt(e.wages)} NP and rent ${fmt(e.rent)} NP`;
      case "taxPaid":
        return `Entertainment tax ${fmt(e.tax)} NP`;
      case "djBooked":
        return `${names.dj(e.dj)} booked: Hype +${e.hype}`;
      case "promoPosted":
        return `${names.channel(e.channel)} promo posted: Hype +${e.hype}`;
      case "controversialPromo":
        return e.backfired
          ? "The stunt went viral for the wrong reasons: Rep −20, inspector incoming"
          : `The stunt worked: Hype +${e.hype}`;
      case "permitRenewed":
        return `${names.permit(e.permit)} valid until Day ${e.expiresDay}`;
      case "levelUp":
        return `Upgraded to Level ${e.level}`;
      case "bandBooked":
        return `${names.band(e.band)} booked for the stage: Hype +${e.hype}`;
      case "bandStarted":
        return `${names.band(e.band)} is live on stage · crowd is into ${genres[e.crowdGenre] ?? e.crowdGenre}${e.match ? " · perfect match" : " · mismatch"}`;
      case "djStarted":
        return `${names.dj(e.dj)} started set · crowd is into ${genres[e.crowdGenre] ?? e.crowdGenre}${e.match ? " · perfect match" : " · mismatch"}`;
      case "doorClosed":
        return "Capacity reached: door closed, queue growing";
      case "doorForced":
        return "Door forced open over capacity: violation";
      case "fight":
        return "Fight on the floor! Safety −15, Rep −5";
      case "inspection":
        return e.passed
          ? "Inspector visited: all clear"
          : `Inspector found problems${e.underage ? " (underage guests)" : ""}${e.missing.length ? ` (missing: ${e.missing.map(names.permit).join(", ")})` : ""}: fine ${fmt(e.fine)} NP, violation`;
      case "venueSealed":
        return "Venue sealed tonight";
      case "crowdShutdown":
        return "Over 150 guests without a crowd permit: police shut the event down!";
      case "ceoCall":
        return e.call === "happyHour"
          ? "CEO Call: Happy Hour!"
          : "CEO Call: door closed";
      case "guestEscorted":
        return "Security escorted a tilted guest out";
      case "rivalPromo":
        return `A rival club launched a big promo: Hype ${e.hype}`;
      case "supplierDelay":
        return `Suppliers are running late: +${e.days} day on orders`;
      case "securityStretched":
        return `Security is stretched: ${e.waiting} tilted guest${e.waiting > 1 ? "s" : ""} waiting for a guard`;
      case "tactic":
        return {
          mcHype: "MC on the mic: hands up, the whole room sings along",
          sparkler: "Whale tables light the sparklers",
          hostsFloor: "Hosts hit the dance floor: the crowd follows",
          djAnthem: "The DJ drops the anthem: nobody is going home",
        }[e.tactic];
      case "tablesSeated":
        return `${e.tables} reservation${e.tables > 1 ? "s" : ""} seated (tables, VIP, bar seats): +${fmt(e.revenue)} NP minimum spend`;
      case "crowdThinning":
        return `The room is going flat (energy ${e.energy}): guests are starting to leave`;
      case "promoterBooked":
        return `Promoter booked: ${names.promoter(e.promoter)} is filling the guest list`;
      case "upgradeBought":
        return `${e.upgrade === "sound" ? "Sound system" : "Lighting rig"} upgraded to tier ${e.tier} (−${fmt(e.cost)} NP)`;
      case "sparklerParade":
        return e.bottles
          ? `Sparkler parade! ${e.bottles} more table${e.bottles > 1 ? "s" : ""} made a block buy: +${fmt(e.revenue)} NP`
          : "Sparkler parade lit up the room";
      case "policyChanged":
        return `House rules: ${[
          e.policy.cover != null ? `cover ${fmt(e.policy.cover)} NP` : null,
          e.policy.happyHour !== "off"
            ? `${e.policy.happyHour} happy hour`
            : null,
          e.policy.ladiesNight ? "ladies' night" : null,
          `dress code ${e.policy.dressCode}`,
        ]
          .filter(Boolean)
          .join(" · ")}`;
      case "nightRep":
        return e.delta > 0
          ? `Great night (satisfaction ${e.satisfaction}): reputation +${e.delta}`
          : e.delta < 0
            ? `Bad night (satisfaction ${e.satisfaction}): reputation ${e.delta}`
            : `Okay night (satisfaction ${e.satisfaction}): reputation unchanged`;
      case "gameOver":
        return `Game over: ${e.outcome}`;
    }
  },

  reviews: {
    djMatch: "The DJ was spot on!",
    djMiss: "Wrong music for this crowd.",
    outOfStock: "They ran out of the token I wanted...",
    fight: "Someone started a fight. Not coming back.",
    packed: "Packed! Waited forever in line though.",
    great: "Best night out in ages.",
    meh: "It was okay.",
    bad: "Honestly, pretty dead.",
    slow: "Waited ages for my order to fill.",
  },
};
