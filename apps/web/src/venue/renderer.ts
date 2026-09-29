import {
  isAtFightRisk,
  isInside,
  night as nightData,
  type GameState,
} from "@nyxeron/core";
import {
  Application,
  Container,
  FillPattern,
  Graphics,
  Matrix,
  Sprite,
  Text,
  type Texture,
} from "pixi.js";
import { loadVenueAssets, type VenueAssets } from "./assets";
import {
  layoutFor,
  zoneFor,
  type Layout,
  type Zone,
  type ZoneId,
} from "./layouts";

const TW = 64;
const TH = 32;
const ZOOMS = [0.6, 1, 1.3, 1.6];
/** On-screen height of a guest at zoom 1 (a tile is 64×32). */
const PERSON_H = 58;
/** Height of solid furniture (bar counter, DJ booth, stage). */
const BLOCK_LIFT = 16;
const iso = (x: number, y: number) => ({
  x: ((x - y) * TW) / 2,
  y: ((x + y) * TH) / 2,
});

/** Deterministic 0..1 from an integer, so a guest always picks the same spot and outfit. */
const hash = (n: number) => {
  let t = (n * 2654435761) >>> 0;
  t ^= t >>> 15;
  t = Math.imul(t, 2246822519) >>> 0;
  return (t >>> 0) / 4294967296;
};

/** Texture pattern laid onto the isometric floor: `tiles` floor tiles per texture repeat. */
function isoPattern(tex: Texture, tiles = 4): FillPattern {
  const T = tex.width / tiles;
  const p = new FillPattern(tex, "repeat");
  p.setTransform(
    new Matrix(TW / 2 / T, TH / 2 / T, -TW / 2 / T, TH / 2 / T, 0, 0),
  );
  return p;
}

interface Person {
  c: Container;
  body: Container;
  alert?: Text;
  tx: number;
  ty: number;
  leaving: boolean;
  mode: "walk" | "dance" | "idle" | "work" | "perform";
  seed: number;
  /** Depth offset: performers standing on a raised block must sort in front of its cubes. */
  zBias: number;
  /** Feet height above the floor (stage/booth top). */
  lift: number;
}

/** Read-only view of GameState.night: never mutates state, only calls back on clicks. */
export class VenueRenderer {
  private app = new Application();
  private world = new Container();
  private floor = new Container();
  private dance = new Container();
  private glowLayer = new Container();
  private people = new Container();
  private beams = new Container();
  private fx = new Container();
  private assets: VenueAssets | null = null;
  private guests = new Map<number, Person>();
  private crew: Person[] = [];
  private crewKey = "";
  private budgets = new Map<number, number>();
  private spots: { s: Sprite; phase: number }[] = [];
  private layout: Layout | null = null;
  private zones = new Map<ZoneId, Zone>();
  private zoom = 1;
  private keys = new Set<string>();
  private djOn = false;
  private ready = false;
  private dead = false;
  private off: (() => void)[] = [];

  constructor(private onGuestClick: (id: number) => void) {}

  async init(el: HTMLElement) {
    await this.app.init({
      resizeTo: el,
      background: 0x000000,
      antialias: true,
      autoDensity: true,
      resolution: devicePixelRatio,
    });
    this.assets = await loadVenueAssets();
    if (this.dead) return this.app.destroy(true, { children: true });
    el.appendChild(this.app.canvas);
    this.people.sortableChildren = true;
    this.glowLayer.blendMode = "add";
    this.beams.blendMode = "add";
    this.world.addChild(
      this.floor,
      this.dance,
      this.glowLayer,
      this.people,
      this.beams,
      this.fx,
    );
    this.app.stage.addChild(this.world);
    this.app.ticker.add((t) => this.frame(t.deltaMS));
    this.bindCamera();
    this.ready = true;
  }

  destroy() {
    this.dead = true;
    this.off.forEach((f) => f());
    if (this.ready) this.app.destroy(true, { children: true });
  }

