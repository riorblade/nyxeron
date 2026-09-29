import {
  djs,
  drinks,
  isAtFightRisk,
  isPeakTime,
  strategy,
  active as tacticActive,
  isInside,
  night as nightData,
  type DrinkId,
  type GameState,
} from "@nyxeron/core";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { audio } from "@/audio";
import type { ClipMode } from "@/settings";
import {
  canvasTexture,
  loadDjVideo,
  loadVenueAssets,
  shadowTexture,
  textTexture,
  type VenueAssets,
} from "./assets";
import {
  loadPlaylist,
  SCREEN_SIZE,
  ScreenWall,
  type ScreenKind,
} from "./screens";
import {
  layoutFor,
  zoneFor,
  type Layout,
  type Zone,
  type ZoneId,
} from "./layouts";
import {
  buildFurniture,
  loadFurniture,
  saveFurniture,
  seatsOf,
  defaultFurniture,
  type FurnitureKind,
  type Item,
} from "./furniture";
import { en } from "@/i18n/en";
import { StageFx } from "./effects";
import { Videotron, VIDEOTRON_ASPECT, type VideotronData } from "./videotron";

/** World units: 1 floor tile = 1 unit; people ~1.15 tall. */
const PERSON_H = 1.15;
const MAX_GUEST_SPRITES = 300;
const BLOCK_H = 0.45;
const WALL_H = 3.2;
/** Club light palette: magenta, electric blue, violet, amber. */
const PALETTE = [0xff2bd6, 0x22d3ee, 0xa855f7, 0xffb020];
/** Back-bar shelf sections, left to right, and the bottle colours on each. */
const SHELVES: { drink: DrinkId; glass: number[] }[] = [
  { drink: "vodka", glass: [0xe8e8f0, 0xcfe3ff, 0xf4f4f4] },
  { drink: "whisky", glass: [0xd9a441, 0xb86f24, 0xe0b25a] },
  { drink: "cocktail", glass: [0x6fbf73, 0x1f5a36, 0xb8452f, 0xf2d06b] },
  { drink: "wine", glass: [0x5a1020, 0x2c4a1e, 0xd8e0a0] },
];

/** Deterministic 0..1 from an integer, so a guest always picks the same spot and outfit. */
const hash = (n: number) => {
  let t = (n * 2654435761) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 2246822519) >>> 0;
  return (t >>> 0) / 4294967296;
};

type Task =
  | { kind: "post"; x: number; z: number }
  | { kind: "patrol"; x: number; z: number; wait: number }
  | { kind: "escort"; guest: number; phase: "approach" | "out" };

interface Person {
  g: THREE.Group;
  sprite: THREE.Sprite;
  alert?: THREE.Sprite;
  /** Red ring on the floor under a guest at fight risk. */
  ring?: THREE.Mesh;
  h: number;
  tx: number;
  tz: number;
  leaving: boolean;
  fade: number;
  mode: "dance" | "idle" | "work" | "perform";
  seed: number;
  /** Standing height (stage/booth top). */
  lift: number;
  task?: Task;
  home?: Task;
  /** Being walked out by security: it follows the bodyguard and only fades at the door. */
  held?: boolean;
}

/**
 * The club in 3D: orbit (drag), pan (right-drag / arrows), zoom (wheel). Characters are camera-facing sprites.
 * Read-only view of GameState.night: it never mutates state, only calls back on clicks.
 */
export class VenueScene {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private controls!: OrbitControls;
  private root = new THREE.Group();
  private assets: VenueAssets | null = null;
  private shadowTex = shadowTexture();
  private alertTex = textTexture("!", {
    size: 96,
    color: "#ff3b3b",
    weight: "900",
    font: "Inter Tight, sans-serif",
    stroke: true,
  });
  private floatCache = new Map<
    string,
    { tex: THREE.Texture; aspect: number }
  >();
  private guests = new Map<number, Person>();
  private staff: Person[] = [];
  private stage: Person[] = [];
  /** Hosts on shift: mingling at the tables and bar, or out on the floor during "Hosts to the floor". */
  private hosts: Person[] = [];
  private vipGuests: Person[] = [];
  private energy = 50;
  private staffKey = "";
  private stageKey = "";
  private floats: THREE.Sprite[] = [];
  private budgets = new Map<number, number>();
  /** Every LED dance floor (a superclub has the main floor and a poolside strip). */
  private leds: {
    mesh: THREE.InstancedMesh;
    cells: [number, number][];
    light: THREE.PointLight;
  }[] = [];
  private spots: { light: THREE.SpotLight; phase: number }[] = [];
  private beams: THREE.Mesh[] = [];
  /** Sparkler flames over the lounge tables during a parade. */
  private sparks: THREE.Sprite[] = [];
  private sparkTex = canvasTexture(32, 32, (ctx) => {
    const g = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, "rgba(255,255,230,1)");
    g.addColorStop(0.35, "rgba(255,200,90,.85)");
    g.addColorStop(1, "rgba(255,140,40,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 32, 32);
  });
  private rigLight = 0;
  /** This venue's wall height. */
  private wallH = WALL_H;
  /** Flame jets + mist cannons, fired on the kick while the DJ plays. */
  private fx: StageFx | null = null;
  private kicks = 0;
  private prevPulse = 0;
  private anthem = false;
  private lastKick = 0;
  private dropSeen = -99;
  /** Pool ripple texture, drifted every frame. */
  private pool: THREE.Texture | null = null;
  private walls: {
    mesh: THREE.Object3D;
    visible: (c: THREE.Vector3) => boolean;
  }[] = [];
  /** Wall screens; what they show depends on the hour and the player's settings (see applyScreens). */
  private wallScreens: {
    kind: ScreenKind;
    mat: THREE.MeshBasicMaterial;
    aspect: number;
    clip?: THREE.Texture;
    ad?: THREE.Texture;
  }[] = [];
  private screenKey = "";
  private peak = false;
  private prefs: { clips: ClipMode; ads: boolean } = {
    clips: "peak",
    ads: true,
  };
  /** Main (DJ) screen: the DJ loop during the set, otherwise the logo. */
  private screen: { mat: THREE.MeshBasicMaterial; idle: THREE.Texture } | null =
    null;
  private screenWall: ScreenWall | null = null;
  private playlist: Awaited<ReturnType<typeof loadPlaylist>> | null = null;
  private screenDj = "";
  private videos = new Map<string, Promise<THREE.VideoTexture | undefined>>();
  private logSeen = 0;
  private layout: Layout | null = null;
  /** First zone of each kind (most code wants "the" bar, "the" DJ booth). */
  private zones = new Map<ZoneId, Zone>();
  /** Every zone of each kind (a club has VIP wings on both sides, two bars, several seating areas). */
  private zoneList = new Map<ZoneId, Zone[]>();
  private djOn = false;
  private ready = false;
  private dead = false;
  private last = performance.now();
  private cashAt = 0;
  private off: (() => void)[] = [];
  /** Player-arranged furniture, one mesh group per item (same index). */
  private items: Item[] = [];
  private pieces: THREE.Group[] = [];
  private furnitureRoot = new THREE.Group();
  private seats = new Map<ZoneId, [number, number][]>();
  private editing = false;
  private selected = -1;
  private selBox: THREE.BoxHelper | null = null;
  private grid: THREE.GridHelper | null = null;
  private videotron: Videotron | null = null;
  private tron: VideotronData = { dj: null, top: [] };
  /** What each guest has spent tonight, from watching their budget drop. */
  private spent = new Map<number, number>();
  /** Invisible click targets over the cabinet sections and fridge. */
  private cabinetHits: THREE.Mesh[] = [];
  private hovered: THREE.Mesh | null = null;
  /** Told when a cabinet section is clicked. */
  onDrinkClick?: (id: DrinkId) => void;
  /** Told when the selection changes in edit mode (-1 = none). */
  onSelect?: (index: number) => void;

  constructor(private onGuestClick: (id: number) => void) {}

