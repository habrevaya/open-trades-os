import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

/**
 * The shapes this screen draws, written out rather than imported from the
 * service, so a case the service cannot produce today can still be rendered in a
 * test: an app with no credential, one whose only credential has lapsed, a
 * revoked one that is still in the list because what it did stays attributable.
 */
export interface TokenRow {
  id: string;
  label: string | null;
  hint: string | null;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expired: boolean;
}

export interface AppRow {
  id: string;
  name: string;
  publisher: string | null;
  description: string | null;
  homepageUrl: string | null;
  status: string;
  permissions: string[];
  scopes: Record<string, string>;
  approvedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  tokens: TokenRow[];
  live: boolean;
}

/**
 * WHAT CAN ACTUALLY CALL US, SAID IN WORDS
 *
 * Three states and not two, because the one in the middle is the one that
 * misleads. An app is CONNECTED when it is active and holds a credential that is
 * neither revoked nor lapsed. It is approved and NOT connected when it is active
 * with no usable credential, which is what an app reads as on the morning its
 * last token expired: a screen showing the status alone calls that connected, and
 * somebody's nightly sync has already stopped.
 */
export function standing(app: AppRow): { label: string; tone: "success" | "warning" | "neutral"; why: string | null } {
  if (app.status === "revoked") {
    return {
      label: "Revoked",
      tone: "neutral",
      why: app.revokedReason ?? "Turned off. A reinstall is a new approval.",
    };
  }
  if (app.live) return { label: "Connected", tone: "success", why: null };
  if (app.tokens.length === 0) {
    return { label: "No credential", tone: "warning", why: "Approved, and nothing can call us as it yet." };
  }
  const anyLapsed = app.tokens.some((token) => token.revokedAt === null && token.expired);
  return {
    label: "Not connected",
    tone: "warning",
    why: anyLapsed
      ? "Every credential has expired, so anything calling us as this app is being refused."
      : "Every credential has been revoked.",
  };
}

export function Apps({
  apps, control, tokenControl,
}: {
  apps: AppRow[];
  control?: (app: AppRow) => ReactNode;
  tokenControl?: (app: AppRow, token: TokenRow) => ReactNode;
}) {
  if (apps.length === 0) {
    return (
      <Empty title="No applications">
        An application is a third party acting against this company with a grant you approved. It
        cannot be given anything you do not hold yourself, and revoking one takes effect on its next
        call rather than at the end of anything.
      </Empty>
    );
  }

  return (
    <div className="mt-6 space-y-6">
      {apps.map((app) => {
        const state = standing(app);
        return (
          <section key={app.id} className="rounded-md border border-steel-200 bg-canvas p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="flex flex-wrap items-center gap-2 font-medium text-ink-900">
                  {app.name}
                  <Chip tone={state.tone}>{state.label}</Chip>
                </h3>
                <p className="mt-0.5 text-sm text-ink-500">
                  {app.publisher ?? "No publisher named"}
                  {app.approvedAt ? ` · Approved ${app.approvedAt.slice(0, 10)}` : ""}
                </p>
                {state.why ? <p className="mt-1 text-sm text-ink-700">{state.why}</p> : null}
              </div>
              {control ? <div className="flex flex-wrap items-center gap-2">{control(app)}</div> : null}
            </div>

            <h4 className="mt-4 text-sm font-medium text-ink-700">What it may do</h4>
            {/*
              The grant in full rather than a count. "Twelve permissions" is a
              number somebody nods at; the list is the thing they can object to,
              and this screen exists so that objection is possible.
            */}
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {app.permissions.map((permission) => (
                <li key={permission} className="rounded bg-steel-100 px-1.5 py-0.5 font-mono text-xs text-ink-700">
                  {permission}
                </li>
              ))}
            </ul>
            <Scopes scopes={app.scopes} />

            <h4 className="mt-4 text-sm font-medium text-ink-700">Credentials</h4>
            <Tokens app={app} tokenControl={tokenControl} />
          </section>
        );
      })}
    </div>
  );
}

/**
 * Which records it reaches, and the sentence about the ones nobody named.
 *
 * An unnamed scoped resource resolves to `own`, and `own` for an app matches
 * nothing at all, so a list comes back empty and the integrator has no way to
 * tell that from "there are no customers". Worth saying before somebody spends an
 * afternoon on it.
 */
function Scopes({ scopes }: { scopes: Record<string, string> }) {
  const named = Object.entries(scopes);
  if (named.length === 0) {
    return (
      <p className="mt-1.5 text-sm text-ink-500">
        No record scope named, so every scoped list reaches nothing. An app is not a technician:
        the default narrowest scope matches no rows rather than its own.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-sm text-ink-700">
      {named.map(([resource, scope]) => `${resource}: ${scope}`).join(", ")}
    </p>
  );
}

function Tokens({
  app, tokenControl,
}: { app: AppRow; tokenControl?: (app: AppRow, token: TokenRow) => ReactNode }) {
  if (app.tokens.length === 0) {
    return (
      <p className="mt-1.5 text-sm text-ink-500">
        None issued. Nothing can call us as this app until one is.
      </p>
    );
  }
  return (
    <Table
      label={`Credentials for ${app.name}`}
      head={
        <>
          <Th>Label</Th>
          <Th>Ends</Th>
          <Th>Expires</Th>
          <Th>Last used</Th>
          <Th>State</Th>
          {tokenControl ? <Th /> : null}
        </>
      }
    >
      {app.tokens.map((token) => (
        <tr key={token.id}>
          <Td>{token.label ?? <span className="text-ink-500">No label</span>}</Td>
          {/*
            The last four characters, which is what an operator rotating two
            credentials matches against the one in their own config. Not enough
            to use, which is the whole reason it is the only part stored.
          */}
          <Td><span className="font-mono text-xs">{token.hint ?? "unknown"}</span></Td>
          <Td>{token.expiresAt.slice(0, 10)}</Td>
          <Td>
            {token.lastUsedAt
              ? token.lastUsedAt.slice(0, 10)
              : <span className="text-ink-500">Never</span>}
          </Td>
          <Td>{tokenState(token)}</Td>
          {tokenControl ? <Td>{tokenControl(app, token)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

function tokenState(token: TokenRow): ReactNode {
  if (token.revokedAt !== null) return <Chip tone="neutral">Revoked</Chip>;
  if (token.expired) return <Chip tone="danger">Expired</Chip>;
  return <Chip tone="success">Usable</Chip>;
}