  update(s: GameState) {
    if (!this.ready || !s.night) return;
    const layout = layoutFor(s.level);
    if (layout !== this.layout) this.buildFloor(layout, s);
    this.djOn =
      s.bookedTalent.length > 0 && s.night.minute >= nightData.djSetStartMinute;
    this.syncCrew(s);

    const queue = s.night.guests.filter((g) => g.state === "queue");
    const queueIndex = new Map(queue.map((g, i) => [g.id, i]));
    for (const g of s.night.guests) {
      let p = this.guests.get(g.id);
      if (g.state === "pending" || (g.state === "left" && !p)) continue;
      if (!p) p = this.spawnGuest(g.id);

      const [tx, ty] = this.spot(zoneFor[g.state], g.id, queueIndex.get(g.id));
      p.tx = tx;
      p.ty = ty;
      p.leaving = g.state === "left";
      p.mode = g.state === "dance" ? "dance" : "idle";
      // Satisfaction as brightness: unhappy guests fade toward grey.
      const v = Math.round(0x80 + (g.satisfaction / 100) * 0x7f);
      p.body.tint = (v << 16) | (v << 8) | v;
      const risk = isAtFightRisk(g);
      p.alert!.visible = risk;
      p.c.cursor = risk ? "pointer" : "default";

      const prev = this.budgets.get(g.id);
      if (
        prev !== undefined &&
        g.state === "bar" &&
        g.budget < prev &&
        isInside(g)
      )
        this.float(p, `+${prev - g.budget}`);
      this.budgets.set(g.id, g.budget);
    }
  }

  // ---------- floor, blocks, lights ----------

  private buildFloor(layout: Layout, s: GameState) {
    this.layout = layout;
    this.zones = new Map(layout.zones.map((z) => [z.id, z]));
    for (const c of [
      this.floor,
      this.dance,
      this.glowLayer,
      this.people,
      this.beams,
    ])
      c.removeChildren().forEach((x) => x.destroy());
    this.guests.clear();
    this.crew = [];
    this.crewKey = "";
    this.budgets.clear();
    this.spots = [];
    const tex = this.assets!.tex;
    const quad = (x: number, y: number, w: number, h: number, lift = 0) => {
      const a = iso(x, y),
        b = iso(x + w, y),
        c = iso(x + w, y + h),
        d = iso(x, y + h);
      return [
        a.x,
        a.y - lift,
        b.x,
        b.y - lift,
        c.x,
        c.y - lift,
        d.x,
        d.y - lift,
      ];
    };

    // Base floor: textured concrete + faint tile grid.
    const base = new Graphics().poly(quad(0, 0, layout.w, layout.h));
    base.fill(
      tex.concrete
        ? { fill: isoPattern(tex.concrete), color: 0x9a9a9a }
        : { color: 0x141414 },
    );
    this.floor.addChild(base);
    const grid = new Graphics();
    for (let i = 0; i <= layout.w; i++)
      grid
        .moveTo(iso(i, 0).x, iso(i, 0).y)
        .lineTo(iso(i, layout.h).x, iso(i, layout.h).y);
    for (let j = 0; j <= layout.h; j++)
      grid
        .moveTo(iso(0, j).x, iso(0, j).y)
        .lineTo(iso(layout.w, j).x, iso(layout.w, j).y);
    grid.stroke({ width: 1, color: 0xffffff, alpha: 0.05 });
    this.floor.addChild(grid);

    const labels = new Container();
    for (const z of layout.zones) {
      const locked = z.lockedBelow !== undefined && s.level < z.lockedBelow;
      if (z.solid) {
        this.buildBlock(z);
      } else if (z.id === "dance") {
        this.buildDanceFloor(z);
      } else {
        const g = new Graphics().poly(quad(z.x, z.y, z.w, z.h));
        const woodish =
          z.id === "seating" ||
          z.id === "barFront" ||
          z.id === "backbar" ||
          z.id === "vip" ||
          z.id === "office";
        const t = z.outside ? tex.asphalt : woodish ? tex.wood : undefined;
        if (t)
          g.fill({
            fill: isoPattern(t, z.outside ? 3 : 4),
            color: locked ? 0x333333 : z.outside ? 0x8a8a8a : 0xb0b0b0,
          });
        else g.fill({ color: 0x1a1a1a, alpha: 0.7 });
        g.stroke({ width: 1, color: 0xffffff, alpha: locked ? 0.05 : 0.12 });
        this.floor.addChild(g);
      }
      if (z.label) {
        const t = new Text({
          text: locked ? `${z.label} · LOCKED` : z.label,
          style: {
            fill: 0xffffff,
            fontSize: 10,
            fontFamily: "ui-monospace, monospace",
            letterSpacing: 2,
          },
        });
        t.alpha = 0.4;
        const m = iso(z.x + z.w / 2, z.y + z.h / 2);
        t.anchor.set(0.5);
        t.position.set(m.x, m.y - (z.solid ? 14 : 0));
        labels.addChild(t);
      }
    }
    this.floor.addChild(labels);
    this.buildLights();
    this.centerCamera();
  }

