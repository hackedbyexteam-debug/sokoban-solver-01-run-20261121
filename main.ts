// sokoban-solver: a push-optimal Sokoban solver for make.fun's
// sokoban-solver-01-run-20261121 bounty.
//
// One program answers a set of 5 Sokoban levels (XSB in
// /input/<id>/level.txt) by writing the player's moves to
// /output/<id>/solution.txt (LURD letters; upper case marks a push,
// though the checker only cares about the direction).
//
// How it works
// -----------
// The levels this bounty draws are a hallway with independent rooms
// off it (3-4 boxes each). A box can never leave its room and still
// reach a goal, so each room is solved on its own and the moves are
// joined with the walks between rooms; the level's push optimum is
// the sum of its rooms' optima, and solving every room optimally
// solves the level optimally.
//
// Per room the search is A* over *pushes* (not steps):
//   - a state is the sorted box squares plus the player's reachable
//     region (named by its lowest square), so walking never branches
//     the search;
//   - the heuristic is the minimum-assignment (Hungarian, by brute
//     force over the <= 4! permutations) sum of shortest-path
//     distances from boxes to goals, which lower-bounds the pushes
//     still needed and is therefore admissible, so A* is push-optimal;
//   - dead squares (a box that can never be pulled onto a goal),
//     frozen boxes (greatest-fixed-point freeze deadlock) and 2x2
//     blocks prune states no solution can pass through;
//   - a transposition table keeps the cheapest cost found for every
//     state, so no state is ever expanded twice at a higher cost.
// If A* ever runs out of its expansion budget on a room, the search
// retries with an inflated heuristic (weighted A*), then greedy
// best-first, then plain breadth-first over pushes, all under
// deterministic expansion budgets, so the program always finishes
// with a valid answer whenever one exists in budget. If a level does
// not split into rooms, the same search runs on the whole level.
//
// Everything is deterministic: fixed direction order, fixed
// tie-breaking, fixed expansion budgets, no randomness and no clock
// in any decision that shapes the output (a wall-clock guard only
// stops work that would otherwise overrun the 60 s limit).
//
// Usage: node main.ts  (reads MAKEFUN_INPUT_DIR, default /input;
// writes MAKEFUN_OUTPUT_DIR, default /output)

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: up, down, left, right. The order is the tie-break
// order everywhere (walks, push generation, reconstruction).
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const STEP = ['u', 'd', 'l', 'r']; // a walking step
const PUSH = ['U', 'D', 'L', 'R']; // a step that pushes a box

// Deterministic budgets. A room of this bounty is solved by the
// reference push-BFS inside 250k states; A* with the assignment
// heuristic explores far fewer, and the fallbacks cover the rest.
const BUDGET_ASTAR = 250_000;
const BUDGET_WEIGHTED = 250_000;
const BUDGET_GREEDY = 250_000;
const BUDGET_BFS = 500_000;
const BUDGET_TOTAL = 3_000_000; // expansions over the whole run
const CLOCK_GUARD_MS = 48_000; // emergency stop, never normally hit

const STARTED_AT = Date.now();
let expansionsUsed = 0;

/* ------------------------------------------------------------------ */
/* Level parsing                                                       */
/* ------------------------------------------------------------------ */