  async init(el: HTMLElement) {
    [this.assets, this.playlist] = await Promise.all([
      loadVenueAssets(),
      loadPlaylist(),
    ]);
    if (this.dead) return;
    const r = new THREE.WebGLRenderer({ antialias: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.15;
    this.renderer = r;
    el.appendChild(r.domElement);
    this.scene.background = new THREE.Color(0x07050c);
    this.scene.fog = new THREE.Fog(0x07050c, 28, 70);
    this.scene.add(this.root);

    const c = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.minDistance = 3;
    c.maxDistance = 45;
    c.maxPolarAngle = 1.4; // never below the floor
    c.minPolarAngle = 0.12;
    c.screenSpacePanning = false; // pan along the floor
    c.zoomToCursor = true; // wheel zooms toward what the mouse points at
    c.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
    c.listenToKeyEvents(window); // arrow keys pan
    this.controls = c;

    const resize = () => {
      const w = el.clientWidth || 1,
        h = el.clientHeight || 1;
      r.setSize(w, h);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    this.bindClicks(r.domElement);
    this.off.push(() => ro.disconnect());
    r.setAnimationLoop(() => this.frame());
    this.ready = true;
  }

  destroy() {
    this.dead = true;
    this.off.forEach((f) => f());
    if (!this.ready) return;
    this.renderer.setAnimationLoop(null);
    this.controls.dispose();
    this.screenWall?.dispose();
    this.disposeTree(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  update(s: GameState) {
    if (!this.ready || !s.night) return;
    const layout = layoutFor(s.level);
    const fresh = layout !== this.layout;
    if (fresh) this.build(layout, s);
    this.djOn =
      s.bookedTalent.length > 0 && s.night.minute >= nightData.djSetStartMinute;
    this.syncStaff(s);
    this.syncStage(s);
    this.syncHosts(s);
    this.syncVip(s);
    this.energy = s.night.energy ?? 50;
    this.syncScreen(s);
    this.peak = isPeakTime(s);
    this.anthem =
      !!s.night.tactics?.djAnthem && tacticActive(s.night, "djAnthem");
    this.applyScreens();

    const queue = s.night.guests.filter((g) => g.state === "queue");
    const queueIndex = new Map(queue.map((g, i) => [g.id, i]));
    for (const g of s.night.guests) {
      let p = this.guests.get(g.id);
      if (g.state === "pending" || (g.state === "left" && !p)) continue;
      // ponytail: past this many sprites the extra guests aren't drawn (the sim still counts them). Raise with GPU headroom.
      if (!p && this.guests.size >= MAX_GUEST_SPRITES) continue;
      const [tx, tz] = this.spot(zoneFor[g.state], g.id, queueIndex.get(g.id));
      // Guests already inside when the scene (re)opens appear in place instead of all walking in again.
      if (!p)
        p = this.spawnGuest(g.id, fresh ? [tx, tz] : this.entrance(), g.female);
      if (!p.held) [p.tx, p.tz] = [tx, tz];
      p.leaving = g.state === "left";
      p.mode = g.state === "dance" ? "dance" : "idle";
      // Satisfaction as brightness: unhappy guests fade toward grey.
      const v = 0.6 + (g.satisfaction / 100) * 0.4;
      (p.sprite.material as THREE.SpriteMaterial).color.setRGB(v, v, v);
      p.alert!.visible = p.ring!.visible = isAtFightRisk(g);

      const prev = this.budgets.get(g.id);
      if (prev !== undefined && g.budget < prev)
        this.spent.set(g.id, (this.spent.get(g.id) ?? 0) + prev - g.budget);
      if (
        prev !== undefined &&
        g.state === "bar" &&
        g.budget < prev &&
        isInside(g)
      )
        this.float(p, `+${prev - g.budget}`);
      this.budgets.set(g.id, g.budget);
    }

    const dj = s.bookedTalent[0];
    const n = s.night;
    const sparkling = !!n.tactics?.sparkler && tacticActive(n, "sparkler");
    this.syncSparks(sparkling);
    const callout = sparkling
      ? { kicker: en.videotron.bottles, text: en.videotron.sparklers }
      : n.tactics?.djAnthem && tacticActive(n, "djAnthem")
        ? { kicker: en.videotron.anthem, text: dj ? djs[dj].name : "NYXERON" }
        : n.tactics?.mcHype && tacticActive(n, "mcHype")
          ? { kicker: en.videotron.mc, text: en.videotron.handsUp }
          : n.tactics?.hostsFloor && tacticActive(n, "hostsFloor")
            ? { kicker: en.videotron.floor, text: en.videotron.everybody }
            : null;
    this.tron = {
      callout,
      dj: this.djOn && dj ? djs[dj].name : null,
      top: [...this.spent]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, spent]) => ({ name: this.guestName(id), spent })),
    };

    // Security reacts to what just happened tonight: escorts and fights send a bodyguard over.
    for (const e of s.log.slice(this.logSeen))
      if (e.day === s.day && (e.kind === "guestEscorted" || e.kind === "fight"))
        this.dispatchSecurity(e.guest);
    this.logSeen = s.log.length;
  }

  // ---------- building the room ----------

  private build(layout: Layout, s: GameState) {
    this.disposeTree(this.root);
    this.fx?.dispose();
    this.fx = null;
    this.screenWall?.dispose();
    const count = (k: ScreenKind) =>
      layout.screens.filter((x) => x.kind === k).length;
    // Ad slots can switch to clips (ads off in Settings), so they count toward the clip players too.
    this.screenWall = new ScreenWall(this.playlist!, {
      clip: count("clip") + count("ad"),
      ad: count("ad"),
    });
    this.wallScreens = [];
    this.screenKey = "";
    this.root.clear();
    this.grid = this.selBox = null;
    this.cabinetHits = [];
    this.hovered = null;
    this.selected = -1;
    this.sparks = [];
    this.guests.clear();
    this.staff = [];
    this.stage = [];
    this.hosts = [];
    this.vipGuests = [];
    this.staffKey = this.stageKey = this.screenDj = "";
    this.floats = [];
    this.budgets.clear();
    this.spent.clear();
    this.videotron?.tex.dispose();
    this.videotron = null;
    this.spots = [];
    this.beams = [];
    this.walls = [];
    this.leds = [];
    this.screen = null;
    this.logSeen = s.log.length;
    this.layout = layout;
    this.wallH = layout.wallHeight ?? WALL_H;
    this.zones = new Map();
    this.zoneList = new Map();
    for (const z of layout.zones) {
      if (!this.zones.has(z.id)) this.zones.set(z.id, z);
      this.zoneList.set(z.id, [...(this.zoneList.get(z.id) ?? []), z]);
    }
    const tex = this.assets!.tex;

    const floorMat = (
      t: THREE.Texture | undefined,
      w: number,
      h: number,
      color: number,
      per = 4,
    ) => {
      const m = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.85,
        metalness: 0.05,
      });
      if (t) {
        const tt = t.clone();
        tt.wrapS = tt.wrapT = THREE.RepeatWrapping;
        tt.repeat.set(w / per, h / per);
        tt.needsUpdate = true;
        m.map = tt;
      }
      return m;
    };
    const plane = (
      x: number,
      z: number,
      w: number,
      h: number,
      mat: THREE.Material,
      y = 0,
    ) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x + w / 2, y, z + h / 2);
      this.root.add(m);
      return m;
    };

    const hall = layout.hall ?? layout.h;
    plane(
      0,
      0,
      layout.w,
      hall,
      floorMat(tex.concrete, layout.w, hall, 0x8a8494),
    );
    for (const z of layout.zones) {
      // The VIP lounge is built from the office (Build tab); until then it is roped off.
      const locked = z.id === "vip" && !s.upgrades?.vip;
      if (z.solid) this.buildBlock(z);
      else if (z.id === "dance") this.buildDanceFloor(z);
      else if (z.id === "pool") this.buildPool(z);
      else if (z.elevation) this.buildMezzanine(z, locked, tex.wood);
      else if (z.id === "deck")
        plane(
          z.x,
          z.y,
          z.w,
          z.h,
          floorMat(tex.wood, z.w, z.h, 0xb08a66, 3),
          0.002,
        );
      else {
        const woodish =
          z.id === "seating" ||
          z.id === "barFront" ||
          z.id === "backbar" ||
          z.id === "vip" ||
          z.id === "office";
        const t = z.outside ? tex.asphalt : woodish ? tex.wood : undefined;
        const color = locked
          ? 0x3a3340
          : z.outside
            ? 0x7d8aa0
            : woodish
              ? 0xc9a27e
              : 0x2a2533;
        plane(
          z.x,
          z.y,
          z.w,
          z.h,
          floorMat(t, z.w, z.h, color, z.outside ? 3 : 4),
          0.004,
        );
      }
      if (z.label) this.label(z, locked);
    }
    for (const lane of this.zoneList.get("backbar") ?? [])
      this.buildCabinet(lane, lane.x > layout.w / 2);
    if (layout.hall) this.buildBeach(layout);
    this.furnitureRoot = new THREE.Group();
    this.root.add(this.furnitureRoot);
    this.items = loadFurniture(layout);
    this.rebuildFurniture();
    this.setEditing(this.editing);
    this.buildWalls(layout);
    this.buildLights();
    this.buildSpeakers(s.upgrades?.sound ?? 0);
    this.buildFx();
    this.rigLight = s.upgrades?.lighting ?? 0;
    this.frameCamera(layout);
  }

  private label(z: Zone, locked: boolean) {
    // A roped-off VIP says how to open it, in brighter text.
    const { tex, aspect } = textTexture(
      locked ? `${z.label} · ${en.venue.vipLocked}` : z.label!,
      {
        size: 48,
        color: locked ? "rgba(255,210,120,.9)" : "rgba(255,255,255,.55)",
      },
    );
    const h = 0.32;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(h * aspect, h),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
      }),
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(
      z.x + z.w / 2,
      (z.solid ? BLOCK_H : (z.elevation ?? 0)) + 0.012,
      z.y + z.h / 2 + (z.solid ? 0 : z.h * 0.3),
    );
    this.root.add(m);
  }

  /** Height of the floor at a point (a balcony is raised; everything else is at 0). */
  private elevationAt(x: number, z: number): number {
    for (const q of this.layout?.zones ?? [])
      if (
        q.elevation &&
        x >= q.x &&
        x <= q.x + q.w &&
        z >= q.y &&
        z <= q.y + q.h
      )
        return q.elevation;
    return 0;
  }

  /** Balcony: a slab on pillars, wood floor, glass railing with an LED strip, stairs down to the main floor. */
  private buildMezzanine(z: Zone, locked: boolean, wood?: THREE.Texture) {
    const h = z.elevation!;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(z.w, 0.22, z.h),
      new THREE.MeshStandardMaterial({
        color: 0x1c1826,
        roughness: 0.6,
        metalness: 0.3,
      }),
    );
    slab.position.set(z.x + z.w / 2, h - 0.11, z.y + z.h / 2);
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(z.w, z.h),
      new THREE.MeshStandardMaterial({
        color: locked ? 0x3a3340 : 0xc9a27e,
        map: wood ?? null,
        roughness: 0.8,
      }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.set(z.x + z.w / 2, h + 0.003, z.y + z.h / 2);
    this.root.add(slab, top);
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x2a2433,
      metalness: 0.5,
      roughness: 0.4,
    });
    for (const [px, pz] of [
      [z.x + 0.2, z.y + z.h - 0.2],
      [z.x + z.w - 0.2, z.y + z.h - 0.2],
      [z.x + z.w / 2, z.y + z.h - 0.2],
    ] as const) {
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.1, h, 12),
        pillarMat,
      );
      pillar.position.set(px, h / 2, pz);
      this.root.add(pillar);
    }
    // Glass railing on the open (south) edge and the side facing the room's middle, LED strip on top.
    const glass = new THREE.MeshStandardMaterial({
      color: 0x9fd8ff,
      transparent: true,
      opacity: 0.18,
      roughness: 0.1,
      metalness: 0.6,
      depthWrite: false,
    });
    const led = new THREE.MeshBasicMaterial({ color: PALETTE[1] });
    const inner = z.x + z.w / 2 < (this.layout?.w ?? 0) / 2 ? z.x + z.w : z.x;
    const rails: [number, number, number, number][] = [
      [z.x + z.w / 2, z.y + z.h, z.w, 0.04], // south edge
      [inner, z.y + z.h / 2, 0.04, z.h], // edge facing the DJ / floor
    ];
    for (const [rx, rz, rw, rd] of rails) {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.9, rd), glass);
      pane.position.set(rx, h + 0.45, rz);
      const strip = new THREE.Mesh(
        new THREE.BoxGeometry(Math.max(rw, 0.05), 0.04, Math.max(rd, 0.05)),
        led,
      );
      strip.position.set(rx, h + 0.92, rz);
      this.root.add(pane, strip);
    }
    // Stairs down from the balcony's outer south corner.
    const outer = inner === z.x ? z.x + z.w - 0.6 : z.x + 0.6;
    const steps = 8;
    const stepMat = new THREE.MeshStandardMaterial({
      color: 0x241f2e,
      roughness: 0.7,
    });
    for (let i = 0; i < steps; i++) {
      const st = new THREE.Mesh(
        new THREE.BoxGeometry(1, (h / steps) * (i + 1), 0.32),
        stepMat,
      );
      st.position.set(
        outer,
        ((h / steps) * (i + 1)) / 2,
        z.y + z.h + 0.16 + (steps - 1 - i) * 0.32,
      );
      this.root.add(st);
    }
  }

  /** Pool: stone rim, glowing water whose ripple texture drifts in frame(), underwater light. */
  private buildPool(z: Zone) {
    const rim = new THREE.Mesh(
      new THREE.BoxGeometry(z.w + 0.5, 0.12, z.h + 0.5),
      new THREE.MeshStandardMaterial({ color: 0xe8e2d6, roughness: 0.9 }),
    );
    rim.position.set(z.x + z.w / 2, 0.06, z.y + z.h / 2);
    const ripple = canvasTexture(128, 128, (ctx) => {
      ctx.fillStyle = "#0a6f8f";
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 70; i++) {
        ctx.strokeStyle = `rgba(160,240,255,${0.15 + Math.random() * 0.25})`;
        ctx.lineWidth = 1 + Math.random() * 2;
        ctx.beginPath();
        const x = Math.random() * 128,
          y = Math.random() * 128;
        ctx.ellipse(
          x,
          y,
          6 + Math.random() * 14,
          2 + Math.random() * 4,
          0,
          0,
          Math.PI * 2,
        );
        ctx.stroke();
      }
    });
    ripple.wrapS = ripple.wrapT = THREE.RepeatWrapping;
    ripple.repeat.set(z.w / 3, z.h / 3);
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(z.w, z.h),
      new THREE.MeshStandardMaterial({
        map: ripple,
        color: 0x5fd6ff,
        emissive: 0x0b7fa8,
        emissiveIntensity: 0.9,
        roughness: 0.15,
        metalness: 0.2,
      }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.set(z.x + z.w / 2, 0.125, z.y + z.h / 2);
    const light = new THREE.PointLight(0x33d6ff, 6, 10, 1.4);
    light.position.set(z.x + z.w / 2, 0.6, z.y + z.h / 2);
    this.root.add(rim, water, light);
    this.pool = ripple;
  }

  /** Open-air side: the sea to the horizon, a moon, palms on the deck corners, a low glass rail round the deck. */
  private buildBeach(layout: Layout) {
    const hall = layout.hall!;
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.w + 120, 80),
      new THREE.MeshStandardMaterial({
        color: 0x16406e,
        emissive: 0x0a2447,
        emissiveIntensity: 0.8,
        roughness: 0.2,
        metalness: 0.4,
      }),
    );
    sea.rotation.x = -Math.PI / 2;
    sea.position.set(layout.w / 2, -0.3, layout.h + 40);
    const sand = new THREE.Mesh(
      new THREE.PlaneGeometry(layout.w + 20, 3),
      new THREE.MeshStandardMaterial({ color: 0x8a7a60, roughness: 1 }),
    );
    sand.rotation.x = -Math.PI / 2;
    sand.position.set(layout.w / 2, -0.15, layout.h + 1.5);
    const moon = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: canvasTexture(64, 64, (ctx) => {
          const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
          g.addColorStop(0, "rgba(255,250,230,1)");
          g.addColorStop(0.45, "rgba(255,245,210,.9)");
          g.addColorStop(1, "rgba(255,240,200,0)");
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 64, 64);
        }),
        transparent: true,
        fog: false,
      }),
    );
    moon.scale.set(9, 9, 1);
    moon.position.set(layout.w * 0.7, 14, layout.h + 60);
    // Moonlight on the water.
    const glint = new THREE.Mesh(
      new THREE.PlaneGeometry(3, 60),
      new THREE.MeshBasicMaterial({
        color: 0xfff1c9,
        transparent: true,
        opacity: 0.12,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    glint.rotation.x = -Math.PI / 2;
    glint.position.set(layout.w * 0.7, -0.28, layout.h + 32);
    this.root.add(sea, sand, moon, glint);

    const rail = new THREE.MeshStandardMaterial({
      color: 0xbfe6ff,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    for (const [x, z, w, d] of [
      [layout.w / 2, layout.h, layout.w, 0.05],
      [0, (hall + layout.h) / 2, 0.05, layout.h - hall],
      [layout.w, (hall + layout.h) / 2, 0.05, layout.h - hall],
    ] as const) {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(w, 0.9, d), rail);
      pane.position.set(x, 0.45, z);
      this.root.add(pane);
    }

    const trunk = new THREE.MeshStandardMaterial({
      color: 0x5a4030,
      roughness: 1,
    });
    const leaf = new THREE.MeshStandardMaterial({
      color: 0x1f6b3a,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    for (const [px, pz] of [
      [0.8, hall + 0.8],
      [layout.w - 0.8, hall + 0.8],
      [0.8, layout.h - 0.8],
      [layout.w - 0.8, layout.h - 0.8],
    ] as const) {
      const palm = new THREE.Group();
      for (let i = 0; i < 6; i++) {
        const seg = new THREE.Mesh(
          new THREE.CylinderGeometry(0.1, 0.13, 0.6, 8),
          trunk,
        );
        seg.position.set(Math.sin(i * 0.35) * 0.12 * i, 0.3 + i * 0.58, 0);
        palm.add(seg);
      }
      for (let i = 0; i < 7; i++) {
        const frond = new THREE.Mesh(
          new THREE.ConeGeometry(0.28, 1.9, 4, 1, true),
          leaf,
        );
        const pivot = new THREE.Group();
        pivot.position.set(Math.sin(5 * 0.35) * 0.6, 0, 0);
        pivot.rotation.y = (i / 7) * Math.PI * 2;
        frond.position.set(0.85, 3.45, 0);
        frond.rotation.set(0, 0, -1.2);
        pivot.add(frond);
        palm.add(pivot);
      }
      palm.position.set(px, 0, pz);
      this.root.add(palm);
    }
  }

  /** Furniture as a solid box with coloured LED trim along its top edges. */
  private buildBlock(z: Zone) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(z.w, BLOCK_H, z.h),
      new THREE.MeshStandardMaterial({
        color: z.id === "counter" ? 0x3b3140 : 0x2c2638,
        roughness: 0.5,
        metalness: 0.3,
      }),
    );
    box.position.set(z.x + z.w / 2, BLOCK_H / 2, z.y + z.h / 2);
    this.root.add(box);
    const edge =
      z.id === "dj" ? PALETTE[1]! : z.id === "stage" ? PALETTE[0]! : 0xffb020;
    const trim = new THREE.LineSegments(
      new THREE.EdgesGeometry(box.geometry),
      new THREE.LineBasicMaterial({ color: edge }),
    );
    trim.position.copy(box.position);
    this.root.add(trim);
  }

  /** LED dance floor: one additive tile per cell; colour and brightness follow the beat in frame(). */
  private buildDanceFloor(z: Zone) {
    const base = new THREE.Mesh(
      new THREE.PlaneGeometry(z.w, z.h),
      new THREE.MeshStandardMaterial({
        color: 0x0b0910,
        roughness: 0.3,
        metalness: 0.6,
      }),
    );
    base.rotation.x = -Math.PI / 2;
    base.position.set(z.x + z.w / 2, 0.006, z.y + z.h / 2);
    this.root.add(base);
    const cells: [number, number][] = [];
    for (let x = 0; x < z.w; x++)
      for (let y = 0; y < z.h; y++) cells.push([x, y]);
    const geo = new THREE.PlaneGeometry(0.92, 0.92);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      cells.length,
    );
    const m = new THREE.Matrix4();
    cells.forEach(([x, y], i) => {
      mesh.setMatrixAt(
        i,
        m.makeTranslation(z.x + x + 0.5, 0.012, z.y + y + 0.5),
      );
      mesh.setColorAt(i, new THREE.Color(0));
    });
    this.root.add(mesh);
    // The floor also throws its colour onto the dancers.
    const light = new THREE.PointLight(0xffffff, 0, 9, 1.2);
    light.position.set(z.x + z.w / 2, 0.8, z.y + z.h / 2);
    this.root.add(light);
    this.leds.push({ mesh, cells, light });
  }

  /** Back-bar liquor cabinet: shelves of bottles in front of a warm backlight, plus a glass-door fridge. */
  private buildCabinet(lane: Zone, eastWall = false) {
    const alongX = lane.w >= lane.h;
    const len = alongX ? lane.w : lane.h;
    const depth = 0.34,
      height = 2.1;
    const g = new THREE.Group();
    const wood = new THREE.MeshStandardMaterial({
      color: 0x3a2618,
      roughness: 0.7,
    });
    const carcass = new THREE.Mesh(
      new THREE.BoxGeometry(len, height, 0.06),
      wood,
    );
    carcass.position.set(len / 2, height / 2, 0.03);
    g.add(carcass);
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(len - 0.2, height - 0.7),
      new THREE.MeshBasicMaterial({
        color: 0xffa24a,
        transparent: true,
        opacity: 0.55,
      }),
    );
    glow.position.set(len / 2, 0.6 + (height - 0.7) / 2, 0.065);
    g.add(glow);
    const shelfYs = [0.62, 1.12, 1.62];
    for (const y of shelfYs) {
      const shelf = new THREE.Mesh(
        new THREE.BoxGeometry(len - 0.1, 0.04, depth),
        wood,
      );
      shelf.position.set(len / 2, y, depth / 2);
      g.add(shelf);
    }
    // Four labelled sections of bottles; the fridge at the end holds beer and soft drinks.
    const secW = (len - 1.1) / SHELVES.length;
    const perSec = Math.floor((secW - 0.12) / 0.13);
    const bottleGeo = new THREE.CylinderGeometry(0.035, 0.042, 0.24, 10);
    bottleGeo.translate(0, 0.12, 0);
    const bottles = new THREE.InstancedMesh(
      bottleGeo,
      new THREE.MeshStandardMaterial({
        roughness: 0.15,
        metalness: 0.2,
        transparent: true,
        opacity: 0.88,
        emissive: 0x221100,
      }),
      perSec * shelfYs.length * SHELVES.length,
    );
    const m = new THREE.Matrix4();
    let i = 0;
    const hit = (
      drink: DrinkId,
      x: number,
      y: number,
      w: number,
      h: number,
    ) => {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(w, h, depth + 0.06),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      box.position.set(x, y, (depth + 0.06) / 2);
      box.userData.drink = drink;
      g.add(box);
      this.cabinetHits.push(box);
    };
    const plate = (text: string, x: number, y: number) => {
      const { tex, aspect } = textTexture(text, {
        size: 44,
        weight: "700",
        color: "#ffd9a8",
      });
      const hgt = 0.13;
      const lbl = new THREE.Mesh(
        new THREE.PlaneGeometry(hgt * aspect, hgt),
        new THREE.MeshBasicMaterial({
          map: tex,
          transparent: true,
          depthWrite: false,
        }),
      );
      lbl.position.set(x, y, 0.08);
      g.add(lbl);
    };
    SHELVES.forEach(({ drink, glass }, sec) => {
      const x0 = 0.1 + sec * secW;
      for (const y of shelfYs)
        for (let k = 0; k < perSec; k++) {
          m.makeTranslation(x0 + 0.12 + k * 0.13, y + 0.02, depth * 0.55);
          bottles.setMatrixAt(i, m);
          bottles.setColorAt(
            i,
            new THREE.Color(glass[Math.floor(hash(i + 3) * glass.length)]!),
          );
          i++;
        }
      hit(drink, x0 + secW / 2, 1.3, secW - 0.04, 1.5);
      plate(drinks[drink].name.toUpperCase(), x0 + secW / 2, height - 0.12);
    });
    g.add(bottles);
    hit("beer", len - 0.45, 0.83, 0.72, 0.55);
    hit("softDrink", len - 0.45, 0.28, 0.72, 0.55);
    plate(
      `${drinks.beer.name} · ${drinks.softDrink.name}`.toUpperCase(),
      len - 0.45,
      1.25,
    );
    // Beer fridge at the far end, glowing through its glass door.
    const fridge = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 1.1, depth + 0.05),
      new THREE.MeshStandardMaterial({
        color: 0x1b1d22,
        roughness: 0.4,
        metalness: 0.5,
      }),
    );
    fridge.position.set(len - 0.45, 0.55, (depth + 0.05) / 2);
    g.add(fridge);
    const door = new THREE.Mesh(
      new THREE.PlaneGeometry(0.58, 0.95),
      new THREE.MeshBasicMaterial({
        color: 0x9fd8ff,
        transparent: true,
        opacity: 0.55,
      }),
    );
    door.position.set(len - 0.45, 0.55, depth + 0.052);
    g.add(door);

    if (alongX) g.position.set(lane.x, 0, lane.y);
    else if (eastWall) {
      // Against the east wall, facing west into the room: local x → world +z, local depth → world −x.
      g.rotation.y = -Math.PI / 2;
      g.position.set(lane.x + lane.w, 0, lane.y);
    } else {
      // Lane runs along z (cabinet against the x = lane.x wall): local x → world −z, local depth → world +x.
      g.rotation.y = Math.PI / 2;
      g.position.set(lane.x, 0, lane.y + len);
    }
    this.root.add(g);
  }

  /** Four walls (the south one has the entrance gap). Each hides when it sits between the camera and the room. */
  private buildWalls(layout: Layout) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x14111c,
      roughness: 0.9,
    });
    const strip = new THREE.MeshBasicMaterial({ color: PALETTE[0] });
    const T = 0.12;
    const wall = (x: number, z: number, w: number, d: number) => {
      const g = new THREE.Group();
      const body = new THREE.Mesh(new THREE.BoxGeometry(w, this.wallH, d), mat);
      body.position.set(x + w / 2, this.wallH / 2, z + d / 2);
      const led = new THREE.Mesh(
        new THREE.BoxGeometry(w, 0.05, d + 0.02),
        strip,
      );
      led.position.set(x + w / 2, this.wallH, z + d / 2);
      g.add(body, led);
      this.root.add(g);
      return g;
    };
    const { w } = layout;
    // Walls stop at the hall when the rest is an open-air deck.
    const h = layout.hall ?? layout.h;
    const door = this.zones.get("entrance");
    /** One side of the room, with a gap where the entrance meets it. */
    const side = (
      horizontal: boolean,
      fixed: number,
      len: number,
      doorOn: boolean,
    ) => {
      const g = new THREE.Group();
      const seg = (from: number, to: number) => {
        if (to - from <= 0.01) return;
        g.add(
          horizontal
            ? wall(from, fixed, to - from, T)
            : wall(fixed, from, T, to - from),
        );
      };
      if (door && doorOn) {
        const [a, b] = horizontal
          ? [door.x, door.x + door.w]
          : [door.y, door.y + door.h];
        seg(0, a);
        seg(b, len);
      } else seg(0, len);
      this.root.add(g);
      return g;
    };
    this.walls.push({
      mesh: side(true, -T, w, !!door && door.y <= 0),
      visible: (c) => c.z > 0,
    });
    this.walls.push({
      mesh: side(false, -T, h, !!door && door.x <= 0),
      visible: (c) => c.x > 0,
    });
    this.walls.push({
      mesh: side(false, w, h, !!door && door.x + door.w >= w),
      visible: (c) => c.x < w,
    });
    // No south wall on a beach club: the hall opens straight onto the deck.
    this.walls.push({
      mesh: layout.hall
        ? new THREE.Group()
        : side(true, h, w, !!door && door.y + door.h >= h),
      visible: (c) => c.z < h,
    });

    // Clip / ad screens on the walls, facing into the room (each hides with its wall).
    const wallIndex = { n: 0, w: 1, e: 2, s: 3 } as const;
    for (const slot of layout.screens) {
      // Clip screens (3:4) grow with the wall: tall LED panels on a double-height hall.
      const base = SCREEN_SIZE[slot.kind];
      const k =
        slot.kind === "clip" ? Math.min(1.7, (this.wallH - 0.7) / base.h) : 1;
      const [sw, sh] = [base.w * k, base.h * k];
      // Below the ceiling, but not lower than eye level allows.
      const y = Math.min(
        this.wallH - 0.15 - sh / 2,
        // On a double-height wall they clear the back-bar cabinets.
        Math.max((this.wallH > 5 ? 2.4 : 1) + sh / 2, 4.2 - sh / 2),
      );
      const [pos, rot] = {
        n: [new THREE.Vector3(slot.at, y, 0.04), 0],
        w: [new THREE.Vector3(0.04, y, slot.at), Math.PI / 2],
        e: [new THREE.Vector3(w - 0.04, y, slot.at), -Math.PI / 2],
        s: [new THREE.Vector3(slot.at, y, h - 0.04), Math.PI],
      }[slot.wall] as [THREE.Vector3, number];
      const smat = new THREE.MeshBasicMaterial({ toneMapped: false });
      this.wallScreens.push({
        kind: slot.kind,
        mat: smat,
        aspect: sw / sh,
        ad:
          slot.kind === "ad"
            ? this.screenWall!.texture("ad", sw / sh)
            : undefined,
      });
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), smat);
      scr.position.copy(pos);
      scr.rotation.y = rot;
      const bezel = new THREE.Mesh(
        new THREE.BoxGeometry(sw + 0.12, sh + 0.12, 0.05),
        new THREE.MeshStandardMaterial({ color: 0x050507 }),
      );
      bezel.position
        .copy(pos)
        .addScaledVector(
          new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot)),
          -0.04,
        );
      bezel.rotation.y = rot;
      this.walls[wallIndex[slot.wall]]!.mesh.add(bezel, scr);
    }

    // Concert screen on the back wall above the stage / DJ booth.
    const stage = this.zones.get("stage"),
      dj = this.zones.get("dj");
    if (!stage && !dj) return;
    const span = layout.mainScreen;
    const x0 = span
      ? span.from
      : Math.min(stage?.x ?? Infinity, dj?.x ?? Infinity) + 0.2;
    const x1 = span
      ? span.to
      : Math.max(
          stage ? stage.x + stage.w : -Infinity,
          dj ? dj.x + dj.w : -Infinity,
        ) - 0.2;
    const sw = x1 - x0,
      sh = Math.min(this.wallH - 1.1, sw * 0.5625);
    const idle = textTexture("NYXERON", {
      size: 120,
      weight: "800",
      font: "Inter Tight, sans-serif",
    }).tex;
    const mat2 = new THREE.MeshBasicMaterial({ map: idle, toneMapped: false });
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), mat2);
    scr.position.set((x0 + x1) / 2, this.wallH - 0.25 - sh / 2, 0.04); // in front of the bezel face (z 0.025)
    const bezel = new THREE.Mesh(
      new THREE.BoxGeometry(sw + 0.16, sh + 0.16, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x050507 }),
    );
    bezel.position.set(scr.position.x, scr.position.y, 0);
    this.walls[0]!.mesh.add(bezel, scr);
    this.screen = { mat: mat2, idle };

    // Videotron on top of the wall, right above the DJ: shoutouts and top spenders.
    this.videotron = new Videotron();
    const vh = sw / VIDEOTRON_ASPECT;
    const vy = this.wallH + 0.12 + vh / 2;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(sw, vh),
      new THREE.MeshBasicMaterial({
        map: this.videotron.tex,
        toneMapped: false,
      }),
    );
    board.position.set(scr.position.x, vy, 0.04);
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(sw + 0.16, vh + 0.16, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x050507, metalness: 0.6 }),
    );
    frame.position.set(scr.position.x, vy, -0.05);
    this.walls[0]!.mesh.add(frame, board);
  }

  private buildLights() {
    this.root.add(new THREE.AmbientLight(0x6a5a8a, 0.9));
    this.root.add(new THREE.HemisphereLight(0x8878ff, 0x201830, 0.6));
    const point = (zone: ZoneId, color: number, intensity: number, y = 1.8) => {
      const z = this.zones.get(zone);
      if (!z) return;
      const l = new THREE.PointLight(color, intensity, 8, 1.2);
      l.position.set(z.x + z.w / 2, y, z.y + z.h / 2);
      this.root.add(l);
    };
    point("barFront", 0xffa24a, 6);
    point("entrance", 0xffd9a0, 4);
    point("dj", PALETTE[1]!, 5, 2.2);
    point("seating", 0xa855f7, 2.5);
    const dance = this.zones.get("dance");
    if (dance)
      for (let i = 0; i < 3; i++) {
        const l = new THREE.SpotLight(PALETTE[i], 40, 18, 0.32, 0.6, 1.2);
        l.position.set(dance.x + dance.w / 2, 6, dance.y + dance.h / 2);
        this.root.add(l, l.target);
        this.spots.push({ light: l, phase: i * 2.1 });
      }
    // Light beams out of the booth, like light cutting through haze.
    const src = this.zones.get("dj") ?? this.zones.get("stage");
    if (src) {
      const geo = new THREE.ConeGeometry(0.9, 7, 24, 1, true);
      geo.translate(0, -3.5, 0); // apex at the origin
      for (let i = 0; i < 4; i++) {
        const beam = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({
            color: PALETTE[i],
            transparent: true,
            opacity: 0.07,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
          }),
        );
        beam.position.set(src.x + src.w / 2, 2.6, src.y + src.h / 2);
        this.root.add(beam);
        this.beams.push(beam);
      }
    }
  }

  private frameCamera(layout: Layout) {
    const target = new THREE.Vector3(layout.w / 2, 0, layout.h / 2 + 0.5);
    const d = Math.max(layout.w, layout.h) * 1.05 + 3;
    this.controls.target.copy(target);
    this.camera.position.set(
      target.x + d * 0.62,
      d * 0.72,
      target.z + d * 0.78,
    );
    this.controls.update();
  }

  // ---------- wall screens ----------

  /** Player settings for the wall screens (from VenueView). */
  setScreenPrefs(prefs: { clips: ClipMode; ads: boolean }) {
    this.prefs = prefs;
    this.applyScreens();
  }

  /**
   * Dancer / club clips only at peak hours (or always / never, per Settings); before that the screens run the
   * visualizer. Ad slots show sponsors, or join the clip screens when ads are off.
   */
  private applyScreens() {
    const wall = this.screenWall;
    if (!wall) return;
    const { clips, ads } = this.prefs;
    const showClips = clips === "always" || (clips === "peak" && this.peak);
    const key = `${showClips}|${ads}`;
    if (key === this.screenKey) return;
    this.screenKey = key;
    for (const w of this.wallScreens) {
      if (w.kind === "ad" && ads) w.mat.map = w.ad!;
      else if (showClips) w.mat.map = w.clip ??= wall.texture("clip", w.aspect);
      else w.mat.map = wall.fallback("clip");
      w.mat.needsUpdate = true;
    }
    wall.setPlaying("clip", showClips);
    wall.setPlaying("ad", ads);
  }

  // ---------- furniture & layout editor ----------

  private rebuildFurniture() {
    this.disposeTree(this.furnitureRoot);
    this.furnitureRoot.clear();
    this.pieces = this.items.map((it, i) => {
      const g = buildFurniture(it.kind, PALETTE[i % PALETTE.length]!);
      g.position.set(it.x, this.elevationAt(it.x, it.z), it.z);
      g.rotation.y = (it.rot * Math.PI) / 2;
      this.furnitureRoot.add(g);
      return g;
    });
    // Seats belong to whichever guest zone they fall in.
    this.seats.clear();
    for (const it of this.items)
      for (const [x, z] of seatsOf(it)) {
        const zone = this.layout!.zones.find(
          (q) => x >= q.x && x <= q.x + q.w && z >= q.y && z <= q.y + q.h,
        );
        if (zone)
          this.seats.set(zone.id, [...(this.seats.get(zone.id) ?? []), [x, z]]);
      }
    this.select(Math.min(this.selected, this.items.length - 1));
  }

  private commitFurniture() {
    saveFurniture(this.layout!, this.items);
    this.rebuildFurniture();
  }

  private select(i: number) {
    this.selected = i;
    if (this.selBox) {
      this.root.remove(this.selBox);
      this.selBox.dispose();
      this.selBox = null;
    }
    const g = this.pieces[i];
    if (this.editing && g) {
      this.selBox = new THREE.BoxHelper(g, 0xffffff);
      this.root.add(this.selBox);
    }
    this.onSelect?.(this.editing ? i : -1);
  }

  setEditing(on: boolean) {
    this.editing = on;
    if (!this.ready || !this.layout) return;
    if (on && !this.grid) {
      const { w, h } = this.layout;
      const n = Math.max(w, h);
      this.grid = new THREE.GridHelper(n, n * 2, 0xffffff, 0xffffff);
      (this.grid.material as THREE.Material).opacity = 0.12;
      (this.grid.material as THREE.Material).transparent = true;
      this.grid.position.set(n / 2, 0.02, n / 2);
      this.root.add(this.grid);
    }
    if (this.grid) this.grid.visible = on;
    this.select(on ? this.selected : -1);
  }

  /** Drops a new piece where the camera is looking. */
  addFurniture(kind: FurnitureKind) {
    if (!this.layout) return;
    const t = this.controls.target;
    this.items.push({ kind, ...this.snap(t.x, t.z), rot: 0 });
    this.commitFurniture();
    this.select(this.items.length - 1);
  }

  rotateSelected() {
    const it = this.items[this.selected];
    if (!it) return;
    it.rot = (it.rot + 1) % 4;
    this.commitFurniture();
  }

  deleteSelected() {
    if (!this.items[this.selected]) return;
    this.items.splice(this.selected, 1);
    this.selected = -1;
    this.commitFurniture();
  }

  resetFurniture() {
    if (!this.layout) return;
    saveFurniture(this.layout, null);
    this.items = defaultFurniture(this.layout);
    this.selected = -1;
    this.rebuildFurniture();
  }

  /** Quarter-tile grid, kept inside the room. */
  private snap(x: number, z: number) {
    const { w, h } = this.layout!;
    const q = (v: number, max: number) =>
      Math.min(max - 0.25, Math.max(0.25, Math.round(v * 4) / 4));
    return { x: q(x, w), z: q(z, h) };
  }

  // ---------- people ----------

  private addPerson(
    tex: THREE.Texture | undefined,
    h: number,
    x: number,
    z: number,
    mode: Person["mode"],
    seed: number,
  ): Person {
    const g = new THREE.Group();
    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(h * 0.55, h * 0.3),
      new THREE.MeshBasicMaterial({
        map: this.shadowTex,
        transparent: true,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.015;
    const mat = new THREE.SpriteMaterial({
      map: tex ?? null,
      color: tex ? 0xffffff : 0xdddddd,
      alphaTest: 0.5,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.center.set(0.5, 0);
    const aspect = tex
      ? (tex.image as HTMLImageElement).width /
        (tex.image as HTMLImageElement).height
      : 0.35;
    sprite.scale.set(h * aspect, h, 1);
    g.add(shadow, sprite);
    g.position.set(x, 0, z);
    this.root.add(g);
    return {
      g,
      sprite,
      h,
      tx: x,
      tz: z,
      leaving: false,
      fade: 1,
      mode,
      seed,
      lift: 0,
    };
  }

  private spawnGuest(
    id: number,
    at: [number, number],
    female?: boolean,
  ): Person {
    // Sprites 1–5 are men, 6–10 women; match the simulated guest.
    const all = this.assets!.guests;
    const list =
      all.length === 10 && female !== undefined
        ? female
          ? all.slice(5)
          : all.slice(0, 5)
        : all;
    const tex = list.length
      ? list[Math.floor(hash(id + 31) * list.length)]
      : undefined;
    const p = this.addPerson(
      tex,
      PERSON_H * (0.9 + hash(id + 5) * 0.18),
      at[0],
      at[1],
      "idle",
      id,
    );
    const alert = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: this.alertTex.tex, depthTest: false }),
    );
    alert.center.set(0.5, 0);
    alert.scale.set(0.42 * this.alertTex.aspect, 0.42, 1);
    alert.position.y = p.h + 0.08;
    alert.visible = false;
    alert.userData.guest = id;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.22, 0.32, 28),
      new THREE.MeshBasicMaterial({
        color: 0xff2a2a,
        transparent: true,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.025;
    ring.visible = false;
    p.g.add(alert, ring);
    p.alert = alert;
    p.ring = ring;
    this.guests.set(id, p);
    return p;
  }

  private zonePoint(
    zone: ZoneId,
    fx: number,
    fz: number,
  ): [number, number] | null {
    const z = this.zones.get(zone);
    return z ? [z.x + z.w * fx, z.y + z.h * fz] : null;
  }

  /** Bartenders and security follow the hired counts. Two bodyguards hold the door, the rest patrol. */
  private syncStaff(s: GameState) {
    const a = this.assets!;
    const bartenders = Math.min(6, Math.max(1, s.staff.bartender)); // the owner pours at the booth
    const bouncers = Math.min(5, s.staff.security);
    const key = `${bartenders}|${bouncers}`;
    if (key === this.staffKey) return;
    this.staffKey = key;
    this.staff.forEach((p) => this.remove(p));
    this.staff = [];
    const lanes = this.zoneList.get("backbar") ?? [];
    for (let i = 0; i < bartenders && lanes.length; i++) {
      // Spread over every bar; in the lane between the counter and the cabinet.
      const lane = lanes[i % lanes.length]!;
      const perLane = Math.ceil(bartenders / lanes.length);
      const along = (Math.floor(i / lanes.length) + 0.5) / perLane;
      const east = lane.x > (this.layout?.w ?? 0) / 2;
      const [x, z] =
        lane.w >= lane.h
          ? [lane.x + along * lane.w, lane.y + 0.62]
          : [
              east ? lane.x + lane.w - 0.62 : lane.x + 0.62,
              lane.y + along * lane.h,
            ];
      this.staff.push(
        this.addPerson(
          a.bartenders[i % Math.max(1, a.bartenders.length)],
          PERSON_H,
          x,
          z,
          "work",
          900 + i,
        ),
      );
    }
    for (let i = 0; i < bouncers; i++) {
      const door = i < 2;
      const pos = door
        ? this.zonePoint("entrance", i % 2 ? 0.92 : 0.08, 0.4)
        : this.patrolPoint(950 + i);
      if (!pos) continue;
      const p = this.addPerson(
        a.bouncers[i % Math.max(1, a.bouncers.length)],
        PERSON_H * 1.12,
        pos[0],
        pos[1],
        "idle",
        950 + i,
      );
      p.home = door
        ? { kind: "post", x: pos[0], z: pos[1] }
        : { kind: "patrol", x: pos[0], z: pos[1], wait: 0 };
      p.task = p.home;
      this.staff.push(p);
    }
  }

  /** The booked DJ's own character in the booth once the set starts; MC or dancers on the stage. */
  private syncStage(s: GameState) {
    const a = this.assets!;
    const dj = s.bookedTalent[0];
    // The MC takes the stage for "MC hype"; otherwise dancers during the set.
    const hype = !!s.night?.tactics?.mcHype && tacticActive(s.night, "mcHype");
    const stageAct = this.zones.has("stage")
      ? s.level >= 4 && this.djOn && !hype
        ? "dancers"
        : "mc"
      : "none";
    const key = `${this.djOn ? dj : ""}|${stageAct}`;
    if (key === this.stageKey) return;
    this.stageKey = key;
    this.stage.forEach((p) => this.remove(p));
    this.stage = [];
    const add = (
      tex: THREE.Texture | undefined,
      zone: ZoneId,
      fx: number,
      mode: Person["mode"],
      seed: number,
      h = PERSON_H,
    ) => {
      const pos = this.zonePoint(zone, fx, zone === "dj" ? 0.55 : 0.5);
      if (!pos) return;
      const p = this.addPerson(tex, h, pos[0], pos[1], mode, seed);
      p.lift = BLOCK_H; // standing on the booth / stage
      this.stage.push(p);
    };
    if (this.djOn && dj)
      add(a.decks[dj] ?? a.dj, "dj", 0.5, "perform", 990, PERSON_H * 1.55);
    if (stageAct === "dancers") {
      add(a.dancers[0], "stage", 0.3, "dance", 991);
      add(a.dancers[1] ?? a.dancers[0], "stage", 0.72, "dance", 992);
    } else if (stageAct === "mc") add(a.mc, "stage", 0.5, "perform", 993);
  }

  /** The LED wall plays the booked DJ's loop during their set, and an idle logo otherwise. */
  private syncScreen(s: GameState) {
    if (!this.screen) return;
    const dj = this.djOn ? (s.bookedTalent[0] ?? "") : "";
    if (dj === this.screenDj) return;
    this.screenDj = dj;
    const scr = this.screen;
    scr.mat.map = scr.idle;
    scr.mat.needsUpdate = true;
    if (!dj) return;
    if (!this.videos.has(dj)) this.videos.set(dj, loadDjVideo(dj));
    this.videos.get(dj)!.then((tex) => {
      if (!tex || this.screen !== scr || this.screenDj !== dj) return;
      scr.mat.map = tex;
      scr.mat.needsUpdate = true;
    });
  }

  /** A stable display name for a guest, e.g. "RAKA M." */
  private guestName(id: number) {
    const names = en.videotron.names;
    const first = names[Math.floor(hash(id + 77) * names.length)]!;
    return `${first} ${String.fromCharCode(65 + Math.floor(hash(id + 78) * 26))}.`;
  }

  /** Flame jets on the floor either side of the stage, mist cannons on the ceiling over the dance floor. */
  private buildFx() {
    const dj = this.zones.get("dj");
    const dance = this.zones.get("dance");
    if (!dj || !dance) return; // pyro needs a DJ booth (Nightclub and up)
    const stage = this.zones.get("stage");
    const blocks = stage ? [dj, stage] : [dj];
    const x0 = Math.min(...blocks.map((b) => b.x)) - 0.45;
    const x1 = Math.max(...blocks.map((b) => b.x + b.w)) + 0.45;
    const zf = Math.max(...blocks.map((b) => b.y + b.h));
    const fire = [
      new THREE.Vector3(x0, 0, zf - 0.9),
      new THREE.Vector3(x0, 0, zf + 0.1),
      new THREE.Vector3(x1, 0, zf - 0.9),
      new THREE.Vector3(x1, 0, zf + 0.1),
    ];
    const y = Math.min(this.wallH, 7) - 0.35;
    const m = 1.2;
    const mist = [
      [dance.x + m, dance.y + m],
      [dance.x + dance.w - m, dance.y + m],
      [dance.x + m, dance.y + dance.h - m],
      [dance.x + dance.w - m, dance.y + dance.h - m],
      [dance.x + dance.w / 2, dance.y + dance.h * 0.3],
      [dance.x + dance.w / 2, dance.y + dance.h * 0.7],
    ].map(([x, z]) => new THREE.Vector3(x, y, z));
    // The cannons themselves, hanging from the ceiling.
    const can = new THREE.MeshStandardMaterial({
      color: 0x1a1a20,
      metalness: 0.8,
    });
    for (const at of mist) {
      const c = new THREE.Mesh(
        new THREE.CylinderGeometry(0.1, 0.14, 0.4, 10),
        can,
      );
      c.position.set(at.x, at.y + 0.1, at.z);
      this.root.add(c);
    }
    this.fx = new StageFx(fire, mist);
    this.root.add(this.fx.group);
  }

  /** Speaker stacks either side of the DJ booth, one cabinet per sound tier. */
  private buildSpeakers(tier: number) {
    const dj = this.zones.get("dj") ?? this.zones.get("stage");
    if (!dj || tier <= 0) return;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x111114,
      roughness: 0.6,
      metalness: 0.3,
    });
    const cone = new THREE.MeshStandardMaterial({
      color: 0x2a2a30,
      roughness: 0.3,
      metalness: 0.6,
    });
    for (const x of [dj.x - 0.35, dj.x + dj.w + 0.35])
      for (let i = 0; i < tier; i++) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.62, 0.5), mat);
        box.position.set(x, 0.31 + i * 0.64, dj.y + 0.45);
        const woofer = new THREE.Mesh(new THREE.CircleGeometry(0.19, 20), cone);
        woofer.position.set(0, -0.04, 0.251);
        box.add(woofer);
        this.root.add(box);
      }
  }

  private syncSparks(on: boolean) {
    if (!on) {
      if (this.sparks.length) {
        this.sparks.forEach((sp) => {
          this.root.remove(sp);
          (sp.material as THREE.SpriteMaterial).dispose();
        });
        this.sparks = [];
      }
      return;
    }
    if (this.sparks.length) return;
    // One sparkler on every lounge table.
    for (const it of this.items)
      if (it.kind === "table") {
        const sp = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.sparkTex,
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          }),
        );
        sp.position.set(it.x, 0.75, it.z);
        this.root.add(sp);
        this.sparks.push(sp);
      }
  }

  /** VIP tables are "seated" guests with no sim bodies: once they arrive, fill the VIP sofas with people. */
  private syncVip(s: GameState) {
    const n = s.night!;
    const seats = this.seats.get("vip") ?? [];
    const want =
      s.upgrades?.vip && n.minute >= strategy.relations.tablesArriveMinute
        ? Math.min(seats.length, (n.vipBooked ?? 0) * 3)
        : 0;
    if (want === this.vipGuests.length) return;
    this.vipGuests.forEach((p) => this.remove(p));
    this.vipGuests = [];
    const all = this.assets!.guests;
    for (let i = 0; i < want; i++) {
      const [x, z] = seats[i]!;
      const p = this.addPerson(
        all[Math.floor(hash(i + 3000) * all.length)],
        PERSON_H * 0.95,
        x,
        z,
        "idle",
        3000 + i,
      );
      p.lift = this.elevationAt(x, z);
      this.vipGuests.push(p);
    }
  }

  private syncHosts(s: GameState) {
    const n = s.night!;
    const count = Math.min(6, s.staff.host ?? 0);
    const all = this.assets!.guests;
    while (this.hosts.length > count) this.remove(this.hosts.pop()!);
    while (this.hosts.length < count) {
      const i = this.hosts.length;
      const tex = all.length === 10 ? all[6 + (i % 2)] : all[0];
      const [x, z] = this.entrance();
      const p = this.addPerson(tex, PERSON_H, x, z, "idle", 700 + i);
      // A soft magenta halo marks staff hosts apart from guests.
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.16, 0.24, 24),
        new THREE.MeshBasicMaterial({
          color: PALETTE[0],
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 0.02;
      p.g.add(halo);
      this.hosts.push(p);
    }
    const onFloor = !!n.tactics?.hostsFloor && tacticActive(n, "hostsFloor");
    this.hosts.forEach((p, i) => {
      const zone: ZoneId = onFloor ? "dance" : i % 2 ? "barFront" : "seating";
      const pt = this.zonePoint(
        zone,
        0.2 + hash(p.seed + (onFloor ? 3 : 0)) * 0.6,
        0.2 + hash(p.seed + 17) * 0.6,
      );
      if (pt) [p.tx, p.tz] = pt;
      p.mode = onFloor ? "dance" : "idle";
    });
  }

  private patrolPoint(seed: number): [number, number] {
    const zone: ZoneId = hash(seed * 3) < 0.6 ? "dance" : "seating";
    return (
      this.zonePoint(
        zone,
        0.15 + hash(seed) * 0.7,
        0.15 + hash(seed + 11) * 0.7,
      ) ?? this.entrance()
    );
  }

  /** Send the nearest free bodyguard to walk this guest out (click-to-escort, or after a fight). */
  private dispatchSecurity(guestId: number) {
    const g = this.guests.get(guestId);
    const free = this.staff.filter((p) => p.task && p.task.kind !== "escort");
    if (!g || !free.length) return;
    const dist = (p: Person) => p.g.position.distanceTo(g.g.position);
    const b = free.reduce((best, p) => (dist(p) < dist(best) ? p : best));
    g.held = true;
    [g.tx, g.tz] = [g.g.position.x, g.g.position.z];
    b.task = { kind: "escort", guest: guestId, phase: "approach" };
  }

  private spot(
    zone: ZoneId,
    id: number,
    queueIndex?: number,
  ): [number, number] {
    // Several areas of the same kind: pick one per guest, weighted by size (balconies are for VIP tables only).
    const list = (this.zoneList.get(zone) ?? []).filter((q) => !q.elevation);
    let z = this.zones.get(zone) ?? this.zones.get("dance")!;
    if (list.length > 1 && queueIndex === undefined) {
      const total = list.reduce((a, q) => a + q.w * q.h, 0);
      let r = hash(id + 911) * total;
      z = list.find((q) => (r -= q.w * q.h) < 0) ?? list[0]!;
    }
    if (queueIndex !== undefined) {
      const perRow = Math.max(1, Math.floor(z.w * 2));
      return [
        z.x + 0.25 + (queueIndex % perRow) * 0.5,
        z.y + 0.3 + Math.floor(queueIndex / perRow) * 0.5,
      ];
    }
    // ponytail: about half the guests take a seat; seats can double up, fine at this scale.
    const seats = this.seats.get(z.id) ?? [];
    const pick = Math.floor(hash(id + 404) * seats.length * 2);
    if (pick < seats.length) {
      const [sx, sz] = seats[pick]!;
      return [
        sx + (hash(id + 1) - 0.5) * 0.12,
        sz + (hash(id + 2) - 0.5) * 0.12,
      ];
    }
    return [
      z.x + 0.3 + hash(id) * (z.w - 0.6),
      z.y + 0.3 + hash(id + 7919) * (z.h - 0.6),
    ];
  }

  private entrance(): [number, number] {
    const q = this.zones.get("queue")!;
    return [q.x + q.w / 2, q.y + q.h];
  }

  private float(p: Person, text: string) {
    if (this.floats.length > 30) return;
    let t = this.floatCache.get(text);
    if (!t)
      this.floatCache.set(
        text,
        (t = textTexture(text, { size: 56, color: "#ffd23f", stroke: true })),
      );
    const s = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: t.tex,
        transparent: true,
        depthTest: false,
      }),
    );
    s.scale.set(0.3 * t.aspect, 0.3, 1);
    // At the bar spot the guest is heading to, so sales visibly come from the bar.
    s.position.set(p.tx, PERSON_H + 0.3, p.tz);
    this.root.add(s);
    this.floats.push(s);
    const now = performance.now();
    if (now - this.cashAt > 180) {
      this.cashAt = now;
      audio.cash();
    }
  }

  private remove(p: Person) {
    this.root.remove(p.g);
    this.disposeTree(p.g);
  }

  // ---------- input ----------

  private bindClicks(canvas: HTMLCanvasElement) {
    const ray = new THREE.Raycaster();
    let down: { x: number; y: number } | null = null;
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitPoint = new THREE.Vector3();
    let drag: { i: number; dx: number; dz: number } | null = null;
    const aim = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        ),
        this.camera,
      );
    };
    const pdown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      if (!this.editing || e.button !== 0) return;
      aim(e);
      const hit = ray.intersectObjects(this.pieces, true)[0];
      if (!hit) return;
      const i = this.pieces.findIndex((g) => {
        let o: THREE.Object3D | null = hit.object;
        while (o && o !== g) o = o.parent;
        return o === g;
      });
      if (i < 0 || !ray.ray.intersectPlane(floor, hitPoint)) return;
      this.select(i);
      drag = {
        i,
        dx: this.items[i]!.x - hitPoint.x,
        dz: this.items[i]!.z - hitPoint.z,
      };
      this.controls.enabled = false; // dragging a piece, not orbiting
      canvas.setPointerCapture(e.pointerId);
    };
    const pmove = (e: PointerEvent) => {
      if (!drag) {
        if (this.editing || e.buttons) return;
        aim(e);
        const over =
          (ray.intersectObjects(this.cabinetHits, false)[0]?.object as
            THREE.Mesh | undefined) ?? null;
        // Drunk guests (red ring + "!") are clickable too.
        const risky = [...this.guests.values()]
          .filter((p) => p.alert?.visible)
          .flatMap((p) => [p.sprite, p.alert!]);
        const onRisky = ray.intersectObjects(risky, false).length > 0;
        canvas.style.cursor = over || onRisky ? "pointer" : "";
        if (over === this.hovered) return;
        const fade = (b: THREE.Mesh | null, o: number) =>
          b && ((b.material as THREE.MeshBasicMaterial).opacity = o);
        fade(this.hovered, 0);
        fade(over, 0.22);
        this.hovered = over;
        return;
      }
      aim(e);
      if (!ray.ray.intersectPlane(floor, hitPoint)) return;
      const it = this.items[drag.i]!;
      Object.assign(it, this.snap(hitPoint.x + drag.dx, hitPoint.z + drag.dz));
      this.pieces[drag.i]!.position.set(
        it.x,
        this.elevationAt(it.x, it.z),
        it.z,
      );
      this.selBox?.update();
    };
    const pup = (e: PointerEvent) => {
      if (drag) {
        drag = null;
        this.controls.enabled = true;
        this.commitFurniture();
        return;
      }
      if (
        this.editing &&
        down &&
        Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 5
      )
        return this.select(-1); // click on empty floor
      // A click, not the end of an orbit drag.
      if (
        !down ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 ||
        e.button !== 0
      )
        return;
      aim(e);
      const targets = [...this.guests.values()]
        .filter((p) => p.alert?.visible)
        .flatMap((p) => [p.sprite, p.alert!]);
      const hit = ray.intersectObjects(targets, false)[0];
      if (hit) {
        const id = [...this.guests.entries()].find(
          ([, p]) => p.sprite === hit.object || p.alert === hit.object,
        )?.[0];
        if (id !== undefined) this.onGuestClick(id);
        return;
      }
      const shelf = ray.intersectObjects(this.cabinetHits, false)[0];
      if (shelf) this.onDrinkClick?.(shelf.object.userData.drink as DrinkId);
    };
    canvas.addEventListener("pointerdown", pdown);
    canvas.addEventListener("pointerup", pup);
    canvas.addEventListener("pointermove", pmove);
    this.off.push(() => {
      canvas.removeEventListener("pointermove", pmove);
      canvas.removeEventListener("pointerdown", pdown);
      canvas.removeEventListener("pointerup", pup);
    });
  }

  // ---------- animation ----------

  /** Security walks (units/ms) and runs when escorting someone out. */
  private stepSecurity(p: Person, dt: number) {
    const task = p.task!;
    const speed = task.kind === "escort" ? 0.0028 : 0.0011;
    if (task.kind === "escort") {
      const g = this.guests.get(task.guest);
      if (!g) p.task = p.home;
      else if (task.phase === "approach") {
        [p.tx, p.tz] = [g.g.position.x + 0.3, g.g.position.z + 0.15];
        if (Math.hypot(p.tx - p.g.position.x, p.tz - p.g.position.z) < 0.15)
          task.phase = "out";
      } else {
        [p.tx, p.tz] = this.entrance();
        [g.tx, g.tz] = [p.g.position.x - 0.35, p.g.position.z - 0.1];
        if (Math.hypot(p.tx - p.g.position.x, p.tz - p.g.position.z) < 0.25) {
          g.held = false; // now it may fade out at the door
          p.task = p.home;
        }
      }
    } else if (task.kind === "patrol") {
      [p.tx, p.tz] = [task.x, task.z];
      if (
        Math.hypot(p.tx - p.g.position.x, p.tz - p.g.position.z) < 0.1 &&
        (task.wait -= dt) <= 0
      ) {
        const [x, z] = this.patrolPoint(
          p.seed + Math.floor(performance.now() / 1000),
        );
        p.task = p.home = {
          kind: "patrol",
          x,
          z,
          wait: 2500 + hash(p.seed) * 3000,
        };
      }
    } else [p.tx, p.tz] = [task.x, task.z];
    const dx = p.tx - p.g.position.x,
      dz = p.tz - p.g.position.z,
      d = Math.hypot(dx, dz);
    if (d > 0.01) {
      const step = Math.min(d, speed * dt);
      p.g.position.x += (dx / d) * step;
      p.g.position.z += (dz / d) * step;
    }
  }

  private frame() {
    const now = performance.now();
    const dt = Math.min(100, now - this.last);
    this.last = now;
    const tSec = now / 1000;
    // With music playing the club moves on the track's real kick; otherwise on its own clock.
    const beatMs = this.djOn ? 60000 / 124 : 60000 / 100;
    const pulse = audio.live
      ? audio.pulse()
      : Math.pow(1 - (now % beatMs) / beatMs, 3);
    const k = Math.min(1, dt / 250);

    const animate = (p: Person) => {
      const moving =
        Math.hypot(p.tx - p.g.position.x, p.tz - p.g.position.z) > 0.04;
      const t = tSec + p.seed * 0.37;
      let y: number,
        sy = 1,
        rot = 0;
      if (moving) y = Math.abs(Math.sin(t * 9)) * 0.05;
      else if (p.mode === "dance") {
        y = pulse * 0.09 + Math.abs(Math.sin(t * 3)) * 0.03;
        sy = 1 - pulse * 0.04;
        rot = Math.sin(t * 2.6) * 0.06;
      } else if (p.mode === "perform") {
        y = pulse * 0.05;
        rot = Math.sin(t * 1.8) * 0.03;
      } else if (p.mode === "work") y = Math.abs(Math.sin(t * 4)) * 0.02;
      else y = Math.sin(t * 1.6) * 0.008;
      p.sprite.position.y = p.lift + y;
      p.g.children[0]!.position.y = p.lift + 0.015; // shadow on the block top when raised
      p.sprite.scale.y = p.h * sy;
      (p.sprite.material as THREE.SpriteMaterial).rotation = rot;
    };

    for (const [id, p] of this.guests) {
      if (p.leaving && !p.held) {
        p.fade -= dt / 800;
        (p.sprite.material as THREE.SpriteMaterial).opacity = Math.max(
          0,
          p.fade,
        );
        (p.sprite.material as THREE.SpriteMaterial).transparent = true;
        if (p.fade <= 0) {
          this.remove(p);
          this.guests.delete(id);
          continue;
        }
      }
      const kk = p.held ? Math.min(1, dt / 120) : k;
      p.g.position.x += (p.tx - p.g.position.x) * kk;
      p.g.position.z += (p.tz - p.g.position.z) * kk;
      animate(p);
      if (p.alert?.visible) {
        const beat = 0.5 + 0.5 * Math.sin(now / 120);
        (p.alert.material as THREE.SpriteMaterial).opacity = 0.5 + 0.5 * beat;
        p.ring!.scale.setScalar(1 + beat * 0.35);
        (p.ring!.material as THREE.MeshBasicMaterial).opacity =
          0.4 + 0.5 * beat;
      }
    }
    for (const p of this.staff) {
      if (p.task) this.stepSecurity(p, dt);
      animate(p);
    }
    this.stage.forEach(animate);
    this.vipGuests.forEach(animate);
    if (this.pool) this.pool.offset.set((tSec * 0.03) % 1, (tSec * 0.05) % 1);
    for (const p of this.hosts) {
      p.g.position.x += (p.tx - p.g.position.x) * k * 0.6;
      p.g.position.z += (p.tz - p.g.position.z) * k * 0.6;
      animate(p);
    }
    // The room's energy drives how hard the lights and floor go.
    const vibe =
      (0.55 + (this.energy / 100) * 0.7) * (1 + this.rigLight * 0.12);
    for (const sp of this.sparks) {
      const f = 0.6 + Math.random() * 0.6;
      sp.scale.set(0.22 * f, 0.22 * f, 1);
      (sp.material as THREE.SpriteMaterial).opacity = 0.6 + Math.random() * 0.4;
    }

    // LED floor colour sweep; the floor light takes the average hue.
    for (const led of this.leds) {
      const c = new THREE.Color();
      led.cells.forEach(([x, y], i) => {
        const wave = 0.5 + 0.5 * Math.sin(tSec * 2.2 - (x + y) * 0.9);
        const level = this.djOn
          ? (0.12 + wave * 0.45 + pulse * 0.3) * vibe
          : 0.04 + wave * 0.08;
        c.setHSL(
          ((tSec * 40 + (x + y) * 28) % 360) / 360,
          0.9,
          0.5,
        ).multiplyScalar(level);
        led.mesh.setColorAt(i, c);
      });
      led.mesh.instanceColor!.needsUpdate = true;
      led.light.color.setHSL(((tSec * 40) % 360) / 360, 0.9, 0.55);
      led.light.intensity = this.djOn ? 3 + pulse * 4 : 0.6;
    }
    const dz = this.zones.get("dance");
    if (dz)
      for (const { light, phase } of this.spots) {
        light.target.position.set(
          dz.x + dz.w / 2 + Math.sin(tSec * 0.7 + phase) * dz.w * 0.35,
          0,
          dz.y + dz.h / 2 + Math.cos(tSec * 0.9 + phase) * dz.h * 0.35,
        );
        light.intensity = this.djOn ? (35 + pulse * 40) * vibe : 6;
      }
    this.beams.forEach((b, i) => {
      b.visible = this.djOn;
      b.rotation.set(
        0.5 + Math.sin(tSec * 0.8 + i * 1.3) * 0.35,
        0,
        Math.sin(tSec * 0.6 + i * 1.7) * 0.7,
      );
      (b.material as THREE.MeshBasicMaterial).opacity =
        (0.05 + pulse * 0.05) * (1 + this.rigLight * 0.35);
    });

    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]!;
      f.position.y += dt / 1500;
      const m = f.material as THREE.SpriteMaterial;
      m.opacity -= dt / 1200;
      if (m.opacity <= 0) {
        this.root.remove(f);
        m.dispose();
        this.floats.splice(i, 1);
      }
    }

    // Cutaway: hide the walls between the camera and the room.
    const cam = this.camera.position;
    for (const w of this.walls) w.mesh.visible = w.visible(cam);

    this.controls.update();
    this.screenWall?.tick(now, pulse);
    this.videotron?.draw(now, pulse, this.tron);

    // Pyro follows the music while the DJ plays: the beat coming back after a break, every drop, and the loud,
    // lifting parts (fire on the kick, mist less often). Quiet stretches stay dark. Peak hours and the anthem add more.
    if (this.fx) {
      const kick = this.djOn && pulse > 0.85 && this.prevPulse < 0.5;
      if (kick) {
        const gap = now - this.lastKick;
        this.lastKick = now;
        this.kicks++;
        const live = audio.live;
        const lift = live ? audio.intensity : 1;
        const hot = this.anthem || lift > 1.12;
        const warm = hot || lift > 0.97 || (!live && this.peak);
        const fireEvery = hot ? 2 : warm ? (this.peak ? 4 : 8) : 0;
        const mistEvery = hot ? 8 : warm && this.peak ? 16 : 0;
        if (gap > 2500) {
          // The beat drops back in (the opening, or after a breakdown): everything at once.
          this.fx.burstFire();
          this.fx.burstMist();
        } else {
          if (fireEvery && this.kicks % fireEvery === 0) this.fx.burstFire();
          if (mistEvery && this.kicks % mistEvery === 0) this.fx.burstMist();
        }
      }
      if (this.djOn && audio.live && audio.dropAt !== this.dropSeen) {
        this.dropSeen = audio.dropAt;
        this.fx.burstFire();
        this.fx.burstMist();
      }
      this.prevPulse = pulse;
      this.fx.update(dt / 1000);
    }
    this.renderer.render(this.scene, this.camera);
  }

  private disposeTree(o: THREE.Object3D) {
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material)
        ? m.material
        : m.material
          ? [m.material]
          : [];
      for (const mat of mats) {
        // Shared textures (sprites, shadows, alert) are owned by the scene/assets, not by one object.
        mat.dispose();
      }
    });
  }
}