  /** Solid furniture as one cube per tile, each depth-sorted with the people (bartenders stand behind the bar). */
  private buildBlock(z: Zone) {
    const lift = BLOCK_LIFT;
    for (let x = z.x; x < z.x + z.w; x++)
      for (let y = z.y; y < z.y + z.h; y++) {
        const a = iso(x, y),
          b = iso(x + 1, y),
          c = iso(x + 1, y + 1),
          d = iso(x, y + 1);
        const g = new Graphics();
        g.poly([d.x, d.y, c.x, c.y, c.x, c.y - lift, d.x, d.y - lift]).fill({
          color: 0x2c2c2c,
        });
        g.poly([c.x, c.y, b.x, b.y, b.x, b.y - lift, c.x, c.y - lift]).fill({
          color: 0x1f1f1f,
        });
        g.poly([
          a.x,
          a.y - lift,
          b.x,
          b.y - lift,
          c.x,
          c.y - lift,
          d.x,
          d.y - lift,
        ]).fill({ color: z.id === "counter" ? 0x3a3a3a : 0x333333 });
        // Lit top edge on the front faces.
        g.moveTo(d.x, d.y - lift)
          .lineTo(c.x, c.y - lift)
          .lineTo(b.x, b.y - lift)
          .stroke({ width: 1, color: 0xffffff, alpha: 0.25 });
        g.zIndex = c.y - 0.5;
        this.people.addChild(g);
      }
  }

  /** LED dance floor: one tile per cell, brightness driven by the beat in frame(). */
  private buildDanceFloor(z: Zone) {
    for (let x = z.x; x < z.x + z.w; x++)
      for (let y = z.y; y < z.y + z.h; y++) {
        const a = iso(x, y),
          b = iso(x + 1, y),
          c = iso(x + 1, y + 1),
          d = iso(x, y + 1);
        const g = new Graphics()
          .poly([a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y])
          .fill({ color: 0x0c0c0c })
          .stroke({ width: 1, color: 0xffffff, alpha: 0.18 });
        const glow = new Graphics()
          .poly([a.x, a.y + 2, b.x - 3, b.y, c.x, c.y - 2, d.x + 3, d.y])
          .fill({ color: 0xffffff });
        glow.alpha = 0;
        glow.label = `${x - z.x},${y - z.y}`;
        this.dance.addChild(g, glow);
      }
  }

  private buildLights() {
    const glow = this.assets!.glow;
    const light = (x: number, y: number, r: number, alpha: number) => {
      const s = new Sprite(glow);
      s.anchor.set(0.5);
      const p = iso(x, y);
      s.position.set(p.x, p.y);
      s.width = r * 2;
      s.height = r; // flattened onto the iso floor
      s.alpha = alpha;
      this.glowLayer.addChild(s);
      return s;
    };
    const bar = this.zones.get("barFront");
    if (bar) light(bar.x + bar.w / 2, bar.y + bar.h / 2, 140, 0.16);
    const door = this.zones.get("entrance");
    if (door) light(door.x + door.w / 2, door.y + door.h / 2, 90, 0.2);
    const dance = this.zones.get("dance");
    if (dance)
      for (let i = 0; i < 3; i++)
        this.spots.push({
          s: light(dance.x + dance.w / 2, dance.y + dance.h / 2, 90, 0),
          phase: i * 2.1,
        });
    // Beams sweeping out of the DJ booth (or the stage), drawn above the crowd like light through haze.
    const src = this.zones.get("dj") ?? this.zones.get("stage");
    if (src) {
      const o = iso(src.x + src.w / 2, src.y + src.h / 2);
      for (let i = 0; i < 4; i++) {
        const beam = new Graphics()
          .poly([0, 0, -22, 300, 22, 300])
          .fill({ color: 0xffffff, alpha: 0.05 });
        beam.position.set(o.x, o.y - 30);
        beam.label = String(i);
        this.beams.addChild(beam);
      }
    }
  }

  // ---------- people ----------

