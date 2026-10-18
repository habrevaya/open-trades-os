import { useState } from "react";
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  arrivalWindow, checkGallons, clockWords, dateOf, haulClock, mobilisationPunch, statusLabel, todayIn, addressOf,
  type DayHaul, type DayTruck, type DayVisit,
} from "@opentradesos/field-client";
import { useField } from "../state/FieldProvider";
import { syncLine } from "../lib/status";
import { pushLine } from "../lib/push";
import { locationLine } from "../lib/location";
import { dayHeading } from "../lib/format";
import { Button, Card, Field, Notice } from "../components/ui";
import { color, space, type } from "../components/theme";
import type { Navigate } from "../shell/App";

/**
 * THE DAY
 *
 * The visits in route order, today and then tomorrow, each with who, what,
 * where and when on the card itself, because those are the questions asked
 * of this list from the driver's seat. Drawn entirely from what is on the
 * phone, so it opens in a basement.
 */
export function DayScreen({ nav }: { nav: Navigate }) {
  const field = useField();
  const view = field.view;
  const zone = field.session?.timezone ?? "UTC";
  const today = todayIn(zone);
  const visits = view?.day.visits ?? [];
  const todays = visits.filter((v) => (dateOf(v.windowStart, zone) ?? today) <= today);
  const later = visits.filter((v) => (dateOf(v.windowStart, zone) ?? today) > today);
  const done = todays.filter((v) => v.stage === "completed").length;

  const line = syncLine({
    waiting: view?.waiting ?? 0,
    uploadsWaiting: view?.uploadsWaiting ?? 0,
    problems: view?.problems.length ?? 0,
    syncing: field.syncing,
    offline: field.report?.offline ?? false,
    signedOut: field.signInEnded,
    backoffUntil: view?.backoffUntil ?? null,
    lastSyncedAt: view?.lastSyncedAt ?? null,
  }, zone);

  const signOut = () => {
    const waiting = (view?.waiting ?? 0) + (view?.uploadsWaiting ?? 0);
    Alert.alert(
      "Sign out?",
      waiting > 0
        ? `${waiting} ${waiting === 1 ? "thing has" : "things have"} not reached the office yet. They stay on this phone and are sent when you sign in again.`
        : "You will need your email and password to sign back in.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Sign out", style: "destructive", onPress: () => void field.signOut() },
      ],
    );
  };

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={field.syncing} onRefresh={() => void field.sync()} />}
    >
      <View style={styles.header}>
        <Text style={type.title}>{dayHeading(today)}</Text>
        <Text style={type.soft}>{done} of {todays.length} done</Text>
      </View>
      <Text style={type.soft}>{field.session?.name ?? field.session?.email} at {field.session?.organizationName}</Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${line.text}. Open what is waiting to send.`}
        onPress={() => nav.push({ name: "outbox" })}
        style={[styles.pill, line.tone === "ok" ? styles.pillOk : line.tone === "waiting" ? styles.pillWaiting : styles.pillProblem]}
      >
        <Text style={[styles.pillText, { color: line.tone === "ok" ? color.green : line.tone === "waiting" ? color.amber : color.red }]}>
          {line.text}
        </Text>
      </Pressable>

      {field.signInEnded ? (
        <Notice tone="red">
          <Text style={[type.body, { color: color.red }]}>
            Your sign in has ended. Your work is safe on this phone.
          </Text>
          <View style={{ marginTop: space.sm }}>
            <Button label="Sign in again" onPress={() => nav.push({ name: "sign-in-again" })} />
          </View>
        </Notice>
      ) : null}

      {pushLine(field.push) ? <Notice tone="amber">{pushLine(field.push)!}</Notice> : null}

      <LocationIndicator />

      {(view?.problems.length ?? 0) > 0 ? (
        <Pressable onPress={() => nav.push({ name: "outbox" })} accessibilityRole="button">
          <Notice tone="amber">{view!.problems[0]!.detail}</Notice>
        </Pressable>
      ) : null}

      <TimeClock stops={todays} />

      <TalksToSign nav={nav} />

      {(view?.day.trucks ?? []).filter((t) => t.days.includes(today)).map((t) => <TruckWater key={t.assetId} truck={t} today={today} />)}

      {(view?.day.hauls ?? []).map((h) => (
        <Haul key={h.visitId} haul={h} zone={zone} stop={visits.find((v) => v.id === h.visitId) ?? null} />
      ))}

      <OnSiteTools nav={nav} />

      {view === null ? null : visits.length === 0 ? (
        <Text style={[type.soft, styles.empty]}>
          {view.lastSyncedAt ? "Nothing on today." : "Your day has not reached this phone yet. Pull down to try again."}
        </Text>
      ) : (
        <>
          {todays.map((v, i) => <VisitRow key={v.id} visit={v} index={i + 1} zone={zone} onOpen={() => nav.push({ name: "visit", visitId: v.id })} />)}
          {later.length > 0 ? <Text style={[type.label, styles.later]}>Tomorrow</Text> : null}
          {later.map((v, i) => <VisitRow key={v.id} visit={v} index={i + 1} zone={zone} onOpen={() => nav.push({ name: "visit", visitId: v.id })} />)}
        </>
      )}

      <View style={styles.footer}>
        <Button label="Your phone and address" kind="secondary" onPress={() => nav.push({ name: "details" })} />
        <Button label="Sign out" kind="secondary" onPress={signOut} />
      </View>
    </ScrollView>
  );
}

/**
 * Toolbox talks waiting for this person's signature, at the top of the day,
 * because a sheet nobody signs is a talk nobody can show was held.
 */
function TalksToSign({ nav }: { nav: Navigate }) {
  const field = useField();
  const waiting = (field.view?.day.talks ?? []).filter((t) => !t.signedAt && !t.signedHere && !t.cannotSign);
  if (waiting.length === 0) return null;
  return (
    <View style={styles.tools}>
      <View style={{ flex: 1 }}>
        <Button label={waiting.length === 1 ? "A toolbox talk to sign" : `${waiting.length} toolbox talks to sign`}
                onPress={() => nav.push({ name: "talks" })} />
      </View>
    </View>
  );
}

/**
 * The office's queue and the assistant, from the day: the tasks waiting for
 * this person or for anybody, and a question that is not about one visit.
 * Each shown only when the server says this person may use it.
 */
function OnSiteTools({ nav }: { nav: Navigate }) {
  const field = useField();
  const abilities = field.view?.abilities;
  const open = (field.view?.day.tasks ?? []).filter((t) => !t.done);
  const refused = (field.view?.day.expenses ?? []).filter((e) => e.status === "refused").length;
  if (!abilities?.tasks && !abilities?.assistant && !abilities?.expenses) return null;
  return (
    <View style={styles.tools}>
      {abilities.expenses ? (
        <View style={{ flex: 1 }}>
          <Button label={refused > 0 ? `Money I spent (${refused} not approved)` : "Money I spent"} kind="secondary"
                  onPress={() => nav.push({ name: "expenses" })} />
        </View>
      ) : null}
      {abilities.tasks ? (
        <View style={{ flex: 1 }}>
          <Button label={open.length > 0 ? `Tasks (${open.length})` : "Tasks"} kind="secondary" onPress={() => nav.push({ name: "tasks" })} />
        </View>
      ) : null}
      {abilities.assistant ? (
        <View style={{ flex: 1 }}>
          <Button label="Ask" kind="secondary" onPress={() => nav.push({ name: "assistant", visitId: null })} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * THE FRESH WATER THE TRUCK USED TODAY, read off the tank or the fill meter
 * at the end of the day. Shown for a truck checked out to this person today,
 * with what is already recorded; saving again replaces it. Sent when there is
 * a signal, like everything else.
 */
function TruckWater({ truck, today }: { truck: DayTruck; today: string }) {
  const field = useField();
  const recorded = truck.water.find((w) => w.onDay === today) ?? null;
  const [gallons, setGallons] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const checked = checkGallons(gallons);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    await field.record("truck.water", truck.assetId, { field: today, onDay: today, gallons: checked.gallons });
    setGallons("");
  };
  return (
    <Card>
      <Text style={type.heading}>{truck.label}: fresh water today</Text>
      <Text style={type.soft}>
        {recorded
          ? `${Number(recorded.gallons)} gallons recorded${recorded.waiting ? ", waiting to send" : ""}.`
          : "Not recorded yet. Read the tank gauge or the fill meter at the end of the day."}
      </Text>
      <Field label="Gallons used today" value={gallons} onChangeText={setGallons} keyboardType="decimal-pad" placeholder="410" />
      {problem ? <Notice tone="red">{problem}</Notice> : null}
      <View style={{ marginTop: space.sm }}>
        <Button label={recorded ? "Save a new reading" : "Save the reading"} onPress={() => void save()} />
      </View>
    </Card>
  );
}

/**
 * WHEN A CAN WAS PUT DOWN, AND WHEN A FULL ONE WAS EMPTIED, on a container
 * stop. "Now" when it happens, or the time typed if it was earlier today. Not
 * when the can was loaded and not when the truck crossed the scale: the
 * turnaround between pickup and redelivery is the hours from one to the
 * other. Sent when there is a signal, like everything else.
 */
const LEG: Record<DayHaul["leg"], string> = { delivery: "Drop off", pickup: "Collection", swap: "Swap" };

function Haul({ haul, zone, stop }: { haul: DayHaul; zone: string; stop: DayVisit | null }) {
  return (
    <Card>
      <Text style={type.heading}>{LEG[haul.leg]}: {stop ? stop.customer.name : "a stop"}</Text>
      {stop ? <Text style={type.soft}>{addressOf(stop)}</Text> : null}
      {haul.drop ? (
        <HaulMoment label={`Container ${haul.drop.container} dropped`} zone={zone}
                    recorded={haul.drop.timeKnown ? haul.drop.deliveredAt : null} waiting={haul.drop.waiting}
                    rentalId={haul.drop.rentalId} visitId={haul.visitId} moment="placed" />
      ) : null}
      {haul.tip ? (
        <HaulMoment label={`Container ${haul.tip.container} emptied at the facility`} zone={zone}
                    recorded={haul.tip.tippedAt} waiting={haul.tip.waiting}
                    rentalId={haul.tip.rentalId} visitId={haul.visitId} moment="tipped" />
      ) : null}
    </Card>
  );
}

function HaulMoment({ label, zone, recorded, waiting, rentalId, visitId, moment }: {
  label: string; zone: string; recorded: string | null; waiting: boolean;
  rentalId: string; visitId: string; moment: "placed" | "tipped";
}) {
  const field = useField();
  const [typed, setTyped] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const checked = haulClock(typed);
    if (!checked.ok) { setProblem(checked.problem); return; }
    setProblem(null);
    await field.record("haul.time", rentalId, { field: moment, at: checked.at.toISOString(), visitId });
    setTyped("");
  };
  return (
    <View style={{ marginTop: space.sm }}>
      <Text style={type.body}>
        {label}:{" "}
        {recorded
          ? `${new Date(recorded).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })}${waiting ? ", waiting to send" : ""}`
          : "not recorded yet"}
      </Text>
      <Field label="Time, if not now" value={typed} onChangeText={setTyped} placeholder="14:30" />
      {problem ? <Notice tone="red">{problem}</Notice> : null}
      <View style={{ marginTop: space.sm }}>
        <Button label={typed.trim() ? "Save this time" : "Now"} onPress={() => void save()} />
      </View>
    </View>
  );
}

/**
 * Whether this phone is sharing where its person is, said every time it is,
 * in words, at the top of the day. Off the clock it says it is not.
 */
function LocationIndicator() {
  const field = useField();
  const line = locationLine(field.view?.location, field.locationPermission);
  if (!line) return null;
  if (line.tone === "off") return <Text style={[type.soft, styles.location]}>{line.text}</Text>;
  return <Notice tone={line.tone === "on" ? "green" : "amber"}>{line.text}</Notice>;
}

/**
 * The clock, and clocking in to get a job ready: loading, driving out to the
 * first site and unloading, before the work starts. That time is paid exactly
 * as on site time, as it always was; saying which stop it was for keeps it out
 * of the crew's hours on site when the company measures production per hour.
 */
function TimeClock({ stops }: { stops: DayVisit[] }) {
  const field = useField();
  const clock = field.view?.day.clock;
  const kind = field.view?.day.clockKind ?? null;
  const [readying, setReadying] = useState(false);
  const zone = field.session?.timezone ?? "UTC";
  const open = clock?.open ?? false;
  const since = clock?.since
    ? new Date(clock.since).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })
    : null;
  return (
    <Card>
      <View style={styles.clock}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading}>{open ? clockWords(kind?.kind) : "Not clocked in"}</Text>
          {since ? <Text style={type.soft}>Since {since}{clock?.waiting ? ", waiting to send" : ""}</Text> : null}
        </View>
        <Button
          label={open ? "Clock out" : "Clock in"}
          kind={open ? "secondary" : "primary"}
          onPress={() => void field.record(open ? "timeclock.punch_out" : "timeclock.punch_in")}
        />
      </View>
      {!open && stops.length > 0 ? (
        readying ? (
          <View style={{ marginTop: space.md }}>
            <Text style={type.body}>Loading, driving out and unloading. Which job is it for?</Text>
            {stops.map((stop) => (
              <Pressable key={stop.id} accessibilityRole="button" accessibilityLabel={`Clock in to get ${stop.customer.name} ready`}
                         onPress={() => {
                           const punch = mobilisationPunch(stop.id);
                           setReadying(false);
                           void field.record(punch.kind, punch.subjectId, punch.payload);
                         }}
                         style={styles.readyRow}>
                <Text style={type.body}>{stop.customer.name}</Text>
                <Text style={type.soft}>{stop.summary}</Text>
              </Pressable>
            ))}
            <Pressable accessibilityRole="button" onPress={() => setReadying(false)} style={styles.readyRow}>
              <Text style={type.soft}>Not now</Text>
            </Pressable>
          </View>
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setReadying(true)} style={styles.readyRow}>
            <Text style={type.soft}>Getting a job ready first? Clock in for it</Text>
          </Pressable>
        )
      ) : null}
    </Card>
  );
}

function VisitRow({ visit, index, zone, onOpen }: { visit: DayVisit; index: number; zone: string; onOpen: () => void }) {
  const window = arrivalWindow(visit.windowStart, visit.windowEnd, zone);
  const finished = visit.stage === "completed" || visit.stage === "closed";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Stop ${index}, ${visit.customer.name}, ${visit.summary}, ${statusLabel(visit.status, visit.stage)}`}
      onPress={onOpen}
      style={({ pressed }) => [styles.row, finished && styles.rowDone, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.badge}><Text style={styles.badgeText}>{index}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={type.heading}>{visit.customer.name}</Text>
        <Text style={type.body}>{visit.summary}</Text>
        <Text style={type.soft}>{addressOf(visit)}</Text>
        {window ? <Text style={[type.body, styles.window]}>{window}</Text> : null}
      </View>
      <View style={styles.rowStatus}>
        <Text style={type.soft}>{statusLabel(visit.status, visit.stage)}</Text>
        {visit.waiting > 0 ? <Text style={styles.waiting}>Waiting to send</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.page },
  content: { padding: space.lg, paddingBottom: space.xl * 2 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  pill: { alignSelf: "flex-start", borderRadius: 999, paddingHorizontal: space.md, paddingVertical: space.sm, marginVertical: space.md, minHeight: 36, justifyContent: "center" },
  pillOk: { backgroundColor: color.greenTint },
  pillWaiting: { backgroundColor: color.amberTint },
  pillProblem: { backgroundColor: color.redTint },
  pillText: { fontSize: 15, fontWeight: "600" },
  clock: { flexDirection: "row", alignItems: "center", gap: space.md },
  readyRow: { minHeight: 48, justifyContent: "center", borderTopWidth: 1, borderTopColor: color.line, marginTop: space.sm },
  empty: { textAlign: "center", marginTop: space.xl * 2 },
  later: { marginTop: space.lg, marginBottom: space.sm },
  row: {
    flexDirection: "row", gap: space.md, backgroundColor: color.canvas, borderRadius: 10,
    borderWidth: 1, borderColor: color.line, padding: space.lg, marginBottom: space.md,
  },
  rowDone: { backgroundColor: "#eceef1" },
  badge: { width: 30, height: 30, borderRadius: 15, backgroundColor: color.ink, alignItems: "center", justifyContent: "center" },
  badgeText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  window: { marginTop: space.xs, fontWeight: "600" },
  rowStatus: { alignItems: "flex-end", maxWidth: 110 },
  waiting: { color: color.amber, fontSize: 13, marginTop: space.xs, textAlign: "right" },
  footer: { marginTop: space.xl },
  location: { marginBottom: space.sm },
  tools: { flexDirection: "row", gap: space.sm, marginBottom: space.md },
});