function parseLevel(text) {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // The outermost frame is wall whatever it shows: nothing leaves
  // the board, and it keeps neighbour arithmetic in bounds.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  boxes.sort((a, b) => a - b);
  goals.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

/* ------------------------------------------------------------------ */
/* Dead squares: a box standing here can never reach a goal.           */
/* Computed by pulling boxes backwards from the goals: a square is    */
/* live when a box on it can be pulled one step towards a goal, i.e.   */
/* the square behind the pull is open floor too.                       */
/* ------------------------------------------------------------------ */

function liveSquares(w, h, wall, goals) {
  const live = new Uint8Array(w * h);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (let k = 0; k < 4; k++) {
      const d = DY[k] * w + DX[k];
      const y = x - d; // the square the box is pulled from
      if (y < 0 || y >= w * h) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/* ------------------------------------------------------------------ */
/* Room split: cut the player's row where a box can never reach a      */
/* goal (the hallway), and flood-fill what is left. Each part holding  */
/* boxes is a room; a box that starts in the hallway, a goal left in   */
/* no part, or a part whose boxes and goals do not match means the     */
/* level is not a set of rooms.                                        */
/* ------------------------------------------------------------------ */

function roomsOf(level) {
  const { w, h, wall, goals, boxes, player } = level;
  const live = liveSquares(w, h, wall, goals);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(w * h);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(w * h).fill(-1);
  const rooms = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i];
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/* ------------------------------------------------------------------ */
/* Shortest walk between two squares around walls and boxes, as       */
/* LURD letters. BFS in the fixed direction order, so ties break the   */
/* same way on every run.                                              */
/* ------------------------------------------------------------------ */

function walkTo(w, h, wall, occupied, from, to) {
  if (from === to) return '';
  const prev = new Int32Array(w * h).fill(-1);
  const how = new Array(w * h);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const q = p + DY[k] * w + DX[k];
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = STEP[k];
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/* ------------------------------------------------------------------ */
/* The push search over one board.                                     */
/*                                                                     */
/* wall: Uint8Array, 1 is a wall (other rooms' boxes are walls here).  */
/* goals, boxes: sorted square lists. player: starting square.         */
/*                                                                     */
/* search(weight, maxExpansions) runs A* with f = g + weight * h,     */
/* weight 1 being optimal A*, weight 0 breadth-first, a huge weight    */
/* greedy best-first. Returns { pushes, moves } or null.               */
/* ------------------------------------------------------------------ */

function makeSearcher(w, h, wall, goals, boxes0, player0) {
  const size = w * h;
  const n = boxes0.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(w, h, wall, goals);

  // Shortest-path distances from every goal over open floor, for the
  // assignment heuristic. A box needs at least its path length in
  // pushes to reach a goal, so the assignment sum lower-bounds the
  // pushes still needed.
  const goalDist = goals.map((g) => {
    const dist = new Int32Array(size).fill(-1);
    const queue = [g];
    dist[g] = 0;
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && dist[q] < 0) {
          dist[q] = dist[p] + 1;
          queue.push(q);
        }
      }
    }
    return dist;
  });

  // The heuristic: minimum total distance of an assignment of boxes
  // to distinct goals (brute force over permutations, n <= 6 here;
  // a plain sum of nearest-goal distances for larger n).
  const heuristic = (boxes) => {
    if (n === 0) return 0;
    if (n <= 6) {
      let best = Infinity;
      const rec = (i, used, sum) => {
        if (sum >= best) return;
        if (i === n) {
          best = sum;
          return;
        }
        for (let j = 0; j < n; j++) {
          if (used & (1 << j)) continue;
          const d = goalDist[j][boxes[i]];
          if (d < 0) continue; // this box cannot reach this goal
          rec(i + 1, used | (1 << j), sum + d);
        }
      };
      // n <= 4 in practice: at most 24 leaves.
      rec(0, 0, 0);
      return best;
    }
    let sum = 0;
    for (const b of boxes) {
      let m = Infinity;
      for (let j = 0; j < n; j++) {
        const d = goalDist[j][b];
        if (d >= 0 && d < m) m = d;
      }
      if (m === Infinity) return Infinity;
      sum += m;
    }
    return sum;
  };

  // Flood fill of the player's region with `occupied` in the way.
  // `seen`/`stamp` mark the region transiently; the cells found are
  // also recorded in `regCells` so the caller can snapshot the
  // region into `regionSeen` (successor regions computed later must
  // not disturb the current state's membership test).
  const seen = new Int32Array(size);
  const stack = new Int32Array(size);
  const regCells = new Int32Array(size);
  const regionSeen = new Int32Array(size);
  let regionStamp = 0;
  let stamp = 0;
  let regionCount = 0;
  const regionLow = (occupied, from) => {
    stamp++;
    let low = from;
    let sp = 0;
    regionCount = 0;
    stack[sp++] = from;
    seen[from] = stamp;
    while (sp > 0) {
      const p = stack[--sp];
      regCells[regionCount++] = p;
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = p + DY[k] * w + DX[k];
        if (!wall[q] && !occupied[q] && seen[q] !== stamp) {
          seen[q] = stamp;
          stack[sp++] = q;
        }
      }
    }
    return low;
  };
  // Snapshot the region just computed by regionLow into regionSeen.
  const snapshotRegion = () => {
    regionStamp++;
    for (let i = 0; i < regionCount; i++) regionSeen[regCells[i]] = regionStamp;
  };
  const inRegion = (cell) => regionSeen[cell] === regionStamp;

  // Whether some off-goal box is frozen: it can never move again.
  // Greatest fixed point: start with every box frozen, then unfreeze
  // any box that has a push whose destination and standing square are
  // both free of walls and of still-frozen boxes, until stable. A box
  // in the final set can never be the first frozen box to move (every
  // push it could make needs a wall or a frozen box gone first), so
  // by induction no frozen box ever moves.
  const frozenDead = (boxes, occupied) => {
    const frozen = new Uint8Array(n).fill(1);
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < n; i++) {
        if (!frozen[i]) continue;
        const b = boxes[i];
        for (let k = 0; k < 4; k++) {
          const d = DY[k] * w + DX[k];
          const dest = b + d;
          const behind = b - d;
          const destBlocked = wall[dest] || (occupied[dest] && frozen[boxes.indexOf(dest)]);
          const behindBlocked = wall[behind] || (occupied[behind] && frozen[boxes.indexOf(behind)]);
          if (!destBlocked && !behindBlocked) {
            frozen[i] = 0;
            changed = true;
            break;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (frozen[i] && !goalSet[boxes[i]]) return true;
    }
    return false;
  };

  // A 2x2 block of walls and boxes holding a box off its goal can
  // never come apart: the boxes inside it cannot be pushed out.
  const blockDead = (boxes, occupied, t) => {
    const tx = t % w;
    const ty = Math.floor(t / w);
    for (let dy = -1; dy <= 0; dy++) {
      for (let dx = -1; dx <= 0; dx++) {
        const ax = tx + dx;
        const ay = ty + dy;
        if (ax < 0 || ay < 0 || ax + 1 >= w || ay + 1 >= h) continue;
        const a = ay * w + ax;
        const cells = [a, a + 1, a + w, a + w + 1];
        let full = true;
        let bad = false;
        for (const c of cells) {
          if (!wall[c] && !occupied[c]) {
            full = false;
            break;
          }
          if (occupied[c] && !goalSet[c]) bad = true;
        }
        if (full && bad) return true;
      }
    }
    return false;
  };

  // State keys: boxes (sorted) plus the region's lowest square, as
  // one number while it stays exact (rooms are small); a string for
  // big whole-level searches.
  const numericKeys = Math.pow(size, n + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes, low) => {
    if (numericKeys) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return low + '|' + boxes.join(',');
  };

  const solved = (boxes) => {
    for (const b of boxes) if (!goalSet[b]) return false;
    return true;
  };

  function search(weight, maxExpansions) {
    if (boxes0.some((b) => !live[b])) return null;
    if (solved(boxes0)) return { pushes: 0, moves: '' };

    // Stored states, in discovery order. Flat typed arrays keep the
    // search allocation-free once warm.
    let cap = 4096;
    let sBoxes = new Int32Array(cap * Math.max(n, 1));
    let sPlayer = new Int32Array(cap);
    let sParent = new Int32Array(cap);
    let sFrom = new Int32Array(cap);
    let sTo = new Int32Array(cap);
    let sG = new Int32Array(cap);
    let sH = new Float64Array(cap);
    let count = 0;
    const grow = () => {
      const ncap = cap * 2;
      const nb = new Int32Array(ncap * Math.max(n, 1));
      nb.set(sBoxes);
      sBoxes = nb;
      const np = new Int32Array(ncap);
      np.set(sPlayer);
      sPlayer = np;
      const npa = new Int32Array(ncap);
      npa.set(sParent);
      sParent = npa;
      const nf = new Int32Array(ncap);
      nf.set(sFrom);
      sFrom = nf;
      const nt = new Int32Array(ncap);
      nt.set(sTo);
      sTo = nt;
      const ng = new Int32Array(ncap);
      ng.set(sG);
      sG = ng;
      const nh = new Float64Array(ncap);
      nh.set(sH);
      sH = nh;
      cap = ncap;
    };

    const best = new Map(); // state key -> cheapest g seen
    // Binary heap of state indices, ordered by (f, h, discovery).
    const heap = [];
    const heapLess = (a, b) => {
      const fa = sG[a] + weight * sH[a];
      const fb = sG[b] + weight * sH[b];
      if (fa !== fb) return fa < fb;
      if (sH[a] !== sH[b]) return sH[a] < sH[b];
      return a < b; // discovery order: fully deterministic
    };
    const heapPush = (s) => {
      let i = heap.length;
      heap.push(s);
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!heapLess(heap[i], heap[p])) break;
        const t = heap[i];
        heap[i] = heap[p];
        heap[p] = t;
        i = p;
      }
    };
    const heapPop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length > 0) {
        heap[0] = last;
        for (let i = 0; ; ) {
          let c = 2 * i + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && heapLess(heap[c + 1], heap[c])) c++;
          if (!heapLess(heap[c], heap[i])) break;
          const t = heap[i];
          heap[i] = heap[c];
          heap[c] = t;
          i = c;
        }
      }
      return top;
    };

    const addState = (boxes, player, parent, from, to, g, h) => {
      if (count === cap) grow();
      const s = count++;
      for (let i = 0; i < n; i++) sBoxes[s * n + i] = boxes[i];
      sPlayer[s] = player;
      sParent[s] = parent;
      sFrom[s] = from;
      sTo[s] = to;
      sG[s] = g;
      sH[s] = h;
      return s;
    };
    const stateBoxes = (s) => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = sBoxes[s * n + i];
      return out;
    };

    const occupied = new Uint8Array(size);
    for (const b of boxes0) occupied[b] = 1;
    const low0 = regionLow(occupied, player0);
    const h0 = heuristic(boxes0);
    if (h0 === Infinity) return null;
    const root = addState(boxes0, player0, -1, -1, -1, 0, h0);
    best.set(keyOf(boxes0, low0), 0);
    heapPush(root);

    let expanded = 0;
    let found = -1;
    while (heap.length > 0) {
      if (expanded >= maxExpansions || expansionsUsed >= BUDGET_TOTAL) return null;
      if (Date.now() - STARTED_AT > CLOCK_GUARD_MS) return null;
      const s = heapPop();
      const g = sG[s];
      const boxes = stateBoxes(s);
      for (const b of boxes) occupied[b] = 1;
      const low = regionLow(occupied, sPlayer[s]);
      for (const b of boxes) occupied[b] = 0;
      // Stale heap entry (a cheaper route to this state was found).
      if (best.get(keyOf(boxes, low)) !== g) continue;
      if (solved(boxes)) {
        found = s;
        break;
      }
      expanded++;
      expansionsUsed++;
      for (const b of boxes) occupied[b] = 1;
      regionLow(occupied, sPlayer[s]);
      snapshotRegion(); // successors compute their own regions next
      for (let bi = 0; bi < n; bi++) {
        const b = boxes[bi];
        for (let k = 0; k < 4; k++) {
          const d = DY[k] * w + DX[k];
          const behind = b - d;
          const dest = b + d;
          if (!inRegion(behind)) continue; // player cannot get behind
          if (wall[dest] || occupied[dest]) continue;
          if (!live[dest]) continue; // dead square
          const next = boxes.slice();
          next[bi] = dest;
          next.sort((a, b2) => a - b2);
          occupied[b] = 0;
          occupied[dest] = 1;
          let dead = false;
          if (blockDead(next, occupied, dest)) dead = true;
          else if (frozenDead(next, occupied)) dead = true;
          if (!dead) {
            const hNext = heuristic(next);
            if (hNext === Infinity) dead = true;
            else {
              const lowNext = regionLow(occupied, b); // player ends on b
              const key = keyOf(next, lowNext);
              const prevG = best.get(key);
              if (prevG === undefined || g + 1 < prevG) {
                best.set(key, g + 1);
                const ns = addState(next, b, s, b, dest, g + 1, hNext);
                heapPush(ns);
              }
            }
          }
          occupied[dest] = 0;
          occupied[b] = 1;
        }
      }
      for (const b of boxes) occupied[b] = 0;
    }
    if (found < 0) return null;

    // Rebuild the moves: walk to each push, then push.
    const chain = [];
    for (let s = found; s > 0; s = sParent[s]) chain.push(s);
    chain.reverse();
    let moves = '';
    let player = player0;
    let boxes = boxes0.slice();
    for (const s of chain) {
      const from = sFrom[s];
      const to = sTo[s];
      const d = to - from;
      const k = d === -w ? 0 : d === w ? 1 : d === -1 ? 2 : 3;
      for (const b of boxes) occupied[b] = 1;
      moves += walkTo(w, h, wall, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      moves += PUSH[k];
      player = from;
      const at = boxes.indexOf(from);
      boxes[at] = to;
      boxes.sort((a, b) => a - b);
    }
    return { pushes: chain.length, moves };
  }

  return { search };
}

