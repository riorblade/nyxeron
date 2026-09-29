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
  notEnoughCoin: (s) => `Not enough Coin: ${fmt(s ?? 0)} short`,
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
  title: "NYXERON",
  subtitle: "Nightlife Empire",
  tagline: "Plan by day. Survive the night.",

  landing: {
    docTitle: "NYXERON · Nightlife Empire",
    main: ["Nyxeron", "Nightlife"],
    alt: ["Open the", "Doors"],
    crew: ["Sixty", "Nights"],
    // "Nyx, goddess of the night": the name comes from Greek myth (GDD 1).
    greek: ["ΝΥΞ", "·", "ΘΕΑ ΤΗΣ ΝΥΧΤΑΣ"],
    zone: ["Veltra City", "Local Time"],
    career: "Career",
    scenario: "Scenario",
    load: "Load",
    contactNew: "Open the doors",
    contactContinue: "Continue",
    lede: "Veltra City, 22:00. One drink booth, ten thousand coin and a permit that runs out in thirty days. Stock the bar, book the DJ, keep the inspectors sweet, and build it into the venue this city can't stop talking about.",
    copyright: "©2026 Kelompok Empuy",
    scroll: "Scroll down",
    statement: "From one drink booth to a premium venue in sixty nights.",
    left: "Five venues, one ladder. Every level unlocks a new system: staff, live music, DJs, security, bottle service.",
    right:
      "No choice is free. More security means a slower door, cheap stock sells out by midnight, and one bad promo brings the inspector.",
    bottom: ["Plan by day", "Survive the night", "Own the city"],
    newCareer: "New Career",
    basement: "The Basement",
    loadTitle: "Load game",
    soundOn: "Sound on",
    soundOff: "Sound off",
  },

  intro: {
    doors: "Doors open",
    skip: "Skip",
    dontShow: "Don't show again",
  },

  nav: {
    home: "Home",
    homeTitle: "Back to the main menu (progress is saved)",
    saved: "Progress saved. Continue from the main menu.",
  },

  menu: {
    continue: "Continue",
    copy: "Start with a single drink booth in Veltra City.\nBuild it into a premium venue in 60 nights.\nPlan by day. Survive the night.",
    city: "Veltra City",
    play: "Play scenario",
    week1: "Week 1",
    newCareer: "New Career",
    basement: "Scenario: The Basement",
    basementDesc: "Level 4 nightclub, Week 1 challenge",
    load: "Load Game",
    back: "Back",
    empty: "Empty slot",
    autosave: "Autosave",
    slot: (n: number) => `Slot ${n}`,
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
  },

  hud: {
    day: (d: number) => `Day ${d}`,
    coin: "Coin",
    rep: "Rep",
    hype: "Hype",
    safety: "Safety",
    energy: "CEO Energy",
    violations: "Violations",
    permits: "Permits",
    level: (n: number, name: string) => `Lv ${n} · ${name}`,
  },

  office: {
    title: "Office",
    daytime: "Daytime",
    tabs: {
      stock: "Stock",
      talent: "Talent",
      promo: "Promo",
      staff: "Staff",
      permits: "Permits",
      build: "Build",
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
        desc: "Order drinks, pick a supplier and set your prices.",
      },
      talent: {
        title: "Talent Agency",
        desc: "Book a DJ who fits tonight's crowd.",
      },
      promo: {
        title: "Social Media",
        desc: "Build hype before the doors open.",
      },
      staff: {
        title: "Staff Room",
        desc: "Bartenders keep the bar moving. Security keeps the night safe.",
      },
      permits: {
        title: "Permit Office",
        desc: "Stay legal. Inspectors don't do warnings.",
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

  stock: {
    supplier: "Supplier",
    lead: (d: number) => (d === 0 ? "instant" : `${d} day${d > 1 ? "s" : ""}`),
    drink: "Drink",
    inStock: "In stock",
    price: "Price",
    cost: "Unit cost",
    order: "Order",
    pending: "Incoming orders",
    arrives: (d: number) => `arrives Day ${d}`,
    emergency: "Emergency restock",
    need: "Tonight",
    needHint:
      "Forecast for tonight: expected guests × ~3 drinks, spread over the menu",
    fill: "Fill to forecast",
    low: (name: string) => `${name} running low`,
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
    wage: (n: number) => `${fmt(n)} C/day`,
    hire: "Hire",
    fire: "Fire",
    securityHint: (cap: number) =>
      `Keep at least 1 security per 40 guests (${Math.ceil(cap / 40)} for full capacity). Security also checks IDs at the door.`,
    bartenderHint:
      "Each bartender adds bar capacity. A slow bar means lost sales and unhappy guests.",
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
    needs: (coin: number, rep: number) => `${fmt(coin)} C · Rep ${rep}`,
    unlocks: [
      "Stock, pricing, posters",
      "Staff, suppliers, takeaway liquor permit",
      "Bar, on-premise liquor permit, more promo channels",
      "DJs, security, full night phase, crowd permit",
      "Premium DJs, bottle-service crowd, festivals",
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
    guestsTonight: (n: number) => `${fmt(n)} guests tonight`,
    revenue: (n: number) => `Tonight's revenue: ${fmt(n)} Coin`,
    ceoCall: "CEO CALL",
    ceoCallHint: "[Q] 1× / night",
    happyHour: "Happy Hour",
    happyHourDesc: "+Satisfaction now, half-price drinks",
    closeDoor: "Close Door",
    closeDoorDesc: "Stop letting guests in",
    forceDoor: "Force door open",
    forceDoorDesc: "Violation! Lets guests in over capacity",
    skip: "Skip to 04:00",
    paused: "PAUSED",
    drunkAlert: "Drunk guest! Click to send security",
    objectives: "OBJECTIVES",
    panel: "Panel [Tab]",
    toOffice: "Office",
    editLayout: "Layout",
    mute: "Mute",
    unmute: "Unmute",
  },

  report: {
    title: (d: number) => `Night Report · Day ${d}`,
    guests: "Guests",
    rejected: "Underage turned away",
    bar: "Bar sales",
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
      `${n} guests wanted a drink you had run out of (−10 each)`,
    factorSlow: (n: number) =>
      `${n} times the bar was too busy to serve (hire bartenders)`,
    factorDjMatch: "The DJ matched the crowd (+20% on the dance floor)",
    factorDjMiss: "The DJ didn't match the crowd (−15% on the dance floor)",
    factorNoDj: "No DJ tonight: the dance floor was half as fun",
    factorFights: (n: number) => `${n} fight${n > 1 ? "s" : ""}: Rep −5 each`,
    factorClean: "Smooth night: nothing went wrong behind the bar",
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
    title: "Paused",
    resume: "Resume",
    save: "Save",
    saved: (n: number) => `Saved to slot ${n}`,
    quit: "Quit to Menu",
    controls:
      "Space pause · 1/2/3 speed · O office · L layout · Tab panel · Q CEO Call · M mute · drag rotate · right-drag / arrows pan · wheel zoom · Esc menu",
  },

  videotron: {
    shoutout: "SHOUTOUT",
    topSpenders: "TOP SPENDERS TONIGHT",
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
      "Welcome to your drink booth. Order Beer and Soft drinks in the Stock tab (guests order both), then press OPEN CLUB to start the night.",
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
      renewLiquor: "Renew the liquor license",
      noViolationsTonight: "Finish the night without violations",
      noOutOfStock: "Don't run out of stock tonight",
      crowdPermit: "Hold a crowd permit",
      reachRep: `Reach Rep ${o.target}`,
      saveCoin: `Save ${fmt(o.target ?? 0)} Coin for the next level`,
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
      permit: (id: string) => string;
    },
  ): string => {
    switch (e.kind) {
      case "orderPlaced":
        return `Ordered ${e.qty} ${names.drink(e.drink)} for ${fmt(e.cost)} C`;
      case "orderDelivered":
        return `${e.qty} ${names.drink(e.drink)} delivered`;
      case "outOfStock":
        return `Out of stock: ${names.drink(e.drink)}!`;
      case "upkeepPaid":
        return `Paid wages ${fmt(e.wages)} C and rent ${fmt(e.rent)} C`;
      case "taxPaid":
        return `Entertainment tax ${fmt(e.tax)} C`;
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
          : `Inspector found problems${e.underage ? " (underage guests)" : ""}${e.missing.length ? ` (missing: ${e.missing.map(names.permit).join(", ")})` : ""}: fine ${fmt(e.fine)} C, violation`;
      case "venueSealed":
        return "Venue sealed tonight";
      case "crowdShutdown":
        return "Over 150 guests without a crowd permit: police shut the event down!";
      case "ceoCall":
        return e.call === "happyHour"
          ? "CEO Call: Happy Hour!"
          : "CEO Call: door closed";
      case "guestEscorted":
        return "Security escorted a drunk guest out";
      case "rivalPromo":
        return `A rival club launched a big promo: Hype ${e.hype}`;
      case "supplierDelay":
        return `Suppliers are running late: +${e.days} day on orders`;
      case "gameOver":
        return `Game over: ${e.outcome}`;
    }
  },

  reviews: {
    djMatch: "The DJ was spot on!",
    djMiss: "Wrong music for this crowd.",
    outOfStock: "They ran out of my drink...",
    fight: "Someone started a fight. Not coming back.",
    packed: "Packed! Waited forever in line though.",
    great: "Best night out in ages.",
    meh: "It was okay.",
    bad: "Honestly, pretty dead.",
    slow: "Waited ages at the bar.",
  },
};
