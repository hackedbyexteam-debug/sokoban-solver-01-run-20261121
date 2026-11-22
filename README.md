# Sokoban solver

A push-optimal Sokoban solver, written for the make.fun bounty
**“Build the best Sokoban solver, 21 November 2026”**
(`sokoban-solver-01-run-20261121`, $100).

One program answers a set of 5 Sokoban levels. Each level is XSB
(`#` wall, ` ` floor, `.` goal, `$` box, `*` box on a goal, `@`
player), one row a line, and the program writes the player's moves
that push every box onto a goal, in as few pushes as it can.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` (`i001`–`i005`) and writes
`/output/<id>/solution.txt` (LURD letters; an upper-case letter marks
a push, though the checker only reads the direction), creating the
output directories itself. The directories can be overridden:

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+ (the file is plain JavaScript in a `.ts` file, so no build
step, no dependencies, nothing to install). One run answers the whole
set in about a second on the practice set and well inside the 60 s
limit; the output is deterministic — two runs write identical bytes.

## How it works

The drawn levels are a hallway with independent rooms off it (3–4
boxes each). A box pushed out of its room can never reach a goal
again, so each room is a problem of its own, and the level's push
optimum is the sum of its rooms' optima. The solver exploits that:

1. **Room split.** The hallway row is cut where a box can never
   reach a goal (dead squares, found by pulling boxes backwards from
   the goals), and the floor that is left is flood-filled into rooms.
   Rooms already solved count their boxes as standing on their goals;
   rooms not yet solved count them where the level put them — so the
   player can always walk out of a finished room and into the next.
2. **Push A\* per room.** The search runs over *pushes*, not steps: a
   state is the sorted box squares plus the player's reachable region
   (named by its lowest square), so walking never branches the search.
   The heuristic is the minimum-assignment sum of shortest-path
   distances from boxes to goals — each box needs at least its path
   length in pushes, so the assignment sum lower-bounds the pushes
   still needed and is admissible, which makes A\* push-optimal.
3. **Deadlock pruning.** Dead squares, frozen boxes (greatest
   fixed-point freeze deadlock: a box that can never move again) and
   2×2 blocks of walls and boxes prune states no solution can pass
   through.
4. **Transposition table.** The cheapest cost found for every state
   is kept, so no state is expanded twice at a higher cost.
5. **Fallbacks.** If A\* ever runs out of its expansion budget on a
   room, the search retries with an inflated heuristic (weighted A\*),
   then greedy best-first, then plain breadth-first over pushes — all
   under deterministic expansion budgets, so the program always
   finishes with a valid answer whenever one exists in budget. A
   level that does not split into rooms is searched the same way as
   one whole level.

All budgets are counts of expansions, and every tie breaks in a fixed
direction order, so the output never depends on the clock or on
randomness. (A wall-clock guard at 48 s only stops work that would
otherwise overrun the harness's 60 s limit.)

## Results

Scored with the bounty kit's own sealed checker/scorer
(`node cli/makefun.mjs grade-local --kit <kit> --bot <this repo>
--driver process`):

| set | score | pushes vs optimum |
| --- | --- | --- |
| practice set (published in the kit) | **1,000,000 / 1,000,000** | 13/13, 16/16, 29/29, 47/47, 60/60 — every instance push-optimal |
| 6 freshly drawn sets (seeds alpha, beta, gamma, delta, epsilon, zeta, via the kit's published generator) | **1,000,000 / 1,000,000 each** | every instance push-optimal |

For comparison, the house baseline (`plain-astar 1.0.0`, shipped in
the kit) scores 200,000 on the practice set — it solves only the
first instance — in 12.3 s. This solver scores 1,000,000 in ~0.6 s.

Edge cases verified by replaying the solutions: an already-solved
level (empty answer), a 1-box and a 2-box level (both optimal), and an
unsolvable level (empty answer, no crash, no hang). A level that does
not split into rooms falls back to a whole-level search and likewise
finishes cleanly.

## Files

- `main.ts` — the whole solver (single file, no dependencies)
- `package.json` — marks the tree as an ES module
- `LICENSE` — MIT