/* ------------------------------------------------------------------ */
/* Solve one level: room by room when it splits, whole-level else.     */
/* ------------------------------------------------------------------ */

function solveLevel(text) {
  const level = parseLevel(text);
  if (level.player < 0 || level.boxes.length === 0) return '';
  const rooms = roomsOf(level);
  if (rooms !== null && rooms.length > 0) {
    let player = level.player;
    let moves = '';
    for (const room of rooms) {
      // The other rooms' boxes are walls for this room: a room
      // already solved has its boxes on its goals, a room not yet
      // solved has them where the level put them.
      const wall = level.wall.slice();
      for (const other of rooms) {
        if (other === room) continue;
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
      }
      const searcher = makeSearcher(
        level.w, level.h, wall,
        room.goals.slice().sort((a, b) => a - b),
        room.boxes.slice().sort((a, b) => a - b),
        player,
      );
      const solved =
        searcher.search(1, BUDGET_ASTAR) ??
        searcher.search(3, BUDGET_WEIGHTED) ??
        searcher.search(1000, BUDGET_GREEDY) ??
        searcher.search(0, BUDGET_BFS);
      if (solved === null) return '';
      moves += solved.moves;
      player = endOf(level.w, player, solved.moves);
      room.done = true;
      if (Date.now() - STARTED_AT > CLOCK_GUARD_MS) return '';
    }
    return moves;
  }
  // No room split: search the whole level the same way.
  const searcher = makeSearcher(level.w, level.h, level.wall, level.goals, level.boxes, level.player);
  const solved =
    searcher.search(1, BUDGET_ASTAR) ??
    searcher.search(3, BUDGET_WEIGHTED) ??
    searcher.search(1000, BUDGET_GREEDY) ??
    searcher.search(0, BUDGET_BFS);
  return solved === null ? '' : solved.moves;
}

// The square the player stands on after `moves` from `from`.
function endOf(w, from, moves) {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* Entry point: every instance under the input dir, in order.          */
/* ------------------------------------------------------------------ */

function main() {
  for (const id of readdirSync(INPUT_DIR).sort()) {
    let moves = '';
    try {
      moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
    } catch {
      moves = ''; // never let one bad instance stop the others
    }
    mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
  }
}

// Run only when executed directly (`node main.ts`), not when imported.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