  private makeBody(tex: Texture | undefined, h: number): Container {
    const body = new Container();
    if (tex) {
      const s = new Sprite(tex);
      s.anchor.set(0.5, 1);
      s.scale.set(h / tex.height);
      body.addChild(s);
    } else {
      body.addChild(
        new Graphics()
          .circle(0, -h * 0.55, 5)
          .fill(0xffffff)
          .roundRect(-4, -h * 0.45, 8, h * 0.45, 3)
          .fill(0xdddddd),
      );
    }
    return body;
  }

  private addPerson(
    tex: Texture | undefined,
    h: number,
    x: number,
    y: number,
    mode: Person["mode"],
    seed: number,
  ): Person {
    const c = new Container();
    const shadow = new Graphics()
      .ellipse(0, 0, h * 0.22, h * 0.08)
      .fill({ color: 0x000000, alpha: 0.55 });
    const body = this.makeBody(tex, h);
    c.addChild(shadow, body);
    c.position.set(x, y);
    this.people.addChild(c);
    return {
      c,
      body,
      tx: x,
      ty: y,
      leaving: false,
      mode,
      seed,
      zBias: 0,
      lift: 0,
    };
  }

  private spawnGuest(id: number): Person {
    const g = this.assets!.guests;
    const tex = g.length ? g[Math.floor(hash(id + 31) * g.length)] : undefined;
    const h = PERSON_H * (0.9 + hash(id + 5) * 0.18);
    const [x, y] = this.entrancePoint();
    const p = this.addPerson(tex, h, x, y, "walk", id);
    const alert = new Text({
      text: "!",
      style: {
        fill: 0xffffff,
        fontSize: 18,
        fontWeight: "bold",
        stroke: { color: 0x000000, width: 4 },
      },
    });
    alert.anchor.set(0.5, 1);
    alert.position.set(0, -h - 4);
    alert.visible = false;
    p.c.addChild(alert);
    p.alert = alert;
    p.c.eventMode = "static";
    p.c.hitArea = {
      contains: (px: number, py: number) =>
        Math.abs(px) < h * 0.3 && py < 4 && py > -h - 20,
    };
    p.c.on("pointertap", () => alert.visible && this.onGuestClick(id));
    this.guests.set(id, p);
    return p;
  }

  /** Staff and performers follow the game state: hired bartenders/security, the booked DJ, the stage act. */
  private syncCrew(s: GameState) {
    const a = this.assets!;
    const bartenders = Math.min(3, Math.max(1, s.staff.bartender)); // the owner pours at the booth
    const bouncers = Math.min(4, s.staff.security);
    const stage = this.zones.has("stage")
      ? s.level >= 4 && this.djOn
        ? "dancers"
        : "mc"
      : "none";
    const key = `${bartenders}|${bouncers}|${this.djOn}|${stage}`;
    if (key === this.crewKey) return;
    this.crewKey = key;
    this.crew.forEach((p) => p.c.destroy({ children: true }));
    this.crew = [];
    const at = (zone: ZoneId, fx: number, fy: number) => {
      const z = this.zones.get(zone);
      if (!z) return null;
      const p = iso(z.x + z.w * fx, z.y + z.h * fy);
      return [p.x, p.y] as const;
    };
    const add = (
      tex: Texture | undefined,
      pos: readonly [number, number] | null,
      mode: Person["mode"],
      seed: number,
      h = PERSON_H,
      on?: ZoneId,
    ) => {
      if (!pos) return;
      const p = this.addPerson(tex, h, pos[0], pos[1], mode, seed);
      const z = on && this.zones.get(on);
      if (z) {
        // Standing on the block: raise to its top and sort in front of every cube of it.
        p.lift = BLOCK_LIFT;
        p.zBias = iso(z.x + z.w, z.y + z.h).y - pos[1] + 1;
      }
      this.crew.push(p);
    };

    // Bartenders work the lane behind the counter, spread along its length (the counter cubes hide their legs).
    const lane = this.zones.get("backbar");
    for (let i = 0; i < bartenders && lane; i++) {
      const along = (i + 0.5) / bartenders;
      const p =
        lane.w >= lane.h
          ? iso(lane.x + along * lane.w, lane.y + 0.5)
          : iso(lane.x + 0.5, lane.y + along * lane.h);
      add(
        a.bartenders[i % Math.max(1, a.bartenders.length)],
        [p.x, p.y],
        "work",
        900 + i,
      );
    }
    for (let i = 0; i < bouncers; i++)
      add(
        a.bouncers[i % Math.max(1, a.bouncers.length)],
        at("entrance", i % 2 ? 0.95 : 0.05, 0.3 + Math.floor(i / 2) * 0.4),
        "idle",
        950 + i,
        PERSON_H * 1.12,
      );
    if (this.djOn && a.dj)
      add(a.dj, at("dj", 0.5, 0.6), "perform", 990, PERSON_H * 1.75, "dj");
    if (stage === "dancers") {
      add(a.dancers[0], at("stage", 0.3, 0.5), "dance", 991, PERSON_H, "stage");
      add(
        a.dancers[1] ?? a.dancers[0],
        at("stage", 0.72, 0.5),
        "dance",
        992,
        PERSON_H,
        "stage",
      );
    } else if (stage === "mc")
      add(a.mc, at("stage", 0.5, 0.5), "perform", 993, PERSON_H, "stage");
  }

