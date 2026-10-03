import { describe, it, expect } from "vitest";
import type { z } from "zod";
/*
  The two files rather than the package index, because the index also
  carries the browser's storage, which needs the DOM types this package
  does not load.
*/
import type {
  FieldSnapshot, SignInResult, RegisterResult, OwedUpload, StoreUploadResult, ArrivalNoticeResult,
} from "@opentradesos/field-client/wire";
import type { SyncResponse, Transport } from "@opentradesos/field-client/queue";
import {
  getFieldSnapshot, signInDevice, registerDevice, listPendingUploads, storeUpload,
  sendArrivalNotice, syncOperations,
} from "../src/contracts";

/**
 * THE PHONE'S IDEA OF THE WIRE, HELD TO THE CONTRACT
 *
 * The field client writes out the shapes it reads by hand, because a phone
 * bundle cannot carry the contracts. Hand written shapes drift, so each one
 * is assigned from the contract's own output type here, and this file is in
 * the API package's typecheck. A field the server stops sending, or starts
 * sending as null, fails `pnpm typecheck` in this package rather than
 * showing a blank on a technician's screen.
 *
 * The assertions below are the compile-time ones written so a reader can see
 * them run; the real check is that this file compiles.
 */

type Out<R extends { output: z.ZodTypeAny }> = z.infer<R["output"]>;
type In<R extends { input: z.ZodTypeAny }> = z.input<R["input"]>;

const accepts = <T>(_value: T): true => true;

describe("the field client's wire types", () => {
  it("read what the server sends", () => {
    const snapshot = {} as Out<typeof getFieldSnapshot>;
    const signIn = {} as Out<typeof signInDevice>;
    const registered = {} as Out<typeof registerDevice>;
    const owed = {} as Out<typeof listPendingUploads>["uploads"][number];
    const stored = {} as Out<typeof storeUpload>;
    const notice = {} as Out<typeof sendArrivalNotice>;
    const synced = {} as Out<typeof syncOperations>;

    expect(accepts<FieldSnapshot>(snapshot)).toBe(true);
    expect(accepts<SignInResult>(signIn)).toBe(true);
    expect(accepts<RegisterResult>(registered)).toBe(true);
    expect(accepts<OwedUpload>(owed)).toBe(true);
    expect(accepts<StoreUploadResult>(stored)).toBe(true);
    expect(accepts<ArrivalNoticeResult>(notice)).toBe(true);
    expect(accepts<SyncResponse>(synced)).toBe(true);
  });

  it("send what the server accepts", () => {
    const batch = {} as Parameters<Transport["send"]>[0];
    // The queue's operations carry their kind as core's union and their
    // optional fields as possibly undefined, both of which the contract takes.
    expect(accepts<In<typeof syncOperations>>(batch)).toBe(true);
  });
});
