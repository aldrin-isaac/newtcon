// topology-layout.ts — connectivity-aware placement for the Topology graph.
//
// Places nodes so that:
//   1. a node sits closest to its directly-connected neighbours, and farther from
//      others in proportion to hop distance — a force-directed spring embedding
//      (springs pull neighbours to a rest length; repulsion pushes everything
//      apart, so 2-hop nodes settle ~2× the neighbour distance away, etc.);
//   2. host nodes are always at the bottom — pulled down during the simulation and
//      then hard-constrained below every switch;
//   3. no two node boxes overlap — repulsion during the sim + a final separation
//      pass that enforces a minimum box gap.
//
// Pure + deterministic (fixed seed-free init + fixed iteration count) so the same
// graph always yields the same layout — no jitter across re-renders. Pinned nodes
// (operator-dragged) are held fixed and everything else settles around them.

export interface LayoutNodeInput {
  name: string;
  isHost: boolean;
}
export interface LayoutEdge {
  a: string;
  z: string;
}
export interface LayoutOptions {
  nodeW: number;
  nodeH: number;
  hGap: number;
  vGap: number;
  pinned?: Map<string, { cx: number; cy: number }>;
  iterations?: number;
}
export interface LayoutPoint {
  cx: number;
  cy: number;
}

// Golden angle — spreads the deterministic initial ring evenly with no RNG.
const GOLDEN_ANGLE = 2.399963229728653;

