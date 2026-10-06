import { LoginForm } from "./LoginForm";
import { MyDayCache } from "@/components/MyDayCache";
import { safeNext } from "@/lib/safe-next";

/**
 * Signing in, and going back to where you were.
 *
 * `requireUser` sends a signed out visitor here with `next` naming the screen
 * they asked for, and signing in used to drop it and land everybody on the
 * dashboard. For most screens that is an annoyance. For the two pages a third
 * party sends somebody to (an app's install request, and an MCP client's
 * authorization page) it broke the flow outright: the person signed in and
 * never saw what they had been sent to decide.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  /** Signing out and an ended session both land here, so the day kept on this phone for no signal goes too. */
  return (
    <>
      <MyDayCache person={null} />
      <LoginForm next={safeNext(next)} />
    </>
  );
}