  private spot(
    zone: ZoneId,
    id: number,
    queueIndex?: number,
  ): [number, number] {
    const z = this.zones.get(zone) ?? this.zones.get("dance")!;
    if (queueIndex !== undefined) {
      const perRow = z.w * 2;
      const p = iso(
        z.x + 0.25 + (queueIndex % perRow) * 0.5,
        z.y + 0.3 + Math.floor(queueIndex / perRow) * 0.5,
      );
      return [p.x, p.y];
    }
    const p = iso(
      z.x + 0.3 + hash(id) * (z.w - 0.6),
      z.y + 0.3 + hash(id + 7919) * (z.h - 0.6),
    );
    return [p.x, p.y];
  }

  private entrancePoint(): [number, number] {
    const q = this.zones.get("queue")!;
    const p = iso(q.x + q.w / 2, q.y + q.h);
    return [p.x, p.y];
  }

  private float(p: Person, text: string) {
    if (this.fx.children.length > 40) return;
    const t = new Text({
      text,
      style: {
        fill: 0xffffff,
        fontSize: 12,
        fontFamily: "ui-monospace, monospace",
        stroke: { color: 0x000000, width: 3 },
      },
    });
    t.anchor.set(0.5);
    // At the bar spot the guest is heading to, so sales visibly come from the bar.
    t.position.set(p.tx, p.ty - PERSON_H - 6);
    this.fx.addChild(t);
  }

  // ---------- animation ----------

  private frame(dt: number) {
    const k = Math.min(1, dt / 250);
    const now = performance.now();
    // House playlist ~100 BPM, the DJ set 124 BPM.
    const beatMs = this.djOn ? 60000 / 124 : 60000 / 100;
    const beat = (now % beatMs) / beatMs; // 0..1 within the beat
    const pulse = Math.pow(1 - beat, 3); // sharp hit, quick decay

    const animate = (p: Person) => {
      const moving = Math.hypot(p.tx - p.c.x, p.ty - p.c.y) > 1.5;
      const t = now / 1000 + p.seed * 0.37;
      const b = p.body;
      b.rotation = 0;
      b.scale.y = 1;
      if (moving) {
        b.y = -Math.abs(Math.sin(t * 9)) * 2.5;
        if (Math.abs(p.tx - p.c.x) > 0.5) b.scale.x = p.tx < p.c.x ? 1 : -1;
      } else if (p.mode === "dance") {
        b.y = -pulse * 5 - Math.abs(Math.sin(t * 3)) * 1.5;
        b.scale.y = 1 - pulse * 0.04;
        b.rotation = Math.sin(t * 2.6) * 0.06;
      } else if (p.mode === "perform") {
        b.y = -pulse * 3;
        b.rotation = Math.sin(t * 1.8) * 0.03;
      } else if (p.mode === "work") {
        b.y = -Math.abs(Math.sin(t * 4)) * 1.2;
      } else {
        b.y = Math.sin(t * 1.6) * 0.6; // breathing
      }
      b.y -= p.lift;
      p.c.children[0]!.y = -p.lift; // shadow sits on the block top too
      p.c.zIndex = p.c.y + p.zBias;
    };

    for (const [id, p] of this.guests) {
      if (p.leaving) {
        p.c.alpha -= dt / 800;
        if (p.c.alpha <= 0) {
          p.c.destroy({ children: true });
          this.guests.delete(id);
          continue;
        }
      }
      p.c.x += (p.tx - p.c.x) * k;
      p.c.y += (p.ty - p.c.y) * k;
      animate(p);
      if (p.alert) p.alert.alpha = 0.5 + 0.5 * Math.sin(now / 120);
    }
    this.crew.forEach(animate);

    // LED floor: a diagonal wave that hits on the beat; dim idle shimmer without a DJ.
    const tSec = now / 1000;
    for (const c of this.dance.children) {
      if (!c.label) continue;
      const [x, y] = c.label.split(",").map(Number) as [number, number];
      const wave = 0.5 + 0.5 * Math.sin(tSec * 2.2 - (x + y) * 0.9);
      c.alpha = this.djOn
        ? 0.05 + wave * 0.16 + pulse * 0.1
        : 0.02 + wave * 0.04;
    }
    // Moving spotlights on the dance floor.
    const dz = this.zones.get("dance");
    if (dz)
      for (const { s, phase } of this.spots) {
        const p = iso(
          dz.x + dz.w / 2 + Math.sin(tSec * 0.7 + phase) * dz.w * 0.35,
          dz.y + dz.h / 2 + Math.cos(tSec * 0.9 + phase) * dz.h * 0.35,
        );
        s.position.set(p.x, p.y);
        s.alpha = this.djOn ? 0.22 + pulse * 0.12 : 0.06;
      }
    // Beams sweep while the DJ plays.
    this.beams.children.forEach((b, i) => {
      b.visible = this.djOn;
      // Aimed down onto the dance floor (below the booth), sweeping side to side.
      b.rotation = Math.sin(tSec * 0.8 + i * 1.3) * 0.55 + (i - 1.5) * 0.18;
      b.alpha = 0.7 + pulse * 0.3;
    });

    for (const t of [...this.fx.children]) {
      t.y -= dt / 30;
      t.alpha -= dt / 1200;
      if (t.alpha <= 0) t.destroy();
    }

    const pan = dt / 2;
    if (this.keys.has("w") || this.keys.has("arrowup")) this.world.y += pan;
    if (this.keys.has("s") || this.keys.has("arrowdown")) this.world.y -= pan;
    if (this.keys.has("a") || this.keys.has("arrowleft")) this.world.x += pan;
    if (this.keys.has("d") || this.keys.has("arrowright")) this.world.x -= pan;
  }

