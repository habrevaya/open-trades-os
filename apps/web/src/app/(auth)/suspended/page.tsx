import { signOut } from "../actions";

/**
 * WHAT A SUSPENDED COMPANY'S PEOPLE SEE
 *
 * Every page that needs a signed in user sends them here when their company
 * is suspended, instead of to the login page. Sending them to sign in would
 * let them, and then refuse them again, and the loop reads as a broken login
 * rather than as what it is.
 *
 * It says nothing about why. The reason is the operator's record, written for
 * the operator, and "card declined" on a technician's phone is not the way
 * the owner should find out.
 */
export default function SuspendedPage() {
  return (
    <>
      <h1 className="text-xl font-semibold">This account is suspended</h1>
      <p className="mt-3 text-sm text-ink-700">
        Nothing has been deleted. Your company&apos;s records are exactly as they were and
        will be there when the account is restored. The owner of the account can find out
        why from whoever provides the service.
      </p>
      <form action={signOut} className="mt-6">
        <button type="submit" className="text-sm text-blue-600 hover:underline">
          Sign out
        </button>
      </form>
    </>
  );
}