export function computeTopologyLayout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdge[],
  opts: LayoutOptions,
): Map<string, LayoutPoint> {
  const out = new Map<string, LayoutPoint>();
  const n = nodes.length;
  if (n === 0) return out;

  const { nodeW, nodeH, hGap, vGap } = opts;
  const pinned = opts.pinned ?? new Map<string, { cx: number; cy: number }>();
  const iterations = opts.iterations ?? 500;
  const L = nodeW + hGap;          // desired neighbour spacing (centre-to-centre)
  const minSepX = nodeW + hGap;    // min centre distance to keep boxes apart in x
  const minSepY = nodeH + vGap;    // …and in y

  const idx = new Map<string, number>();
  nodes.forEach((nd, i) => idx.set(nd.name, i));

  // Adjacency (known nodes only, no self-loops, deduped).
  const adj: Set<number>[] = nodes.map(() => new Set<number>());
  for (const e of edges) {
    const a = idx.get(e.a);
    const z = idx.get(e.z);
    if (a === undefined || z === undefined || a === z) continue;
    adj[a].add(z);
    adj[z].add(a);
  }

  const xs = new Array<number>(n).fill(0);
  const ys = new Array<number>(n).fill(0);
  const fixed = new Array<boolean>(n).fill(false);

  // Anchor the un-pinned ring on the centroid of the pinned nodes (so new nodes
  // start near the existing drawing), else on the origin.
  let anchorX = 0;
  let anchorY = 0;
  let pinCount = 0;
  for (let i = 0; i < n; i++) {
    const pin = pinned.get(nodes[i].name);
    if (pin) {
      anchorX += pin.cx;
      anchorY += pin.cy;
      pinCount++;
    }
  }
  if (pinCount > 0) {
    anchorX /= pinCount;
    anchorY /= pinCount;
  }

  const ringR = L * Math.max(1, Math.sqrt(n));
  let seq = 0;
  for (let i = 0; i < n; i++) {
    const pin = pinned.get(nodes[i].name);
    if (pin) {
      xs[i] = pin.cx;
      ys[i] = pin.cy;
      fixed[i] = true;
    } else {
      const rad = (ringR * Math.sqrt(seq + 1)) / Math.sqrt(n);
      xs[i] = anchorX + Math.cos(seq * GOLDEN_ANGLE) * rad;
      ys[i] = anchorY + Math.sin(seq * GOLDEN_ANGLE) * rad;
      seq++;
    }
  }

  const kRep = L * L * 0.9;         // repulsion strength
  const kSpring = 0.09;            // spring stiffness
  const kHostGravity = L * 0.05;   // steady downward pull on hosts
  const kCenterX = 0.01;          // mild horizontal centring (keeps it compact)

  for (let it = 0; it < iterations; it++) {
    const cooling = 1 - it / iterations; // 1 → 0
    const fx = new Array<number>(n).fill(0);
    const fy = new Array<number>(n).fill(0);

    // Repulsion between every pair (inverse-square).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i] - xs[j];
        let dy = ys[i] - ys[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Perfectly coincident — nudge deterministically by index.
          dx = (i - j) || 1;
          dy = 1;
          d2 = dx * dx + dy * dy;
        }
        const d = Math.sqrt(d2);
        const f = kRep / d2;
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f;
        fy[i] += uy * f;
        fx[j] -= ux * f;
        fy[j] -= uy * f;
      }
    }

    // Springs on edges (Hooke toward rest length L).
    for (let i = 0; i < n; i++) {
      for (const j of adj[i]) {
        if (j < i) continue; // each edge once
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = kSpring * (d - L);
        const ux = dx / d;
        const uy = dy / d;
        fx[i] += ux * f;
        fy[i] += uy * f;
        fx[j] -= ux * f;
        fy[j] -= uy * f;
      }
    }

    // Host gravity (down) + horizontal centring toward the mean x.
    let sumX = 0;
    for (let i = 0; i < n; i++) sumX += xs[i];
    const meanX = sumX / n;
    for (let i = 0; i < n; i++) {
      if (nodes[i].isHost) fy[i] += kHostGravity;
      fx[i] += (meanX - xs[i]) * kCenterX;
    }

    // Integrate (cooling step, capped per-iteration displacement).
    const step = 0.9 * cooling + 0.08;
    const maxStep = L;
    for (let i = 0; i < n; i++) {
      if (fixed[i]) continue;
      const mag = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]);
      if (mag > maxStep) {
        fx[i] = (fx[i] / mag) * maxStep;
        fy[i] = (fy[i] / mag) * maxStep;
      }
      xs[i] += fx[i] * step;
      ys[i] += fy[i] * step;
    }
  }

  // Collision resolution — enforce a minimum box gap (rule 3). Push apart along
  // the axis of least overlap; a fixed node doesn't move, so its partner takes
  // the full shift.
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const ox = minSepX - Math.abs(dx);
        const oy = minSepY - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue; // boxes clear on at least one axis
        moved = true;
        const useX = ox < oy;
        const amt = useX ? ox : oy;
        const dir = useX ? (dx < 0 ? -1 : 1) : (dy < 0 ? -1 : 1);
        const iFixed = fixed[i];
        const jFixed = fixed[j];
        if (iFixed && jFixed) continue;
        if (useX) {
          if (iFixed) xs[j] += dir * amt;
          else if (jFixed) xs[i] -= dir * amt;
          else { xs[i] -= (dir * amt) / 2; xs[j] += (dir * amt) / 2; }
        } else {
          if (iFixed) ys[j] += dir * amt;
          else if (jFixed) ys[i] -= dir * amt;
          else { ys[i] -= (dir * amt) / 2; ys[j] += (dir * amt) / 2; }
        }
      }
    }
    if (!moved) break;
  }

  // Hard host-bottom constraint (rule 2): every un-pinned host sits in a band
  // below the lowest switch, keeping its settled x (so it stays under its uplink
  // neighbour), then spread horizontally so hosts don't overlap each other.
  let lowestSwitchY = -Infinity;
  let hasSwitch = false;
  for (let i = 0; i < n; i++) {
    if (!nodes[i].isHost) {
      hasSwitch = true;
      if (ys[i] > lowestSwitchY) lowestSwitchY = ys[i];
    }
  }
  if (hasSwitch) {
    const bandY = lowestSwitchY + minSepY;
    const hostIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (nodes[i].isHost && !fixed[i]) {
        ys[i] = bandY;
        hostIdx.push(i);
      }
    }
    hostIdx.sort((a, b) => xs[a] - xs[b]);
    for (let k = 1; k < hostIdx.length; k++) {
      const prev = hostIdx[k - 1];
      const cur = hostIdx[k];
      if (xs[cur] - xs[prev] < minSepX) xs[cur] = xs[prev] + minSepX;
    }
  }

  for (let i = 0; i < n; i++) out.set(nodes[i].name, { cx: xs[i], cy: ys[i] });
  return out;
}
