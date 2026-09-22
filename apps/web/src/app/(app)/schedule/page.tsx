import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { todayIn } from "@/lib/dates";
import { dispatch } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Board } from "./Board";

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
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;

  // The company's today, not the server's. See lib/dates.ts.
  const today = todayIn(user.organizationTimezone);
  const date = params.date ?? today;

  const board = await dispatch.board(
    { actor: user.actor, db: getDb() },
    { date },
  );

  return (
    <Board
      board={board}
      date={date}
      canDispatch={can(user.actor, "visit:dispatch")}
      canReorder={can(user.actor, "visit:reschedule")}
      today={today}
      timezone={user.organizationTimezone}
    />
  );
}