  // ---------- camera ----------

  private centerCamera() {
    if (!this.layout) return;
    // Small venues (booth, bar) start zoomed in so the people read; the club starts on the overview.
    this.zoom =
      this.layout.w <= 8
        ? ZOOMS[3]!
        : this.layout.w <= 12
          ? ZOOMS[2]!
          : ZOOMS[1]!;
    const mid = iso(this.layout.w / 2, this.layout.h / 2 + 1.5);
    this.world.scale.set(this.zoom);
    this.world.position.set(
      this.app.screen.width / 2 - mid.x * this.zoom,
      this.app.screen.height / 2 - mid.y * this.zoom,
    );
  }

  private bindCamera() {
    const canvas = this.app.canvas;
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement;
    const down = (e: KeyboardEvent) =>
      !typing(e) && this.keys.add(e.key.toLowerCase());
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    let drag: { x: number; y: number } | null = null;
    const pdown = (e: PointerEvent) => {
      if (e.button === 2) drag = { x: e.clientX, y: e.clientY };
    };
    const pmove = (e: PointerEvent) => {
      if (!drag) return;
      this.world.x += e.clientX - drag.x;
      this.world.y += e.clientY - drag.y;
      drag = { x: e.clientX, y: e.clientY };
    };
    const pup = () => (drag = null);
    const menu = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const i = ZOOMS.indexOf(this.zoom) + (e.deltaY < 0 ? 1 : -1);
      const z = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i))]!;
      // Zoom around the cursor.
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left,
        my = e.clientY - r.top;
      this.world.x = mx - ((mx - this.world.x) * z) / this.zoom;
      this.world.y = my - ((my - this.world.y) * z) / this.zoom;
      this.zoom = z;
      this.world.scale.set(z);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    canvas.addEventListener("pointerdown", pdown);
    window.addEventListener("pointermove", pmove);
    window.addEventListener("pointerup", pup);
    canvas.addEventListener("contextmenu", menu);
    canvas.addEventListener("wheel", wheel, { passive: false });
    this.off.push(
      () => window.removeEventListener("keydown", down),
      () => window.removeEventListener("keyup", up),
      () => window.removeEventListener("pointermove", pmove),
      () => window.removeEventListener("pointerup", pup),
    );
  }
}
