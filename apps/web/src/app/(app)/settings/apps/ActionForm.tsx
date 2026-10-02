"use client";

import { ActionForm, TextField } from "@/components/ActionForm";
import { OpForm } from "@/components/OpForm";
import { act } from "./actions";

export function InstallApp({
  permissions, resources, scopes,
}: {
  permissions: { value: string; label: string; sensitive: boolean }[];
  resources: string[];
  scopes: string[];
}) {
  return (
    <ActionForm action={act} submit="Install and approve" hidden={{ op: "install" }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Name" name="name" required placeholder="Neighbrium" />
        <TextField label="Publisher" name="publisher" placeholder="Who makes it" />
      </div>

      <label className="block">
        <span className="text-sm font-medium text-ink-700">What it may do</span>
        <span className="mt-0.5 block text-sm text-ink-500">
          You cannot give an app anything you do not hold yourself. The ones that expose money are
          marked.
        </span>
        {/*
          A multiple select over the whole catalogue rather than a search box.
          It is long and it is honest: the grant is the decision this screen
          exists for, and a box that only shows what you have already thought to
          type is a box that hides the permission you did not mean to include.
        */}
        <select
          name="permissions"
          multiple
          required
          size={12}
          aria-label="What it may do"
          className="mt-1.5 w-full rounded border border-steel-300 bg-canvas px-2 py-1.5 font-mono text-xs"
        >
          {permissions.map((permission) => (
            <option key={permission.value} value={permission.value}>
              {permission.sensitive ? "! " : ""}
              {permission.value}: {permission.label}
            </option>
          ))}
        </select>
      </label>

      <fieldset>
        <legend className="text-sm font-medium text-ink-700">Which records it reaches</legend>
        <p className="mt-0.5 text-sm text-ink-500">
          Leave one unset and it reaches nothing, which is not the same as everything: an app is not
          a technician, so the narrowest default matches no rows rather than its own.
        </p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {resources.map((resource) => (
            <label key={resource} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-xs text-ink-700">{resource}</span>
              <select
                name={`scope.${resource}`}
                defaultValue=""
                aria-label={`Scope for ${resource}`}
                className="h-8 rounded border border-steel-300 bg-canvas px-2 text-sm"
              >
                <option value="">Not set</option>
                {scopes.map((scope) => <option key={scope} value={scope}>{scope}</option>)}
              </select>
            </label>
          ))}
        </div>
      </fieldset>
    </ActionForm>
  );
}

export function IssueToken({ appId, name }: { appId: string; name: string }) {
  return (
    <ActionForm
      action={act}
      submit="Issue a credential"
      hidden={{ op: "issue", appId }}
      className="mt-3 space-y-3"
      tone="quiet"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-sm">
          <span className="block text-ink-700">Label</span>
          <input name="label" placeholder="nightly sync"
                 aria-label={`Label for a new credential for ${name}`}
                 className="mt-1 h-9 w-48 rounded border border-steel-300 px-2 text-sm" />
        </label>
        <label className="text-sm">
          <span className="block text-ink-700">Days</span>
          <input name="expiresInDays" inputMode="numeric" placeholder="90"
                 aria-label={`Days a new credential for ${name} lasts`}
                 className="mt-1 h-9 w-24 rounded border border-steel-300 px-2 text-sm" />
        </label>
      </div>
    </ActionForm>
  );
}

export function RevokeToken({ tokenId, label }: { tokenId: string; label: string }) {
  return (
    <OpForm
      action={act}
      op="revoke-token"
      label="Revoke"
      quiet
      hidden={{ tokenId }}
      className="inline-flex"
    >
      <input type="hidden" name="tokenLabel" value={label} />
    </OpForm>
  );
}

export function RevokeApp({ id, name }: { id: string; name: string }) {
  return (
    <OpForm action={act} op="revoke" label="Turn off" quiet hidden={{ id }}>
      <input name="reason" placeholder="Why"
             aria-label={`Why ${name} is being turned off`}
             className="h-8 w-40 rounded border border-steel-300 px-2 text-sm" />
    </OpForm>
  );
}
