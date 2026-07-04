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
        const pa = podId[a] >= 0 ? (podOrder.get(podId[a]) as number) : (bary.get(a) as number);
        const pb = podId[b] >= 0 ? (podOrder.get(podId[b]) as number) : (bary.get(b) as number);
        return pa - pb || (bary.get(a) as number) - (bary.get(b) as number) ||
          (nodes[a].name < nodes[b].name ? -1 : 1);
      });
      lvl.forEach((i, pos) => (order[i] = pos));
    }
    refreshPodOrder();
  }

  // ── 4. Coordinates — spaced by order, then barycentre-straightened + min-gap ──
  const x = new Array<number>(n).fill(0);
  for (const lvl of levels) {
    const sorted = [...lvl].sort((a, b) => order[a] - order[b]);
    sorted.forEach((i, pos) => (x[i] = pos * colGap));
    const mean = sorted.reduce((sm, i) => sm + x[i], 0) / (sorted.length || 1);
    for (const i of sorted) x[i] -= mean; // centre each rank on 0
  }
  for (let pass = 0; pass < 6; pass++) {
    const downward = pass % 2 === 0;
    const dseq = downward ? range(1, maxDepth) : range(maxDepth - 1, 0);
    for (const d of dseq) {
      if (d < 0 || d > maxDepth) continue;
      const refDepth = downward ? d - 1 : d + 1;
      const sorted = [...levels[d]].sort((a, b) => order[a] - order[b]);
      for (const i of sorted) {
        let s = 0;
        let c = 0;
        for (const v of nbr[i]) if (depth[v] === refDepth) { s += x[v]; c++; }
        if (c) x[i] = s / c; // pull toward the mean x of the reference-tier neighbours
      }
      // Restore order + minimum gap (left-to-right), then re-centre the rank.
      for (let k = 1; k < sorted.length; k++) {
        const a = sorted[k - 1];
        const b = sorted[k];
        if (x[b] - x[a] < colGap) x[b] = x[a] + colGap;
      }
      const mean = sorted.reduce((sm, i) => sm + x[i], 0) / (sorted.length || 1);
      for (const i of sorted) x[i] -= mean;
    }
  }

  for (let i = 0; i < n; i++) {
    out.set(nodes[i].name, { cx: x[i], cy: (maxDepth - depth[i]) * layerH });
  }
  return out;
}
