// topology-layout.ts — layered (Sugiyama-style) placement for DC fabrics.
//
// A Clos / spine-leaf fabric is inherently *tiered*, and operators read it that
// way — spines on top, leaves in the middle, hosts on a line at the bottom. So we
// draw it as a layered graph, not a force blob:
//
//   1. RANK by tier — multi-source BFS hop-distance from the hosts. Hosts are the
//      bottom line (rank 0); a switch's rank is its hops to the nearest host, so
//      leaves land one tier up, spines above them, super-spines above those.
//      (No hosts? seed BFS from the highest-degree node so switch-only meshes still
//      layer sensibly.)
//   2. GROUP into pods — the connected components left after removing the top tier.
//      A pod's leaves + hosts stay contiguous within their ranks, so crossings stay
//      local to a pod instead of smearing across the whole diagram.
//   3. MINIMISE CROSSINGS — order nodes within each rank by the iterated barycentre
//      heuristic (down/up sweeps), constrained to keep pods together.
//   4. ASSIGN COORDINATES — x by barycentre alignment with an enforced minimum gap
//      (straight uplinks, no overlap); y = rank line (hosts on one bottom line).
//
// Pure + deterministic (no RNG, fixed sweep count) so the same graph always lays
// out identically. Operator-dragged (pinned) positions are applied by the renderer
// as overrides on top of this auto layout, so this module stays a pure function of
// the graph.

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
  // Accepted for signature stability; ignored here (pins are renderer overrides).
  pinned?: Map<string, { cx: number; cy: number }>;
}
export interface LayoutPoint {
  cx: number;
  cy: number;
}

// Inclusive integer range, ascending or descending.
function range(from: number, to: number): number[] {
  const out: number[] = [];
  if (from <= to) for (let i = from; i <= to; i++) out.push(i);
  else for (let i = from; i >= to; i--) out.push(i);
  return out;
}

