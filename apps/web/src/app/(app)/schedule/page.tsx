import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatch, dispatchMap } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { tileSource } from "@/lib/map-tiles";
import { Board, type BoardView } from "./Board";

export const dynamic = "force-dynamic";

/**
 * THE BOARD
 *
 * The screen a dispatcher lives in. Not a calendar: a calendar answers "when
 * is this", and a dispatcher is asking "who has room" and "what is late",
 * which are questions about a whole day at once.
 *
 * Rendered on the server from a single query. A board that assembles itself
 * from one request per technician is a board that flickers into place every
 * time somebody changes a date, and a dispatcher changes the date constantly.
 */
export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; view?: string }>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;

  // The company's today, not the server's. See lib/dates.ts.
  const today = todayIn(user.organizationTimezone);
  const date = params.date ?? today;

  /**
   * The map beside the board, or instead of it. Read only when it is shown:
   * a dispatcher who never opens the map does not pay for a second query.
   */
  const view: BoardView = params.view === "map" || params.view === "split" ? params.view : "board";
  const ctx = { actor: user.actor, db: getDb() };

  const [board, map] = await Promise.all([
    dispatch.board(ctx, { date }),
    view === "board" ? Promise.resolve(null) : dispatchMap.map(ctx, { date }),
  ]);

  return (
    <Board
      board={board}
      date={date}
      view={view}
      map={map}
      tiles={tileSource()}
      canDispatch={can(user.actor, "visit:dispatch")}
      canReorder={can(user.actor, "visit:reschedule")}
      today={today}
      timezone={user.organizationTimezone}
    />
  );
}