export function computeTopologyLayout(
  nodes: LayoutNodeInput[],
  edges: LayoutEdge[],
  opts: LayoutOptions,
): Map<string, LayoutPoint> {
  const out = new Map<string, LayoutPoint>();
  const n = nodes.length;
  if (n === 0) return out;

  const colGap = opts.nodeW + opts.hGap; // min centre-to-centre x within a rank
  const layerH = opts.nodeH + opts.vGap; // rank-to-rank y

  const idx = new Map<string, number>();
  nodes.forEach((nd, i) => idx.set(nd.name, i));
  const adj: Set<number>[] = nodes.map(() => new Set<number>());
  for (const e of edges) {
    const a = idx.get(e.a);
    const z = idx.get(e.z);
    if (a === undefined || z === undefined || a === z) continue;
    adj[a].add(z);
    adj[z].add(a);
  }
  const nbr = adj.map((s) => [...s]);
  const degree = nbr.map((a) => a.length);

  // ── 1. Rank by BFS hop-distance from hosts (hosts = rank 0 / bottom) ─────────
  const depth = new Array<number>(n).fill(-1);
  const bfs = (seeds: number[]): void => {
    const q = [...seeds];
    for (const s of seeds) depth[s] = 0;
    let head = 0;
    while (head < q.length) {
      const u = q[head++];
      for (const v of nbr[u]) if (depth[v] === -1) { depth[v] = depth[u] + 1; q.push(v); }
    }
  };
  const hostSeeds: number[] = [];
  for (let i = 0; i < n; i++) if (nodes[i].isHost) hostSeeds.push(i);
  if (hostSeeds.length) bfs(hostSeeds);
  // Cover any component the host-BFS didn't reach (incl. host-less graphs): seed
  // each remaining component from its highest-degree node.
  for (;;) {
    let seed = -1;
    let best = -1;
    for (let i = 0; i < n; i++) if (depth[i] === -1 && degree[i] > best) { best = degree[i]; seed = i; }
    if (seed === -1) break;
    bfs([seed]);
  }
  const maxDepth = Math.max(...depth);

  // ── 2. Pods — components after removing the top (max-depth) tier ─────────────
  // Pods interconnect only through the spines; drop the top tier and the graph
  // falls into one component per pod. Top-tier nodes span all pods (podId -1).
  const podId = new Array<number>(n).fill(-1);
  const isTop = (i: number): boolean => maxDepth > 0 && depth[i] === maxDepth;
  {
    const seen = new Array<boolean>(n).fill(false);
    let pod = 0;
    for (let i = 0; i < n; i++) {
      if (seen[i] || isTop(i)) continue;
      const q = [i];
      seen[i] = true;
      podId[i] = pod;
      let head = 0;
      while (head < q.length) {
        const u = q[head++];
        for (const v of nbr[u]) if (!seen[v] && !isTop(v)) { seen[v] = true; podId[v] = pod; q.push(v); }
      }
      pod++;
    }
  }

  // ── 3. Order within ranks — pod-contiguous barycentre crossing reduction ─────
  const levels: number[][] = [];
  for (let i = 0; i < n; i++) (levels[depth[i]] ||= []).push(i);
  for (let d = 0; d <= maxDepth; d++) levels[d] ||= [];

  const order = new Array<number>(n).fill(0);
  for (const lvl of levels) {
    lvl.sort((a, b) => (podId[a] - podId[b]) || (nodes[a].name < nodes[b].name ? -1 : 1));
    lvl.forEach((i, pos) => (order[i] = pos));
  }

  // Only MULTI-node pods constrain ordering. A singleton pod — which every host in
  // a 2-tier fabric is, since removing the switch tier isolates it — must NOT pin
  // its node's position, or the pod key freezes the initial order and defeats the
  // barycentre crossing-min (e.g. a host uplinked to switch1 stranded on the far
  // right next to switch2's hosts). Singleton-pod nodes order purely by barycentre,
  // like the top tier.
  const podSize = new Map<number, number>();
  for (let i = 0; i < n; i++) if (podId[i] >= 0) podSize.set(podId[i], (podSize.get(podId[i]) ?? 0) + 1);
  const grouped = (i: number): boolean => podId[i] >= 0 && (podSize.get(podId[i]) as number) > 1;

  const podOrder = new Map<number, number>();
  const refreshPodOrder = (): void => {
    const sum = new Map<number, number>();
    const cnt = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      const p = podId[i];
      if (p < 0) continue;
      sum.set(p, (sum.get(p) ?? 0) + order[i]);
      cnt.set(p, (cnt.get(p) ?? 0) + 1);
    }
    for (const p of sum.keys()) podOrder.set(p, (sum.get(p) as number) / (cnt.get(p) as number));
  };
  refreshPodOrder();

  const baryFrom = (i: number, refDepth: number): number | null => {
    let s = 0;
    let c = 0;
    for (const v of nbr[i]) if (depth[v] === refDepth) { s += order[v]; c++; }
    return c ? s / c : null;
  };

  const SWEEPS = 10;
  for (let sw = 0; sw < SWEEPS; sw++) {
    const downward = sw % 2 === 0;
    const dseq = downward ? range(1, maxDepth) : range(maxDepth - 1, 0);
    for (const d of dseq) {
      if (d < 0 || d > maxDepth) continue;
      const refDepth = downward ? d - 1 : d + 1;
      const lvl = levels[d];
      const bary = new Map<number, number>();
      for (const i of lvl) {
        const b = baryFrom(i, refDepth);
        bary.set(i, b === null ? order[i] : b);
      }
      lvl.sort((a, b) => {
        const pa = grouped(a) ? (podOrder.get(podId[a]) as number) : (bary.get(a) as number);
        const pb = grouped(b) ? (podOrder.get(podId[b]) as number) : (bary.get(b) as number);
        return pa - pb || (bary.get(a) as number) - (bary.get(b) as number) ||
          (nodes[a].name < nodes[b].name ? -1 : 1);
      });
      lvl.forEach((i, pos) => (order[i] = pos));
    }
    refreshPodOrder();
  }

  // ── 4. x-coordinates — minimise link length (median targets, L1-isotonic place)
  // Order within ranks is fixed (crossing-min above). Each node wants to sit at the
  // MEDIAN x of its neighbours in the adjacent tiers — the median minimises the
  // total link length (Σ|Δx|), i.e. the shortest links up to the tier above and
  // down to the tier below. Placing an ordered rank as close as possible to those
  // targets while keeping the min-gap is L1 isotonic regression, solved exactly by
  // pool-adjacent-violators (PAV). Sweep bottom-up (starting at the hosts) then
  // top-down, repeatedly, so the alignment propagates through every tier — one pass
  // isn't enough because moving a tier changes its neighbours' targets.
  const median = (arr: number[]): number => {
    const s = [...arr].sort((a, b) => a - b);
    const m = s.length >> 1;
    // True median (mean of the two middles when even) — still an L1 minimiser, and
    // it centres symmetric cases (a leaf under N spines sits mid-block, not hugging
    // one side) instead of picking a lopsided endpoint.
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  // L1 isotonic regression: the non-decreasing y[] minimising Σ|y − d|, via PAV.
  const isotonicL1 = (d: number[]): number[] => {
    const blocks: number[][] = [];
    const meds: number[] = [];
    for (const di of d) {
      let members = [di];
      let med = di;
      while (meds.length && meds[meds.length - 1] > med) {
        members = (blocks.pop() as number[]).concat(members);
        meds.pop();
        med = median(members);
      }
      blocks.push(members);
      meds.push(med);
    }
    const y: number[] = [];
    for (let b = 0; b < blocks.length; b++) for (let k = 0; k < blocks[b].length; k++) y.push(meds[b]);
    return y;
  };
  const x = new Array<number>(n).fill(0);
  for (const lvl of levels) {
    const sorted = [...lvl].sort((a, b) => order[a] - order[b]);
    sorted.forEach((i, pos) => (x[i] = pos * colGap));
  }
  const PASSES = 16;
  for (let pass = 0; pass < PASSES; pass++) {
    const seq = pass % 2 === 0 ? range(0, maxDepth) : range(maxDepth, 0); // bottom-up first (hosts)
    for (const d of seq) {
      const lvl = [...levels[d]].sort((a, b) => order[a] - order[b]);
      if (lvl.length === 0) continue;
      const target = lvl.map((i) => {
        const xs: number[] = [];
        for (const v of nbr[i]) if (depth[v] === d - 1 || depth[v] === d + 1) xs.push(x[v]);
        return xs.length ? median(xs) : x[i];
      });
      // Solve for the min-gap-respecting placement closest to the targets.
      const y = isotonicL1(target.map((t, k) => t - k * colGap));
      lvl.forEach((i, k) => (x[i] = y[k] + k * colGap));
    }
  }

  for (let i = 0; i < n; i++) {
    out.set(nodes[i].name, { cx: x[i], cy: (maxDepth - depth[i]) * layerH });
  }
  return out;
}
